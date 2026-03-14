#!/bin/sh
set -eu

# Ensure required data directories exist (critical for container persistence)
echo "[entrypoint] Ensuring data directories exist..."
mkdir -p /data/canvas-agent
mkdir -p /data/pi-oauth-states
mkdir -p /data/secrets
mkdir -p /data/skills
mkdir -p /data/workspace
echo "[entrypoint] Data directories ready."

# Copy skills from repo to /data/skills if the directory is empty
# This ensures skills are available even when /data is a fresh volume
echo "[entrypoint] Checking skills directory..."
if [ -d "/app/skills" ]; then
  if [ -z "$(ls -A /data/skills 2>/dev/null)" ]; then
    echo "[entrypoint] Copying skills from /app/skills to /data/skills..."
    cp -r /app/skills/* /data/skills/
    echo "[entrypoint] Skills copied successfully."
  else
    echo "[entrypoint] Skills directory already populated, skipping copy."
  fi
else
  echo "[entrypoint] WARNING: /app/skills not found, cannot copy skills."
fi

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

prepare_writable_dir() {
  target_dir="$1"
  owner="$(id -un):$(id -gn)"

  if mkdir -p "$target_dir" 2>/dev/null && [ -w "$target_dir" ]; then
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    echo "[entrypoint] Fixing permissions for ${target_dir}..."
    if sudo mkdir -p "$target_dir" && sudo chown -R "$owner" "$target_dir"; then
      return 0
    fi
  fi

  echo "[entrypoint] WARNING: Could not prepare writable directory ${target_dir}."
  return 1
}

if [ -n "${OLLAMA_MODELS:-}" ]; then
  prepare_writable_dir "${OLLAMA_MODELS}" || true
fi

if [ "$auto_install" = "true" ]; then
  install_ai_cli_if_missing() {
    command_name="$1"
    package_name="$2"
    display_name="$3"

    if command -v "$command_name" >/dev/null 2>&1; then
      echo "[entrypoint] ${display_name} already available: $($command_name --version 2>/dev/null || echo 'unknown version')."
      return 0
    fi

    echo "[entrypoint] Installing ${display_name}..."
    if npm i -g "$package_name"; then
      echo "[entrypoint] ${display_name} install finished (user scope)."
      return 0
    fi

    echo "[entrypoint] ${display_name} user-scope install failed."
    if command -v sudo >/dev/null 2>&1; then
      echo "[entrypoint] Retrying ${display_name} install with sudo/global scope..."
      if sudo npm i -g "$package_name"; then
        echo "[entrypoint] ${display_name} install finished (sudo/global scope)."
        return 0
      fi
      echo "[entrypoint] WARNING: ${display_name} install failed after sudo retry. Continuing startup."
      return 1
    fi

    echo "[entrypoint] WARNING: sudo not found, skipping ${display_name} retry. Continuing startup."
    return 1
  }

  install_ai_cli_if_missing codex @openai/codex@latest "Codex CLI" || true
  install_ai_cli_if_missing claude @anthropic-ai/claude-code@latest "Claude Code CLI" || true
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

# Install Bun and qmd for markdown search skill
qmd_auto_install="${QMD_AUTO_INSTALL:-true}"
if [ "$qmd_auto_install" = "true" ]; then
  # Install Bun if not present
  if [ ! -d "$HOME/.bun" ]; then
    echo "[entrypoint] Installing Bun..."
    if curl -fsSL https://bun.sh/install | bash; then
      echo "[entrypoint] Bun installed successfully."
    else
      echo "[entrypoint] WARNING: Bun installation failed. Continuing startup."
    fi
  else
    echo "[entrypoint] Bun already available."
  fi

  # Add Bun to PATH for this session
  export PATH="$HOME/.bun/bin:$PATH"

  # Install qmd if not present
  if ! command -v qmd >/dev/null 2>&1; then
    echo "[entrypoint] Installing qmd..."
    if bun install -g https://github.com/tobi/qmd; then
      echo "[entrypoint] qmd installed successfully."
    else
      echo "[entrypoint] WARNING: qmd installation failed. Continuing startup."
    fi
  else
    echo "[entrypoint] qmd already available: $(qmd --version 2>/dev/null || echo 'unknown version')."
  fi

  # Initialize workspace collection if qmd is available and collection doesn't exist
  if command -v qmd >/dev/null 2>&1 && [ ! -f "/data/workspace/.qmd/collections.json" ]; then
    echo "[entrypoint] Initializing qmd workspace collection..."
    if qmd collection add /data/workspace --name workspace --mask "**/*.md" 2>/dev/null; then
      echo "[entrypoint] qmd workspace collection created."
    else
      echo "[entrypoint] WARNING: Failed to create qmd workspace collection. Continuing startup."
    fi
  fi
else
  echo "[entrypoint] Skipping qmd auto-install (QMD_AUTO_INSTALL=${qmd_auto_install})"
fi

exec "$@"
