# Unraid Template

Template file:

- `unraid/my-PackBot.xml`

## Install on Unraid

1. Copy the XML to your Unraid host:
   - `/boot/config/plugins/dockerMan/templates-user/my-PackBot.xml`
2. In Unraid Docker tab, use **Add Container** and select the `PackBot` template.
3. Default repository is `olliepck/packbot:latest`; override if needed.
4. Fill required env vars (`TOKEN`, `CLIENT_ID`, `MYSQL_*`).
5. Keep PackBot on the same Docker network as your MySQL/MariaDB container.

## Notes

- The template defaults to network `laserproxy` to match your current host setup.
- It is intentionally trimmed to match the env vars currently present in your production `packbot` container.
- It intentionally does not publish host ports; API traffic is expected through internal Docker networking (for example via nginx reverse proxy).

## Icon for Unraid

The template is already configured with:

- `https://raw.githubusercontent.com/OlliePCK/PackBot/master/unraid/packbot-icon.jpg`

If you want to replace it, update `unraid/packbot-icon.jpg` in this repo (or switch to jsDelivr):

- `https://cdn.jsdelivr.net/gh/OlliePCK/PackBot@master/unraid/packbot-icon.jpg`
