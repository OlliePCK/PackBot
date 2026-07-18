#!/bin/bash
# Nightly PackBot database backup on the Unraid host (grid).
#
# Install: copy to /boot/config/scripts/, create /boot/config/scripts/packbot.env
# with MYSQL_USER=... and MYSQL_PASSWORD=... (never commit that file), and add
# to a /boot/config/plugins/dynamix/*.cron file:
#   30 4 * * * bash /boot/config/scripts/packbot-db-backup.sh >> /var/log/packbot-ops.log 2>&1
# then run `update_cron`.
set -euo pipefail

source /boot/config/scripts/packbot.env

OUT=/mnt/user/appdata/packbot-backups
KEEP_DAYS=14
STAMP=$(date +%F)

mkdir -p "$OUT"
docker exec mariadb mariadb-dump -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" --skip-ssl \
    --single-transaction --routines packbot | gzip > "$OUT/packbot-$STAMP.sql.gz"

# Sanity: a real dump is never tiny.
SIZE=$(stat -c%s "$OUT/packbot-$STAMP.sql.gz")
if [ "$SIZE" -lt 1024 ]; then
    echo "$(date) BACKUP SUSPICIOUSLY SMALL ($SIZE bytes) — investigate"
    exit 1
fi

find "$OUT" -name 'packbot-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date) backup ok: packbot-$STAMP.sql.gz ($SIZE bytes)"
