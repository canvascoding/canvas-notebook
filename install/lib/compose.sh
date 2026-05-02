#!/usr/bin/env bash

prepare_install_dir() {
  local source_dir target_dir
  source_dir="$(pwd)"
  target_dir="$INSTALL_DIR"

  if [[ "$target_dir" != /* ]]; then
    fail "CANVAS_INSTALL_DIR must be an absolute path."
  fi
  if [[ "$DATA_DIR" != /* ]]; then
    fail "CANVAS_DATA_DIR must be an absolute path."
  fi

  section "Install directory"
  run_root mkdir -p "$target_dir"
  run_root chown "$(id -u):$(id -g)" "$target_dir"

  if [[ "$source_dir" != "$target_dir" ]]; then
    if [[ -f "${source_dir}/${COMPOSE_FILE_NAME}" ]]; then
      LEGACY_COMPOSE_PATH="${source_dir}/${COMPOSE_FILE_NAME}"

      if [[ ! -f "${target_dir}/${COMPOSE_FILE_NAME}" ]]; then
        cp "${LEGACY_COMPOSE_PATH}" "${target_dir}/${COMPOSE_FILE_NAME}"
        ok "Migrated existing ${COMPOSE_FILE_NAME} to ${target_dir}"
      fi
    fi

    if [[ -d "${source_dir}/data" && "${source_dir}/data" != "$DATA_DIR" ]]; then
      LEGACY_DATA_PATH="${source_dir}/data"
      info "Existing data directory will be migrated after any legacy container is stopped."
    fi
  fi

  if [[ -z "$LEGACY_DATA_PATH" && -d "${target_dir}/data" && "${target_dir}/data" != "$DATA_DIR" ]]; then
    LEGACY_DATA_PATH="${target_dir}/data"
    info "Existing managed data directory will be migrated to ${DATA_DIR}."
  fi

  cd "$target_dir"
  COMPOSE_FILE="${INSTALL_DIR}/${COMPOSE_FILE_NAME}"
  ok "Using ${target_dir}"
}

stop_legacy_install() {
  if [[ -z "$LEGACY_COMPOSE_PATH" ]]; then
    return 0
  fi

  section "Legacy install"
  info "Stopping previous Compose project before starting the managed install..."
  if $DOCKER_COMPOSE -f "$LEGACY_COMPOSE_PATH" down --remove-orphans; then
    ok "Stopped previous Compose project"
  else
    warn "Could not stop previous Compose project automatically."
    warn "If port 3456 is still allocated, run: $DOCKER_COMPOSE -f ${LEGACY_COMPOSE_PATH} down --remove-orphans"
  fi
}

migrate_legacy_data() {
  if [[ -z "$LEGACY_DATA_PATH" ]]; then
    return 0
  fi

  section "Data migration"
  if [[ -e "$DATA_DIR" ]]; then
    ok "${DATA_DIR} already exists — keeping it"
    return 0
  fi

  run_root mkdir -p "$(dirname "$DATA_DIR")"
  mv "$LEGACY_DATA_PATH" "$DATA_DIR"
  ok "Migrated existing data directory to ${DATA_DIR}"
}

configure_data_bind_mount() {
  local escaped_data_dir

  section "Data directory"
  run_root mkdir -p "$DATA_DIR"
  run_root chown -R 1000:1000 "$DATA_DIR"

  escaped_data_dir="$(sed_replacement_escape "$DATA_DIR")"
  sed -i -E "s|^([[:space:]]*-[[:space:]]*).+:/data([[:space:]]*)$|\\1${escaped_data_dir}:/data\\2|" "$COMPOSE_FILE"

  ok "Persistent data bind mount: ${DATA_DIR} -> /data"
}

wait_for_canvas_startup() {
  local host_port health_url log_pgid attempt max_attempts since_ts

  host_port="$($DOCKER_COMPOSE -f "$COMPOSE_FILE" port canvas-notebook 3000 2>/dev/null | tail -1 | awk -F: '{print $NF}')"
  host_port="${host_port:-3456}"
  health_url="http://127.0.0.1:${host_port}/api/health"
  max_attempts="${INSTALL_HEALTH_MAX_ATTEMPTS:-180}"
  since_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  stop_log_stream() {
    if [[ -n "${log_pgid:-}" ]]; then
      kill -- "-$log_pgid" >/dev/null 2>&1 || true
      wait "-$log_pgid" >/dev/null 2>&1 || true
    fi
  }

  _wait_filter() {
    local line strip_ansi
    strip_ansi='s/\x1b\[[0-9;]*[a-zA-Z]//g'
    while IFS= read -r line; do
      line="$(printf '%s' "$line" | sed "$strip_ansi")"
      line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
      [[ -z "$line" ]] && continue
      case "$line" in
        *Pulling*fs*layer*|*Pulling*layer*|*Downloading*|*Download*complete*|*Extracting*|*Pull*complete*|*Already*exists*) continue ;;
        *Recreating*|*Recreated*|*Starting*|*Started*) continue ;;
        *canvas-notebook*" | "*) line="$(printf '%s' "$line" | sed 's/^.*canvas-notebook[[:space:]]*|[[:space:]]*//')" ;;
      esac
      printf '%s\n' "$line"
    done
  }

  section "Container startup"
  info "Streaming startup logs..."
  pkill -f "docker[- ]compose .*logs.* -f.* canvas-notebook" >/dev/null 2>&1 || true
  pkill -f "docker compose .*logs.*-f.*canvas-notebook" >/dev/null 2>&1 || true
  set -m
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" logs -f --since="$since_ts" canvas-notebook 2>&1 | _wait_filter &
  log_pgid=$(ps -o pgid= $! 2>/dev/null | tr -d ' ') || true
  set +m

  trap 'stop_log_stream' RETURN

  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    if curl -fsS "$health_url" >/dev/null 2>&1; then
      stop_log_stream
      ok "Canvas Notebook is healthy (${health_url})"
      return 0
    fi
    sleep 1
  done

  stop_log_stream
  fail "Canvas Notebook did not become healthy within ${max_attempts}s. Run: $DOCKER_COMPOSE -f ${COMPOSE_FILE} logs canvas-notebook"
}

start_canvas_container() {
  local recreate_log spin i recreate_pid
  section "Starting Canvas Notebook"
  spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  i=0
  recreate_log="$(mktemp)"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d --force-recreate >"$recreate_log" 2>&1 &
  recreate_pid=$!
  while kill -0 "$recreate_pid" 2>/dev/null; do
    printf "\r  ${spin:$((i % ${#spin})):1} Creating container..."
    i=$((i + 1))
    sleep 0.08
  done
  wait "$recreate_pid" || { cat "$recreate_log"; rm -f "$recreate_log"; fail "Container start failed"; }
  rm -f "$recreate_log"
  printf "\r  ✓ Container created\n"
  wait_for_canvas_startup
}
