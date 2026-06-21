#!/bin/zsh
cd "$(dirname "$0")"
NODE_BIN="/Users/chimona/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ -x "$NODE_BIN" ]; then
  HOST=0.0.0.0 PORT=5175 "$NODE_BIN" server.mjs
else
  HOST=0.0.0.0 PORT=5175 node server.mjs
fi
