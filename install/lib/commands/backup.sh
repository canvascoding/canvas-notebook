#!/usr/bin/env bash

LATEST_BACKUP_FILE_NAME="canvas-notebook-backup-latest.zip"

backup_usage() {
  cat <<'HELP'
Usage:
  canvas-notebook backup create [--output <path>] [--json] [--no-wait]

Options:
  --output <path>       Copy the completed latest backup to this host file or directory
  --no-wait             Queue the backup job without waiting; cannot be combined with --output
  --keep-job-artifacts  Keep per-job backup directories after latest promotion
  --json                Print machine-readable JSON

The backup command runs the Notebook backup engine inside the app container.
It does not call the running web app over HTTP and does not stop the app.
HELP
}

_backup_json_error() {
  local message="$1" code="${2:-1}"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    printf '{"success":false,"error":"%s"}\n' "$(json_escape "$message")"
    exit "$code"
  fi
  fail "$message"
}

_backup_data_dir() {
  local data_dir
  data_dir="$(config_json_read dataDir 2>/dev/null || true)"
  printf '%s\n' "${data_dir:-${DATA_DIR}}"
}

_backup_latest_host_path() {
  printf '%s/system/backups/latest/%s\n' "$(_backup_data_dir)" "$LATEST_BACKUP_FILE_NAME"
}

_backup_copy_atomic() {
  local source_path="$1" requested_output="$2" output_path output_dir temp_path
  if [[ ! -f "$source_path" ]]; then
    _backup_json_error "Latest backup artifact was not found at the expected host path."
  fi

  output_path="$requested_output"
  if [[ -d "$output_path" ]]; then
    output_path="${output_path%/}/${LATEST_BACKUP_FILE_NAME}"
  fi
  output_dir="$(dirname "$output_path")"
  mkdir -p "$output_dir"
  temp_path="${output_dir}/.$(basename "$output_path").next-$$-$(date +%s)"
  cp "$source_path" "$temp_path"
  chmod 600 "$temp_path" 2>/dev/null || true
  mv -f "$temp_path" "$output_path"
  printf '%s\n' "$output_path"
}

_backup_require_running_container() {
  local cid
  cid="$(container_id)"
  if [[ -z "$cid" ]]; then
    _backup_json_error "Canvas Notebook container is not running. Start it first: canvas-notebook start"
  fi
  printf '%s\n' "$cid"
}

_backup_create() {
  local output_path="" no_wait=false keep_job_artifacts=false arg
  while [[ "$#" -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      --output)
        shift
        output_path="${1:-}"
        [[ -n "$output_path" ]] || _backup_json_error "Missing value for --output" 2
        ;;
      --output=*)
        output_path="${arg#--output=}"
        [[ -n "$output_path" ]] || _backup_json_error "Missing value for --output" 2
        ;;
      --no-wait)
        no_wait=true
        ;;
      --keep-job-artifacts)
        keep_job_artifacts=true
        ;;
      *)
        _backup_json_error "Unknown backup create option: ${arg}" 2
        ;;
    esac
    shift || true
  done

  if [[ -n "$output_path" && "$no_wait" == "true" ]]; then
    _backup_json_error "--output cannot be combined with --no-wait." 2
  fi

  log_msg "backup create"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    migrate_compose_file >/dev/null
  else
    migrate_compose_file
  fi
  config_json_to_env
  postgres_prepare_managed_runtime

  local cid latest_host_path copied_output docker_args result
  cid="$(_backup_require_running_container)"
  docker_args=(
    exec
    "$cid"
    npx
    tsx
    --conditions
    react-server
    scripts/create-full-backup.ts
  )
  if [[ "$no_wait" != "true" ]]; then
    docker_args+=(--latest)
  fi
  if [[ "$keep_job_artifacts" == "true" ]]; then
    docker_args+=(--keep-job-artifacts)
  fi
  if [[ "$no_wait" == "true" ]]; then
    docker_args+=(--no-wait)
  fi
  docker_args+=(--json)

  if ! result="$(docker_cmd "${docker_args[@]}" 2>&1)"; then
    _backup_json_error "$result"
  fi

  latest_host_path="$(_backup_latest_host_path)"
  copied_output=""
  if [[ -n "$output_path" ]]; then
    copied_output="$(_backup_copy_atomic "$latest_host_path" "$output_path")"
  fi

  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    printf '%s\n' "$result"
  elif [[ "$no_wait" == "true" ]]; then
    printf '%s\n' "$result" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/Full backup queued: \1/p' | head -1
  else
    ok "Full backup completed: ${copied_output:-$latest_host_path}"
  fi
}

cmd_backup() {
  local subcommand="${1:-}"
  if [[ -z "$subcommand" || "$subcommand" == "-h" || "$subcommand" == "--help" ]]; then
    backup_usage
    return 0
  fi
  shift || true

  case "$subcommand" in
    create)
      _backup_create "$@"
      ;;
    *)
      _backup_json_error "Unknown backup subcommand: ${subcommand}" 2
      ;;
  esac
}
