#!/bin/sh
set -eu

# Runtime bootstrap must happen in the container because /home/node is volume-mounted
# and not available during image build.
echo "[entrypoint] Bootstrapping agent runtime in /home/node/canvas-agent..."
if npx tsx scripts/bootstrap-agent-runtime.ts; then
  echo "[entrypoint] Agent runtime bootstrap finished."
else
  echo "[entrypoint] WARNING: Agent runtime bootstrap failed. Continuing startup."
fi

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

ollama_auto_install="${OLLAMA_CLI_AUTO_INSTALL:-true}"
if [ "$ollama_auto_install" = "true" ]; then
  if command -v ollama >/dev/null 2>&1; then
    echo "[entrypoint] Ollama CLI already available: $(ollama --version 2>/dev/null || echo 'unknown version')."
  elif ! command -v curl >/dev/null 2>&1; then
    echo "[entrypoint] WARNING: curl not found, cannot install Ollama CLI automatically."
  else
    echo "[entrypoint] Installing Ollama CLI..."
    tmp_script="$(mktemp)"
    if curl -fsSL https://ollama.com/install.sh > "$tmp_script" && OLLAMA_NO_START=1 sh "$tmp_script"; then
      echo "[entrypoint] Ollama CLI install finished."
    else
      echo "[entrypoint] WARNING: Ollama CLI install failed. Continuing startup."
    fi
    rm -f "$tmp_script"
  fi
else
  echo "[entrypoint] Skipping Ollama CLI auto-install (OLLAMA_CLI_AUTO_INSTALL=${ollama_auto_install})"
fi

exec "$@"
