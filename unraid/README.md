# Unraid Templates

- `unraid/my-PackBot-Go.xml` — the bot (`olliepck/packbot-go:latest`)
- `unraid/my-PackBot-Lavalink.xml` — the Lavalink v4 node the bot needs

## Install on Unraid

1. Copy the XMLs to the Unraid host:
   `/boot/config/plugins/dockerMan/templates-user/`
2. In the Unraid Docker tab, **Add Container** and pick the template.
3. Fill the env vars (contract: `ENVIRONMENT.md`; required: `TOKEN`,
   `CLIENT_ID`, `MYSQL_*`, plus `LAVALINK_ADDRESS`/`LAVALINK_PASSWORD` for
   music).

## Notes

- Run both containers on the same custom Docker network as MariaDB and the
  nginx reverse proxy (e.g. `laserproxy`) so container-name DNS works
  (`MYSQL_HOST=mariadb`, nginx upstream `PackBot-Go:3001`). If Lavalink sits
  on a different network, point `LAVALINK_ADDRESS` at the host IP instead.
- Lavalink's config lives at
  `/mnt/user/appdata/packbot-lavalink/application.yml` (reference copy:
  `lavalink/application.yml` — the deployed copy carries the real YouTube
  OAuth refresh token; never commit that).
- Pull+restart does NOT apply a new image on Unraid — recreate the container
  (Docker UI "apply update" or the `update_container` script).

## Icon

Templates reference
`https://raw.githubusercontent.com/OlliePCK/PackBot/master/unraid/packbot-icon.jpg`.
