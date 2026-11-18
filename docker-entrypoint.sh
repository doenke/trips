#!/bin/sh
# Starts briefly as root only to make the data directory writable for the app user
# (bind mounts like /data/container/trips/data are usually created by root on the host),
# then runs the app as "node". Started with another user (compose "user:"), it just runs.
set -e
DATA="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  if [ "$(stat -c %u "$DATA")" != "1000" ] || ! su-exec node test -w "$DATA"; then
    echo "trips: Rechte für $DATA werden auf UID 1000 (node) gesetzt"
    chown -R node:node "$DATA"
  fi
  exec su-exec node "$@"
fi
exec "$@"
