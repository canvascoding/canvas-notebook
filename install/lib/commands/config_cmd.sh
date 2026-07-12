#!/usr/bin/env bash

_mask_json_secrets() {
  local input="$1"
  printf '%s' "$input" | config_json_mask_secrets
}

_secret_sha256() {
  local value="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$value" | openssl dgst -sha256 | awk '{print $NF}'
  else
    fail "SHA-256 support is required for --secret-state."
  fi
}

_config_secret_state() {
  local input="$1" state='{}' key value digest
  local keys=(BETTER_AUTH_SECRET CANVAS_INTERNAL_API_KEY DATABASE_URL CANVAS_POSTGRES_PASSWORD)
  while IFS= read -r key; do
    local seen=false existing
    for existing in "${keys[@]}"; do
      if [[ "$existing" == "$key" ]]; then
        seen=true
        break
      fi
    done
    [[ "$seen" == "false" ]] && keys+=("$key")
  done < <(printf '%s' "$input" | jq -r '.env | keys[] | select((ascii_upcase == "DATABASE_URL") or test("(^|_)(PASSWORD|PASSWD|SECRET_KEY|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|LICENSE_CERT)$"; "i"))')
  for key in "${keys[@]}"; do
    value="$(printf '%s' "$input" | jq -r --arg key "$key" '.env[$key] // empty')"
    if [[ -n "$value" ]]; then
      digest="$(_secret_sha256 "$value")"
      state="$(printf '%s' "$state" | jq --arg key "$key" --arg digest "$digest" '. + {($key): {present: true, sha256: $digest}}')"
    else
      state="$(printf '%s' "$state" | jq --arg key "$key" '. + {($key): {present: false, sha256: null}}')"
    fi
  done
  printf '%s\n' "$state"
}

cmd_config_show() {
  local include_secret_state=false arg input masked state
  for arg in "$@"; do
    case "$arg" in
      --secret-state) include_secret_state=true ;;
      *) fail "Unknown config-show option: ${arg}" ;;
    esac
  done
  if [[ "$include_secret_state" == "true" && "$OUTPUT_JSON" != "true" ]]; then
    fail "--secret-state requires --json."
  fi
  if [[ -f "$CONFIG_JSON_PATH" ]]; then
    input="$(_read_config_file "$CONFIG_JSON_PATH")"
  else
    input="$CONFIG_JSON_DEFAULTS"
  fi
  masked="$(_mask_json_secrets "$input")"
  if [[ "$include_secret_state" == "true" ]]; then
    state="$(_config_secret_state "$input")"
    masked="$(printf '%s' "$masked" | jq --argjson state "$state" '. + {secretState: $state}')"
  fi
  if [[ "$OUTPUT_JSON" == "true" ]]; then
    printf '%s\n' "$masked"
  else
    info "Config file: ${CONFIG_JSON_PATH}"
    echo
    if [[ -f "$CONFIG_JSON_PATH" ]]; then
      printf '%s\n' "$masked"
    else
      info "No config.json found. Run: canvas-notebook config-migrate"
    fi
  fi
}

cmd_config_set() {
  if [[ $# -lt 2 ]]; then
    fail "Usage: canvas-notebook config-set <key> <value>\n       canvas-notebook config-set <key> --stdin\n  Example: canvas-notebook config-set domain app.example.com\n  Example: printf '%s' 'secret' | canvas-notebook config-set env.CANVAS_INTERNAL_API_KEY --stdin"
  fi

  local key="$1" value from_stdin=false
  if [[ "$2" == "--stdin" ]]; then
    if [[ $# -ne 2 ]]; then
      fail "--stdin is mutually exclusive with a positional value."
    fi
    from_stdin=true
    value=""
    IFS= read -r -d '' value || true
    if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
      fail "config-set --stdin accepts a single-line value."
    fi
  else
    if [[ $# -ne 2 ]]; then
      fail "A positional value cannot be combined with additional options."
    fi
    value="$2"
  fi

  if [[ "$key" == "env.BOOTSTRAP_ADMIN_PASSWORD" ]]; then
    fail "BOOTSTRAP_ADMIN_PASSWORD is not stored in config.json. Use: canvas-notebook admin reset-password --email <email> --password-stdin"
  fi
  if [[ "$key" == env.* ]] && config_json_env_key_is_secret "${key#env.}" && [[ "$from_stdin" != "true" ]]; then
    fail "Sensitive config values require --stdin."
  fi

  config_json_write "$key" "$value"

  local display_value="$value"
  if [[ "$key" == env.* ]] && config_json_env_key_is_secret "${key#env.}"; then
    if [[ "${key#env.}" == "DATABASE_URL" ]]; then
      display_value="postgresql://***"
    else
      display_value="${value:0:4}***"
    fi
  fi
  if [[ "$from_stdin" == "true" ]]; then
    ok "Set ${key} from stdin"
  else
    ok "Set ${key} = ${display_value}"
  fi

  case "$key" in
    domain|image|hostPort|containerPort|dataDir|env.*)
      info "Config saved. Run 'env --render' to render files or 'env --sync' to apply it."
      ;;
  esac
}

cmd_config_migrate() {
  local force=false
  for arg in "$@"; do
    if [[ "$arg" == "--force" ]]; then
      force=true
    fi
  done

  if [[ "$force" == "true" ]]; then
    config_json_migrate --force
  else
    config_json_migrate
  fi
}
