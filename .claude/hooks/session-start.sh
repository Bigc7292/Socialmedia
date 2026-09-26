#!/bin/bash
set -euo pipefail

# Only needed in Claude Code on the web containers.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Match the Bun version pinned by `packageManager` in package.json.
BUN_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  npm install -g "bun@${BUN_VERSION}"
  hash -r
fi

bun install
