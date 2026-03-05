#!/bin/sh
set -eu

# Preferred flag name: AI_CLI_AUTO_INSTALL (legacy fallback: CODEX_AUTO_INSTALL)
auto_install="${AI_CLI_AUTO_INSTALL:-${CODEX_AUTO_INSTALL:-true}}"

if [ "$auto_install" = "true" ]; then
  echo "[entrypoint] Installing latest AI CLIs (Codex + Claude Code)..."
  if npm i -g @openai/codex@latest @anthropic-ai/claude-code@latest; then
    echo "[entrypoint] AI CLI install finished (user scope)."
  else
    echo "[entrypoint] User-scope install failed."
    if command -v sudo >/dev/null 2>&1; then
      echo "[entrypoint] Retrying install with sudo/global scope..."
      if sudo npm i -g @openai/codex@latest @anthropic-ai/claude-code@latest; then
        echo "[entrypoint] AI CLI install finished (sudo/global scope)."
      else
        echo "[entrypoint] WARNING: AI CLI install failed after sudo retry. Continuing startup."
      fi
    else
      echo "[entrypoint] WARNING: sudo not found, skipping retry. Continuing startup."
    fi
  fi
else
  echo "[entrypoint] Skipping CLI auto-install (AI_CLI_AUTO_INSTALL=${auto_install})"
fi

exec "$@"
