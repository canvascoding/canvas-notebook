#!/bin/sh
set -eu

if [ "${CODEX_AUTO_INSTALL:-true}" = "true" ]; then
  echo "[entrypoint] Installing latest AI CLIs (Codex + Claude Code)..."
  npm i -g @openai/codex@latest @anthropic-ai/claude-code@latest
else
  echo "[entrypoint] Skipping CLI auto-install (CODEX_AUTO_INSTALL=${CODEX_AUTO_INSTALL:-false})"
fi

exec "$@"
