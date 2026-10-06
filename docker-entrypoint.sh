#!/bin/sh
# Volumes on some hosts (Fly.io, bare docker -v /host/dir) are mounted owned by root.
# Fix ownership of the data dir, then run the hub as the unprivileged "node" user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
