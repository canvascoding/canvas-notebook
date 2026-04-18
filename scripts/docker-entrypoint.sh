#!/bin/sh
set -eu

# ─── Progress display helpers ──────────────────────────────────────────────
STARTUP_LOG="/data/logs/startup.log"
_step_num=0
_step_total=0
_step_label=""

if [ -t 1 ]; then _is_tty=true; else _is_tty=false; fi

_progress_bar() {
  if [ "$_step_total" -le 0 ]; then return; fi
  _pct=$(( _step_num * 100 / _step_total ))
  _filled=$(( _step_num * 20 / _step_total ))
  _bar="" _i=0
  while [ $_i -lt $_filled ]; do _bar="${_bar}█"; _i=$((_i+1)); done
  while [ $_i -lt 20 ];        do _bar="${_bar}░"; _i=$((_i+1)); done
  if [ "$_is_tty" = "true" ]; then
    printf '  [%s] %3d%%' "$_bar" "$_pct"
  else
    printf '  [%s] %3d%%\n' "$_bar" "$_pct"
  fi
}

step() {
  _step_num=$((_step_num + 1))
  _step_label="$1"
  if [ "$_is_tty" = "true" ]; then
    printf '\r\033[K  \342\206\222 [%d/%d] %s' "$_step_num" "$_step_total" "$_step_label"
  fi
}

step_ok() {
  if [ "$_is_tty" = "true" ]; then
    printf '\r\033[K  \342\234\223 [%d/%d] %s\n' "$_step_num" "$_step_total" "$_step_label"
  else
    printf '  \342\234\223 [%d/%d] %s\n' "$_step_num" "$_step_total" "$_step_label"
  fi
  _progress_bar
}

step_fail() {
  if [ "$_is_tty" = "true" ]; then
    printf '\r\033[K  \342\234\227 [%d/%d] %s \342\200\224 FAILED\n' "$_step_num" "$_step_total" "$_step_label"
  else
    printf '  \342\234\227 [%d/%d] %s \342\200\224 FAILED\n' "$_step_num" "$_step_total" "$_step_label"
  fi
  printf '\n  Full log: %s\n\n' "$STARTUP_LOG"
  tail -n 30 "$STARTUP_LOG" >&2
}
# ───────────────────────────────────────────────────────────────────────────

fatal_startup() {
  printf '\n\n  [entrypoint] ERROR: %s\n' "$1" >&2
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
    if sudo mkdir -p "$target_dir" && sudo chown -R "$owner" "$target_dir"; then
      return 0
    fi
  fi

  return 1
}

# ─── Auto-tune Node.js heap from container RAM ──────────────────────────
# Northflank injects NF_RAM_RESOURCES (in MB). Reserve 25% for OS/child processes,
# give the rest to Node's old-space heap. Only sets if NODE_OPTIONS is not already defined.
if [ -z "${NODE_OPTIONS:-}" ] && [ -n "${NF_RAM_RESOURCES:-}" ]; then
  _ram_mb="${NF_RAM_RESOURCES}"
  _heap_mb=$(( _ram_mb * 75 / 100 ))
  # Floor at 256 MB to avoid unusably small heaps
  if [ "$_heap_mb" -lt 256 ]; then _heap_mb=256; fi
  export NODE_OPTIONS="--max-old-space-size=${_heap_mb}"
  printf '[Entrypoint] Auto-tuned NODE_OPTIONS=%s (container RAM: %s MB)\n' "$NODE_OPTIONS" "$_ram_mb"
fi

# ─── Pre-compute all flags ────────────────────────────────────────────────
export CANVAS_APP_ROOT="${CANVAS_APP_ROOT:-/app}"
auto_install="${AI_CLI_AUTO_INSTALL:-${CODEX_AUTO_INSTALL:-true}}"
ollama_auto_install="${OLLAMA_CLI_AUTO_INSTALL:-true}"

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

# ─── Dynamic step count ───────────────────────────────────────────────────
_step_total=3
if [ "$auto_install" = "true" ]; then _step_total=$((_step_total+2)); fi
if [ "$ollama_auto_install" = "true" ]; then _step_total=$((_step_total+1)); fi
if [ "$qmd_enabled" = "true" ]; then _step_total=$((_step_total+3)); fi

# ─── Init log ─────────────────────────────────────────────────────────────
mkdir -p /data/logs

# Runtime logging configuration
export LOG_FILE="${LOG_FILE:-/data/logs/runtime.log}"
export LOG_TO_STDOUT="${LOG_TO_STDOUT:-true}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

: > "$STARTUP_LOG"
cat << 'BANNER'

   ██████╗ █████╗ ███╗   ██╗██╗   ██╗ █████╗ ███████╗
  ██╔════╝██╔══██╗████╗  ██║██║   ██║██╔══██╗██╔════╝
  ██║     ███████║██╔██╗ ██║██║   ██║███████║███████╗
  ██║     ██╔══██║██║╚██╗██║╚██╗ ██╔╝██╔══██║╚════██║
  ╚██████╗██║  ██║██║ ╚████║ ╚████╔╝ ██║  ██║███████║
   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝  ╚═══╝  ╚═╝  ╚═╝╚══════╝

  https://github.com/canvascoding/canvas-notebook

BANNER
printf 'Canvas initializing...\n\n'

# ─── Step 1: Data directories ─────────────────────────────────────────────
step "Preparing data directories"
{
  mkdir -p /data/canvas-agent
  mkdir -p /data/pi-oauth-states
  mkdir -p /data/secrets
  mkdir -p /data/skills
  mkdir -p /data/workspace
  mkdir -p /data/temp/skills
} >> "$STARTUP_LOG" 2>&1
step_ok

if [ -n "${OLLAMA_MODELS:-}" ]; then
  prepare_writable_dir "${OLLAMA_MODELS}" >> "$STARTUP_LOG" 2>&1 || true
fi

# ─── Step 2: Skills runtime ───────────────────────────────────────────────
step "Skills runtime"
if node scripts/prepare-skills-runtime.js >> "$STARTUP_LOG" 2>&1; then
  step_ok
else
  step_fail
  fatal_startup "Skills runtime preparation failed."
fi

# ─── Step 3: Agent runtime bootstrap ─────────────────────────────────────
step "Agent runtime bootstrap"
if npx tsx scripts/bootstrap-agent-runtime.ts >> "$STARTUP_LOG" 2>&1; then
  step_ok
else
  step_fail
  fatal_startup "Agent runtime bootstrap failed."
fi

# ─── Steps 4-5: AI CLI tools ─────────────────────────────────────────────
if [ "$auto_install" = "true" ]; then
  install_ai_cli_if_missing() {
    _cmd="$1"
    _pkg="$2"
    _lbl="$3"
    step "$_lbl"
    if command -v "$_cmd" >/dev/null 2>&1; then
      step_ok; return 0
    fi
    if npm i -g "$_pkg" >> "$STARTUP_LOG" 2>&1; then
      step_ok; return 0
    fi
    if command -v sudo >/dev/null 2>&1; then
      if sudo npm i -g "$_pkg" >> "$STARTUP_LOG" 2>&1; then
        step_ok; return 0
      fi
    fi
    # Non-fatal: show ok but log warning
    printf '[warning] %s install failed — see %s\n' "$_lbl" "$STARTUP_LOG" >> "$STARTUP_LOG" 2>&1
    step_ok
  }
  install_ai_cli_if_missing codex  @openai/codex@latest            "Codex CLI"
  install_ai_cli_if_missing claude @anthropic-ai/claude-code@latest "Claude Code CLI"
fi

# ─── Step: Ollama CLI ─────────────────────────────────────────────────────
if [ "$ollama_auto_install" = "true" ]; then
  step "Ollama CLI"
  if command -v ollama >/dev/null 2>&1; then
    step_ok
  elif ! command -v curl >/dev/null 2>&1; then
    printf '[warning] curl not found, skipping Ollama CLI install\n' >> "$STARTUP_LOG" 2>&1
    step_ok
  else
    tmp_script="$(mktemp)"
    if curl -fsSL https://ollama.com/install.sh > "$tmp_script" 2>> "$STARTUP_LOG" \
        && OLLAMA_NO_START=1 sh "$tmp_script" >> "$STARTUP_LOG" 2>&1; then
      step_ok
    else
      printf '[warning] Ollama CLI install failed — continuing startup\n' >> "$STARTUP_LOG" 2>&1
      step_ok
    fi
    rm -f "$tmp_script"
  fi
fi

# ─── QMD steps ────────────────────────────────────────────────────────────
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
      return 0
    fi

    qmd collection add "$collection_path" --name "$collection_name" --mask "$collection_mask" >> "$STARTUP_LOG" 2>&1
  }

  prepare_qmd_derived_docx() {
    mkdir -p "$QMD_DERIVED_DOCX_ROOT"
    node ./scripts/qmd-prepare-derived-docx.mjs >> "$STARTUP_LOG" 2>&1 || true
  }

  qmd_cli_ready() {
    command -v qmd >/dev/null 2>&1 && qmd --version >/dev/null 2>&1
  }

  qmd_indexing_ready() {
    qmd_cli_ready && qmd collection list >/dev/null 2>&1
  }

  # ─── Step: Bun ──────────────────────────────────────────────────────────
  step "Bun runtime"
  if [ ! -x "${BUN_INSTALL}/bin/bun" ]; then
    if curl -fsSL https://bun.sh/install 2>> "$STARTUP_LOG" | bash >> "$STARTUP_LOG" 2>&1; then
      step_ok
    else
      step_fail
      fatal_startup "Bun installation failed."
    fi
  else
    step_ok
  fi

  # ─── Step: qmd ──────────────────────────────────────────────────────────
  step "qmd setup"
  qmd_install_path="${BUN_INSTALL}/install/global/node_modules/@tobilu/qmd"
  qmd_needs_install=false

  if ! command -v qmd >/dev/null 2>&1; then
    qmd_needs_install=true
  elif ! qmd_cli_ready; then
    qmd_needs_install=true
  elif [ ! -d "$qmd_install_path/dist" ]; then
    qmd_needs_install=true
  fi

  if [ "$qmd_needs_install" = "true" ]; then
    if bun install -g @tobilu/qmd >> "$STARTUP_LOG" 2>&1; then
      if [ -d "$qmd_install_path" ]; then
        mkdir -p /data/cache/qmd
        if ! (cd "$qmd_install_path" && bun install && bun run build) > "$QMD_BUILD_LOG_PATH" 2>&1; then
          cat "$QMD_BUILD_LOG_PATH" >> "$STARTUP_LOG" 2>/dev/null || true
          step_fail
          fatal_startup "qmd build failed. Full log: ${QMD_BUILD_LOG_PATH}"
        fi
        if qmd_cli_ready; then
          step_ok
        else
          cat "$QMD_BUILD_LOG_PATH" >> "$STARTUP_LOG" 2>/dev/null || true
          step_fail
          fatal_startup "qmd build finished but the CLI is still not working."
        fi
      else
        step_fail
        fatal_startup "qmd install path ${qmd_install_path} not found after installation."
      fi
    else
      step_fail
      fatal_startup "qmd installation failed."
    fi
  else
    step_ok
  fi

  write_qmd_runtime_status null false null

  # ─── Step: qmd collections ──────────────────────────────────────────────
  step "qmd workspace collections"
  if qmd_indexing_ready; then
    if qmd collection list 2>/dev/null | grep -q "^workspace "; then
      qmd collection remove workspace >> "$STARTUP_LOG" 2>&1 || true
    fi

    prepare_qmd_derived_docx

    if ! ensure_qmd_collection "$QMD_TEXT_COLLECTION_NAME" /data/workspace "$QMD_TEXT_COLLECTION_MASK"; then
      step_fail
      fatal_startup "Failed to create qmd workspace-text collection."
    fi
    if ! ensure_qmd_collection "$QMD_DERIVED_COLLECTION_NAME" "$QMD_DERIVED_DOCX_ROOT" "$QMD_DERIVED_COLLECTION_MASK"; then
      step_fail
      fatal_startup "Failed to create qmd workspace-derived collection."
    fi

    qmd context add "qmd://${QMD_TEXT_COLLECTION_NAME}" \
      "Canvas Studios workspace text files, notes, code, and structured documents." >> "$STARTUP_LOG" 2>&1 || true
    qmd context add "qmd://${QMD_DERIVED_COLLECTION_NAME}" \
      "Derived searchable document text extracted from workspace DOCX files. Always map results back to the original workspace document path." >> "$STARTUP_LOG" 2>&1 || true

    if qmd update >> "$STARTUP_LOG" 2>&1; then
      write_qmd_runtime_status "\"$(date -Iseconds)\"" true null
    else
      write_qmd_runtime_status null false null
      step_fail
      fatal_startup "Initial qmd update failed."
    fi
    step_ok

    # Background indexing loops (silent)
    (
      while true; do
        sleep 1800
        prepare_qmd_derived_docx
        if qmd update >> "$STARTUP_LOG" 2>&1; then
          write_qmd_runtime_status "\"$(date -Iseconds)\"" true null
        else
          write_qmd_runtime_status "\"$(date -Iseconds)\"" false null
        fi
      done
    ) &

    (
      sleep 1800
      qmd embed >> "$STARTUP_LOG" 2>&1 &
      write_qmd_runtime_status "\"$(date -Iseconds)\"" true "\"$(date -Iseconds)\""

      while true; do
        current_hour=$(date +%-H)
        current_min=$(date +%-M)
        minutes_until_1am=$(( (24 - current_hour + 1) % 24 * 60 - current_min ))
        if [ $minutes_until_1am -le 0 ]; then
          minutes_until_1am=$((minutes_until_1am + 1440))
        fi
        sleep $((minutes_until_1am * 60))
        qmd embed >> "$STARTUP_LOG" 2>&1 &
        write_qmd_runtime_status "\"$(date -Iseconds)\"" true "\"$(date -Iseconds)\""
        sleep 86400
      done
    ) &
  else
    step_fail
    fatal_startup "qmd is not working properly after setup."
  fi
fi

printf '\n\n  Canvas Notebook ready.\n\n'

exec "$@"
