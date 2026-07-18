#!/bin/bash
# Auto-deploy PackBot-Go on the Unraid host (grid): when Docker Hub has a new
# :latest image, recreate the container — unless music is playing, in which
# case wait for a later cycle. Closes the push → CI → live loop without
# manual SSH.
#
# Install: copy to /boot/config/scripts/ and add to a
# /boot/config/plugins/dynamix/*.cron file:
#   */10 * * * * bash /boot/config/scripts/packbot-autodeploy.sh >> /var/log/packbot-ops.log 2>&1
# then run `update_cron`.
set -euo pipefail

IMAGE=olliepck/packbot-go:latest
CONTAINER=PackBot-Go
STATS_URL=https://thepck.com/api/stats

# One at a time.
exec 9>/var/lock/packbot-autodeploy.lock
flock -n 9 || exit 0

docker pull -q "$IMAGE" >/dev/null
LATEST=$(docker image inspect "$IMAGE" --format '{{.Id}}')
RUNNING=$(docker inspect "$CONTAINER" --format '{{.Image}}')
[ "$LATEST" = "$RUNNING" ] && exit 0

# Don't cut off live music; the next cycle will retry.
ACTIVE=$(curl -s -m 5 "$STATS_URL" | grep -o '"activeVoice":[0-9]*' | cut -d: -f2 || true)
if [ -n "${ACTIVE:-}" ] && [ "$ACTIVE" != "0" ]; then
    echo "$(date) new image available but $ACTIVE voice session(s) active — deferring"
    exit 0
fi

echo "$(date) deploying new image ${LATEST:7:19}…"
/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/update_container "$CONTAINER"
echo "$(date) deploy complete"
