#!/bin/zsh
cd "$(dirname "$0")"
NODE_BIN="/Users/chimona/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ -x "$NODE_BIN" ]; then
  "$NODE_BIN" server.mjs
else
  node server.mjs
fi
