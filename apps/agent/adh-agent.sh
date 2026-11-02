#!/usr/bin/env sh
# 需要 Node 22+ 与 adb 在 PATH 中
exec node "$(dirname "$0")/bin/adh-agent.mjs" "$@"