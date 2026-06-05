#!/usr/bin/env bash

admin_usage() {
  cat <<'HELP'
Usage:
  canvas-notebook admin reset-password --email <email> [--name <name>] [--password-stdin] [--show-password]

Options:
  --email <email>       Login email to set for the admin account
  --name <name>         Display name (default: Administrator)
  --password-stdin      Read the new password from stdin
  --show-password       Do not hide typed password input

This command runs the same Better Auth bootstrap sync used during container startup,
but passes the new password over stdin to the process inside the container. It
does not write BOOTSTRAP_ADMIN_* to config.json or env files.
HELP
}

_admin_json_error() {
  local message="$1" code="${2:-1}"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    printf '{"success":false,"error":"%s"}\n' "$(json_escape "$message")"
    exit "$code"
  fi
  fail "$message"
}

_admin_json_ok() {
  local email="$1" name="$2"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    printf '{"success":true,"email":"%s","name":"%s"}\n' "$(json_escape "$email")" "$(json_escape "$name")"
  else
    ok "Admin credentials synchronized for ${email}"
    info "The password was passed over stdin to the container and was not stored in config.json."
  fi
}

_admin_require_running_container() {
  local cid
  cid="$(container_id)"
  if [[ -z "$cid" ]]; then
    _admin_json_error "Canvas Notebook container is not running. Start it first: canvas-notebook start"
  fi
  printf '%s\n' "$cid"
}

_admin_read_password() {
  local password="" confirm="" show_password="$1"

  if [[ "${ADMIN_PASSWORD_STDIN:-false}" == "true" ]]; then
    IFS= read -r password || true
    printf '%s\n' "$password"
    return
  fi

  if [[ ! -t 0 || ! -t 1 ]]; then
    _admin_json_error "Password input requires a TTY. Use --password-stdin for automation."
  fi

  if [[ "$show_password" == "true" ]]; then
    read -rp "New admin password: " password
    read -rp "Repeat admin password: " confirm
  else
    read -rsp "New admin password: " password
    printf '\n'
    read -rsp "Repeat admin password: " confirm
    printf '\n'
  fi

  if [[ "$password" != "$confirm" ]]; then
    _admin_json_error "Passwords do not match."
  fi

  printf '%s\n' "$password"
}

_admin_validate_password() {
  local password="$1"
  if [[ "${#password}" -lt 8 || "${#password}" -gt 128 ]]; then
    _admin_json_error "Password must be between 8 and 128 characters."
  fi
}

_admin_validate_email() {
  local email="$1"
  if [[ ! "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    _admin_json_error "Enter a valid email address."
  fi
}

_admin_reset_password() {
  local email="" name="Administrator" show_password=false
  ADMIN_PASSWORD_STDIN=false

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --email)
        [[ "$#" -ge 2 ]] || _admin_json_error "--email requires a value"
        email="$2"
        shift 2
        ;;
      --name)
        [[ "$#" -ge 2 ]] || _admin_json_error "--name requires a value"
        name="$2"
        shift 2
        ;;
      --password-stdin)
        ADMIN_PASSWORD_STDIN=true
        shift
        ;;
      --show-password)
        show_password=true
        shift
        ;;
      -h|--help)
        admin_usage
        return 0
        ;;
      *)
        _admin_json_error "Unknown admin reset-password option: $1"
        ;;
    esac
  done

  [[ -n "$email" ]] || _admin_json_error "Missing --email"
  [[ -n "$name" ]] || name="Administrator"
  _admin_validate_email "$email"

  local password cid tmp_output
  password="$(_admin_read_password "$show_password")"
  _admin_validate_password "$password"
  cid="$(_admin_require_running_container)"
  tmp_output="$(mktemp)"

  if printf '%s\n' "$password" | docker_cmd exec \
    -i \
    "$cid" node scripts/bootstrap-admin.js \
    --email "$email" \
    --name "$name" \
    --password-stdin >"$tmp_output" 2>&1; then
    cat "$tmp_output" >> "$LOG_FILE" 2>/dev/null || true
    rm -f "$tmp_output"
    _admin_json_ok "$email" "$name"
  else
    local output
    output="$(cat "$tmp_output" 2>/dev/null || true)"
    rm -f "$tmp_output"
    if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
      printf '{"success":false,"error":"%s"}\n' "$(json_escape "${output:-Admin password reset failed}")"
      exit 1
    fi
    printf '%s\n' "$output" >&2
    fail "Admin password reset failed"
  fi
}

cmd_admin() {
  local subcommand="${1:-}"
  if [[ -z "$subcommand" || "$subcommand" == "-h" || "$subcommand" == "--help" ]]; then
    admin_usage
    return 0
  fi
  shift || true

  case "$subcommand" in
    reset-password|set-password)
      log_msg "admin ${subcommand}"
      _admin_reset_password "$@"
      ;;
    *)
      _admin_json_error "Unknown admin subcommand: ${subcommand}"
      ;;
  esac
}
