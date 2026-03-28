#!/bin/sh
set -eu

fatal_startup() {
  echo "[entrypoint] ERROR: $1"
  exit 1
}

env_flag_enabled() {
  normalized="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    1|true|yes|on)
      return 0
      ;;
    0|false|no|off|'')
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

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

# Ensure required data directories exist (critical for container persistence)
echo "[entrypoint] Ensuring data directories exist..."
export CANVAS_APP_ROOT="${CANVAS_APP_ROOT:-/app}"
mkdir -p /data/canvas-agent
mkdir -p /data/pi-oauth-states
mkdir -p /data/secrets
mkdir -p /data/skills
mkdir -p /data/workspace
mkdir -p /data/temp/skills
echo "[entrypoint] Data directories ready."

echo "[entrypoint] Preparing skills runtime..."
if node scripts/prepare-skills-runtime.js; then
  echo "[entrypoint] Skills runtime prepared."
else
  fatal_startup "Skills runtime preparation failed."
fi

# Runtime bootstrap must happen in the container because /home/node is volume-mounted
# and not available during image build.
echo "[entrypoint] Bootstrapping agent runtime in /data/canvas-agent..."
if npx tsx scripts/bootstrap-agent-runtime.ts; then
  echo "[entrypoint] Agent runtime bootstrap finished."
else
  fatal_startup "Agent runtime bootstrap failed."
fi

# Preferred flag name: AI_CLI_AUTO_INSTALL (legacy fallback: CODEX_AUTO_INSTALL)
auto_install="${AI_CLI_AUTO_INSTALL:-${CODEX_AUTO_INSTALL:-true}}"

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

# Install Bun and qmd for optional workspace search
if [ -n "${QMD_ENABLED:-}" ]; then
  if env_flag_enabled "$QMD_ENABLED"; then
    qmd_enabled=true
  else
    qmd_enabled=false
  fi
else
  if env_flag_enabled "${QMD_AUTO_INSTALL:-false}"; then
    qmd_enabled=true
  else
    qmd_enabled=false
  fi
fi

if [ "$qmd_enabled" = "true" ]; then
  export BUN_INSTALL="${BUN_INSTALL:-/data/cache/.bun}"
  export PATH="${BUN_INSTALL}/bin:$PATH"
  QMD_TEXT_COLLECTION_NAME="workspace-text"
  QMD_DERIVED_COLLECTION_NAME="workspace-derived"
  QMD_TEXT_COLLECTION_MASK='**/*.{md,mdx,txt,text,json,jsonl,csv,xml,ts,tsx,js,jsx,mjs,cjs,py,html,css,scss,sql,yaml,yml}'
  QMD_DERIVED_COLLECTION_MASK='**/*.md'
  QMD_DERIVED_DOCX_ROOT="/data/cache/qmd/derived/docx"
  QMD_RUNTIME_STATUS_PATH="/data/cache/qmd/runtime-status.json"
  QMD_DERIVED_STATUS_PATH="/data/cache/qmd/derived/status.json"
  QMD_BUILD_LOG_PATH="/data/cache/qmd/qmd-build.log"

  write_qmd_runtime_status() {
    last_update_at="${1:-null}"
    last_update_success="${2:-false}"
    last_embed_at="${3:-null}"

    mkdir -p /data/cache/qmd
    cat > "$QMD_RUNTIME_STATUS_PATH" <<EOF
{
  "qmdAvailable": true,
  "defaultMode": "search",
  "allowExpensiveQueryMode": false,
  "collections": [
    {
      "name": "${QMD_TEXT_COLLECTION_NAME}",
      "sourceType": "workspace-text",
      "path": "/data/workspace"
    },
    {
      "name": "${QMD_DERIVED_COLLECTION_NAME}",
      "sourceType": "workspace-derived",
      "path": "${QMD_DERIVED_DOCX_ROOT}"
    }
  ],
  "derivedDocxEnabled": true,
  "derivedStatusPath": "${QMD_DERIVED_STATUS_PATH}",
  "lastUpdateAt": ${last_update_at},
  "lastUpdateSuccess": ${last_update_success},
  "lastEmbedAt": ${last_embed_at}
}
EOF
  }

  ensure_qmd_collection() {
    collection_name="$1"
    collection_path="$2"
    collection_mask="$3"

    if qmd collection list 2>/dev/null | grep -q "^${collection_name} "; then
      echo "[entrypoint] qmd collection already present: ${collection_name}"
      return 0
    fi

    echo "[entrypoint] Creating qmd collection ${collection_name}..."
    qmd collection add "$collection_path" --name "$collection_name" --mask "$collection_mask" 2>/dev/null
  }

  prepare_qmd_derived_docx() {
    echo "[qmd-derived] Preparing DOCX-derived markdown artifacts..."
    mkdir -p "$QMD_DERIVED_DOCX_ROOT"
    if ! node ./scripts/qmd-prepare-derived-docx.mjs; then
      echo "[qmd-derived] WARNING: DOCX preprocessing failed. Continuing with direct text collections only."
    fi
  }

  qmd_cli_ready() {
    command -v qmd >/dev/null 2>&1 && qmd --version >/dev/null 2>&1
  }

  qmd_indexing_ready() {
    qmd_cli_ready && qmd collection list >/dev/null 2>&1
  }

  # Install Bun if not present
  if [ ! -x "${BUN_INSTALL}/bin/bun" ]; then
    echo "[entrypoint] Installing Bun..."
    if curl -fsSL https://bun.sh/install | bash; then
      echo "[entrypoint] Bun installed successfully."
    else
      fatal_startup "Bun installation failed."
    fi
  else
    echo "[entrypoint] Bun already available."
  fi

  # Install or repair qmd
  qmd_needs_install=false
  qmd_install_path="${BUN_INSTALL}/install/global/node_modules/@tobilu/qmd"
  
  if ! command -v qmd >/dev/null 2>&1; then
    echo "[entrypoint] qmd not found, needs installation."
    qmd_needs_install=true
  elif ! qmd_cli_ready; then
    echo "[entrypoint] qmd command exists but not working (missing dist/), needs rebuild."
    qmd_needs_install=true
  elif [ ! -d "$qmd_install_path/dist" ]; then
    echo "[entrypoint] qmd dist/ directory missing, needs rebuild."
    qmd_needs_install=true
  fi
  
  if [ "$qmd_needs_install" = "true" ]; then
    echo "[entrypoint] Installing qmd from npm..."
    if bun install -g @tobilu/qmd; then
      echo "[entrypoint] qmd package installed, building from source..."
      if [ -d "$qmd_install_path" ]; then
        mkdir -p /data/cache/qmd
        echo "[entrypoint] Capturing qmd build output in ${QMD_BUILD_LOG_PATH}..."
        if ! (cd "$qmd_install_path" && bun install && bun run build) >"$QMD_BUILD_LOG_PATH" 2>&1; then
          echo "[entrypoint] ERROR: qmd build failed. Last 200 log lines:"
          tail -n 200 "$QMD_BUILD_LOG_PATH" 2>/dev/null || cat "$QMD_BUILD_LOG_PATH" 2>/dev/null || true
          fatal_startup "qmd build failed. Full log: ${QMD_BUILD_LOG_PATH}"
        fi
        if qmd_cli_ready; then
          echo "[entrypoint] qmd built and working successfully."
        else
          echo "[entrypoint] ERROR: qmd CLI still not working after build. Last 200 log lines:"
          tail -n 200 "$QMD_BUILD_LOG_PATH" 2>/dev/null || cat "$QMD_BUILD_LOG_PATH" 2>/dev/null || true
          fatal_startup "qmd build finished but the CLI is still not working."
        fi
      else
        fatal_startup "qmd install path ${qmd_install_path} not found after installation."
      fi
    else
      fatal_startup "qmd installation failed."
    fi
  else
    echo "[entrypoint] qmd already available: $(qmd --version 2>/dev/null || echo 'unknown version')."
  fi

  write_qmd_runtime_status null false null

  # Initialize workspace collections if qmd is working
  if qmd_indexing_ready; then
    if qmd collection list 2>/dev/null | grep -q "^workspace "; then
      echo "[entrypoint] Removing legacy qmd workspace collection..."
      qmd collection remove workspace >/dev/null 2>&1 || true
    fi

    prepare_qmd_derived_docx

    if ! ensure_qmd_collection "$QMD_TEXT_COLLECTION_NAME" /data/workspace "$QMD_TEXT_COLLECTION_MASK"; then
      fatal_startup "Failed to create qmd workspace-text collection."
    fi
    if ! ensure_qmd_collection "$QMD_DERIVED_COLLECTION_NAME" "$QMD_DERIVED_DOCX_ROOT" "$QMD_DERIVED_COLLECTION_MASK"; then
      fatal_startup "Failed to create qmd workspace-derived collection."
    fi

    qmd context add "qmd://${QMD_TEXT_COLLECTION_NAME}" "Canvas Studios workspace text files, notes, code, and structured documents." 2>/dev/null || true
    qmd context add "qmd://${QMD_DERIVED_COLLECTION_NAME}" "Derived searchable document text extracted from workspace DOCX files. Always map results back to the original workspace document path." 2>/dev/null || true

    # Run initial update
    echo "[qmd-indexer] Running initial qmd update..."
    if ! qmd update 2>/dev/null; then
      write_qmd_runtime_status null false null
      fatal_startup "Initial qmd update failed."
    fi
    write_qmd_runtime_status "\"$(date -Iseconds)\"" true null

    # Start background indexing loops
    echo "[qmd-indexer] Starting background indexing loops..."

    # Loop 1: Update every 30 minutes
    (
      while true; do
        sleep 1800
        prepare_qmd_derived_docx
        echo "[qmd-indexer] Running qmd update at $(date)..."
        if qmd update 2>/dev/null; then
          write_qmd_runtime_status "\"$(date -Iseconds)\"" true null
        else
          write_qmd_runtime_status "\"$(date -Iseconds)\"" false null
          echo "[qmd-indexer] Update completed with warnings at $(date)."
        fi
      done
    ) &

    # Loop 2: Embed 30 minutes after start, then daily at 01:00
    (
      echo "[qmd-indexer] Waiting 30 minutes for initial embed..."
      sleep 1800

      echo "[qmd-indexer] Running initial qmd embed at $(date)..."
      qmd embed 2>/dev/null &
      write_qmd_runtime_status "\"$(date -Iseconds)\"" true "\"$(date -Iseconds)\""

      while true; do
        # Calculate minutes until 01:00
        current_hour=$(date +%-H)
        current_min=$(date +%-M)
        minutes_until_1am=$(( (24 - current_hour + 1) % 24 * 60 - current_min ))
        if [ $minutes_until_1am -le 0 ]; then
          minutes_until_1am=$((minutes_until_1am + 1440))
        fi

        echo "[qmd-indexer] Next embed at 01:00, sleeping ${minutes_until_1am} minutes..."
        sleep $((minutes_until_1am * 60))

        echo "[qmd-indexer] Running scheduled qmd embed at $(date)..."
        qmd embed 2>/dev/null &
        write_qmd_runtime_status "\"$(date -Iseconds)\"" true "\"$(date -Iseconds)\""

        # Wait until next day
        sleep 86400
      done
    ) &
  else
    fatal_startup "qmd is not working properly after setup."
  fi
else
  echo "[entrypoint] Skipping qmd setup (QMD_ENABLED=${QMD_ENABLED:-unset}, QMD_AUTO_INSTALL=${QMD_AUTO_INSTALL:-unset})"
fi

exec "$@"
