#!/bin/sh
set -e

# OpenCode remote control always runs so keys can be configured and sessions debugged from outside the container.
# Bind 0.0.0.0 inside the container; docker-compose publishes it only on host 127.0.0.1.
opencode serve --hostname 0.0.0.0 --port 4096 &

exec node server.js
