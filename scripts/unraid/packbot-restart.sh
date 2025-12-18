#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   PACKBOT_CONTAINER_NAME=packbot IMAGE=olliepck/packbot:latest ./packbot-restart.sh

PACKBOT_CONTAINER_NAME="${PACKBOT_CONTAINER_NAME:-packbot}"
IMAGE="${IMAGE:-olliepck/packbot:latest}"

echo "Pulling ${IMAGE}..."
docker pull "${IMAGE}"

echo "Restarting container ${PACKBOT_CONTAINER_NAME}..."
docker restart "${PACKBOT_CONTAINER_NAME}"

echo "Done."
