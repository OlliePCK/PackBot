const mysql = require('mysql2/promise');
const logger = require('../logger').child('database');
require('dotenv').config();

const pool = mysql.createPool({
	host: process.env.MYSQL_HOST,
	user: process.env.MYSQL_USER,
    port: process.env.MYSQL_PORT,
	password: process.env.MYSQL_PASSWORD,
	database: process.env.MYSQL_DB,
	waitForConnections: true,
	connectionLimit: 10,
	maxIdle: 10, // max idle connections, the default value is the same as `connectionLimit`
	idleTimeout: 60000, // idle connections timeout, in milliseconds, the default value 60000
	queueLimit: 0,
	enableKeepAlive: true,
	keepAliveInitialDelay: 0,
});

// Log pool errors
pool.on('error', (err) => {
	logger.error('Database pool error', { error: err.message, code: err.code });
});

logger.debug('Database pool initialized', { host: process.env.MYSQL_HOST, database: process.env.MYSQL_DB });

exports.pool = pool;