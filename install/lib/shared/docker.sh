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
  local compose_cmd="$1"
  local image_ref="$2"
  local service="$3"
  local log_file="${4:-}"

  local remote_digest
  remote_digest="$(remote_image_digest "$image_ref" || true)"
  if [[ -n "$remote_digest" ]] && image_digest "$image_ref" | grep -Fxq "$remote_digest"; then
    ok "Already up to date (${image_ref}@${remote_digest:0:19}...)"
    return 0
  fi

  local pull_log spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  pull_log="$(mktemp)"
  $compose_cmd pull "$service" >"$pull_log" 2>&1 &
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