// Package database embeds the SQL migration files into the binary so the
// bot can apply them at startup — the distroless container has no filesystem
// copy of the repo (the Node-era migrate.js runner was removed with the Node
// code).
package database

import "embed"

// Migrations holds database/migrations/*.sql, applied in filename order by
// storage.(*Store).Migrate.
//
//go:embed migrations/*.sql
var Migrations embed.FS
