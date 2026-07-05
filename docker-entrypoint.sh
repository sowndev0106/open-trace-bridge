#!/bin/sh
set -e

# OpenCode remote control — LUÔN chạy để setup key/debug từ ngoài container.
# Bind 0.0.0.0 trong container; docker-compose chỉ publish ra 127.0.0.1 host.
opencode serve --hostname 0.0.0.0 --port 4096 &

exec node server.js
