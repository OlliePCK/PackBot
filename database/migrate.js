// database/migrate.js - Run database migrations
const fs = require('fs');
const path = require('path');
const db = require('./db.js');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
    console.log('🔄 Running migrations...\n');

    // Get all .sql files sorted by name
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    if (files.length === 0) {
        console.log('No migration files found.');
        process.exit(0);
    }

    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of files) {
        const filePath = path.join(MIGRATIONS_DIR, file);
        const sql = fs.readFileSync(filePath, 'utf8');

        // Split by semicolon for multiple statements, filter empty
        const statements = sql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));

        console.log(`📄 ${file}`);

        for (const statement of statements) {
            try {
                await db.pool.query(statement);
                success++;
            } catch (err) {
                if (err.code === 'ER_TABLE_EXISTS_ERROR') {
                    skipped++;
                    console.log(`   ⏭️  Table already exists, skipped`);
                } else if (err.code === 'ER_DUP_KEYNAME') {
                    skipped++;
                    console.log(`   ⏭️  Index already exists, skipped`);
                } else {
                    failed++;
                    console.error(`   ❌ Error: ${err.message}`);
                }
            }
        }
    }

    console.log('\n✅ Migration complete!');
    console.log(`   Success: ${success}, Skipped: ${skipped}, Failed: ${failed}`);

    process.exit(failed > 0 ? 1 : 0);
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
