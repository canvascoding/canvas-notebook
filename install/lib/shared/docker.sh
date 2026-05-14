#!/usr/bin/env bash
# Shared Docker/image functions for Canvas Notebook CLI and installer.
# Sourced by both install/bin/canvas-notebook and install/lib/docker.sh

[[ -n "${_SHARED_DOCKER_LOADED:-}" ]] && return 0
_SHARED_DOCKER_LOADED=1

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker "$@"
  else
    return 1
  fi
}

count_pull_layers() {
  local log_file="$1" count
  count=$(grep -cE 'Pulling fs layer|Already exists' "$log_file" 2>/dev/null || true)
  printf '%s' "${count:-0}"
}

pull_size_mb() {
  local log_file="$1" total
  total=$(awk '
    {
      while (match($0, /[0-9]+(\.[0-9]+)?(kB|MB|GB)/)) {
        token = substr($0, RSTART, RLENGTH)
        value = token + 0
        unit = token
        sub(/^[0-9.]+/, "", unit)
        if (unit == "kB") value = value / 1024
        else if (unit == "GB") value = value * 1024
        sum += value
        $0 = substr($0, RSTART + RLENGTH)
      }
    }
    END {printf "%.0f", sum}
  ' "$log_file" 2>/dev/null)
  printf '%s' "${total:-0}"
}

pull_image_if_needed() {
  local compose_cmd="${1:-compose}"
  local image_ref="${2:-${IMAGE_REF:-${IMAGE:-}}}"
  local service="${3:-${SERVICE:-canvas-notebook}}"
  local log_file="${4:-}"
  local compose_file="${5:-${COMPOSE_FILE:-}}"

  local remote_digest
  remote_digest="$(remote_image_digest "$image_ref" || true)"
  if [[ -n "$remote_digest" ]] && image_digest "$image_ref" | grep -Fxq "$remote_digest"; then
    ok "Already up to date (${image_ref}@${remote_digest:0:19}...)"
    return 0
  fi

  local pull_log spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  pull_log="$(mktemp)"
  if [[ -n "$compose_file" && -f "$compose_file" ]]; then
    $compose_cmd -f "$compose_file" pull "$service" >"$pull_log" 2>&1 &
  else
    docker_cmd pull "$image_ref" >"$pull_log" 2>&1 &
  fi
  local pull_pid=$!
  while kill -0 "$pull_pid" 2>/dev/null; do
    printf "\r  ${spin:$((i % ${#spin})):1} Pulling latest image..."
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pull_pid" || { cat "$pull_log"; rm -f "$pull_log"; fail "Image pull failed"; }

  local layers size_msg
  layers=$(count_pull_layers "$pull_log")
  size_msg=$(pull_size_mb "$pull_log")
  if [[ -n "$log_file" ]]; then
    mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
    touch "$log_file" 2>/dev/null || true
    cat "$pull_log" >> "$log_file" 2>/dev/null || true
  fi
  rm -f "$pull_log"
  printf "\r  ✓ Image pulled (%s layers, %s MB)\n" "$layers" "$size_msg"
}

image_digest() {
  local image_ref="${1:-${IMAGE_REF:-${IMAGE:-}}}"
  docker_cmd image inspect "$image_ref" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | awk -F@ 'NF == 2 {print $2}' || true
}

remote_image_digest() {
  local image_ref="${1:-${IMAGE_REF:-${IMAGE:-}}}"
  if docker_cmd buildx imagetools inspect "$image_ref" >/dev/null 2>&1; then
    docker_cmd buildx imagetools inspect "$image_ref" 2>/dev/null | awk '/^Digest:/ {print $2; exit}'
  elif docker_cmd manifest inspect -v "$image_ref" >/dev/null 2>&1; then
    docker_cmd manifest inspect -v "$image_ref" 2>/dev/null | sed -n 's/.*"Descriptor":{.*"digest":"\([^"]*\)".*/\1/p' | head -1
  fi
}

image_id() {
  local image_ref="${1:-${IMAGE_REF:-${IMAGE:-}}}"
  docker_cmd image inspect "$image_ref" --format '{{.Id}}' 2>/dev/null || true
}

image_created() {
  local image_ref="${1:-${IMAGE_REF:-${IMAGE:-}}}"
  docker_cmd image inspect "$image_ref" --format '{{.Created}}' 2>/dev/null || true
}

image_repo_digest() {
  local image_ref="${1:-${IMAGE_REF:-${IMAGE:-}}}"
  docker_cmd image inspect "$image_ref" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | head -1 || true
}

container_app_version() {
  local cid="${1:-}"
  [[ -z "$cid" ]] && return 0
  docker_cmd exec "$cid" node -p "require('/app/package.json').version" 2>/dev/null || true
}

container_image_ref() {
  local cid="${1:-}"
  [[ -z "$cid" ]] && return 0
  docker_cmd inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || true
}

container_image_id() {
  local cid="${1:-}"
  [[ -z "$cid" ]] && return 0
  docker_cmd inspect --format '{{.Image}}' "$cid" 2>/dev/null || true
}

container_started_at() {
  local cid="${1:-}"
  [[ -z "$cid" ]] && return 0
  docker_cmd inspect --format '{{.State.StartedAt}}' "$cid" 2>/dev/null || true
}

image_build_json() {
  local image_ref="${1:-${IMAGE_REF:-${IMAGE:-}}}" cid="${2:-}"
  local local_id local_created local_digest running_ref running_id running_started app_version
  local_id="$(image_id "$image_ref")"
  local_created="$(image_created "$image_ref")"
  local_digest="$(image_repo_digest "$image_ref")"
  running_ref="$(container_image_ref "$cid")"
  running_id="$(container_image_id "$cid")"
  running_started="$(container_started_at "$cid")"
  app_version="$(container_app_version "$cid")"

  printf '{"configuredRef":"%s","localId":"%s","localDigest":"%s","localCreated":"%s","runningRef":"%s","runningImageId":"%s","runningStartedAt":"%s","appVersion":"%s","cliVersion":"%s"}\n' \
    "$(json_escape "$image_ref")" \
    "$(json_escape "$local_id")" \
    "$(json_escape "$local_digest")" \
    "$(json_escape "$local_created")" \
    "$(json_escape "$running_ref")" \
    "$(json_escape "$running_id")" \
    "$(json_escape "$running_started")" \
    "$(json_escape "$app_version")" \
    "$(json_escape "${CANVAS_CLI_VERSION:-}")"
}

print_build_info() {
  local image_ref="${1:-${IMAGE_REF:-${IMAGE:-}}}" cid="${2:-}"
  local local_id local_created local_digest running_ref running_id running_started app_version
  local_id="$(image_id "$image_ref")"
  local_created="$(image_created "$image_ref")"
  local_digest="$(image_repo_digest "$image_ref")"
  running_ref="$(container_image_ref "$cid")"
  running_id="$(container_image_id "$cid")"
  running_started="$(container_started_at "$cid")"
  app_version="$(container_app_version "$cid")"

  printf 'CLI version: %s\n' "${CANVAS_CLI_VERSION:-unknown}"
  printf 'Configured image: %s\n' "${image_ref:-unknown}"
  printf 'Pulled image digest: %s\n' "${local_digest:-unknown}"
  printf 'Pulled image ID: %s\n' "${local_id:-unknown}"
  printf 'Pulled image created: %s\n' "${local_created:-unknown}"
  printf 'Running image: %s\n' "${running_ref:-not running}"
  printf 'Running image ID: %s\n' "${running_id:-not running}"
  printf 'Running app version: %s\n' "${app_version:-unknown}"
  printf 'Container started: %s\n' "${running_started:-not running}"
}
