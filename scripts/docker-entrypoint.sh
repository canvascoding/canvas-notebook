#!/bin/sh
set -eu

if [ "${CODEX_AUTO_INSTALL:-false}" = "true" ]; then
  echo "[entrypoint] AI CLI auto-install enabled (non-blocking)"
  (
    set +e
    echo "[entrypoint] Installing latest AI CLIs (Codex + Claude Code)..."
    npm i -g @openai/codex@latest @anthropic-ai/claude-code@latest
    install_status=$?
    if [ "$install_status" -ne 0 ]; then
      echo "[entrypoint] WARNING: AI CLI install failed (exit: $install_status). Continuing startup."
    else
      echo "[entrypoint] AI CLI install finished"
    fi
  ) &
else
  echo "[entrypoint] Skipping CLI auto-install (CODEX_AUTO_INSTALL=${CODEX_AUTO_INSTALL:-false})"
fi

exec "$@"
