#!/usr/bin/env bash

install_docker() {
  section "Docker"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker already installed"
  else
    info "Installing Docker..."
    if ! command -v curl >/dev/null 2>&1; then
      run_root apt-get update -qq
      run_root apt-get install -y curl
    fi
    curl -fsSL https://get.docker.com | sh >/dev/null
    ok "Docker installed"
    if ! id -nG "${USER:-$(id -un)}" | grep -qw docker; then
      run_root usermod -aG docker "${USER:-$(id -un)}"
      warn "Added '${USER:-$(id -un)}' to the docker group — using sudo docker for this session."
    fi
  fi

  DOCKER_COMPOSE="docker compose"
  if ! docker info >/dev/null 2>&1; then
    if sudo docker info >/dev/null 2>&1; then
      DOCKER_COMPOSE="sudo docker compose"
      info "Using sudo docker for this session."
    else
      fail "Docker is installed but not reachable. Check installation logs."
    fi
  fi
  export DOCKER_COMPOSE
}

docker_image_digest() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker image inspect "$IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | awk -F@ 'NF == 2 {print $2}'
  elif sudo docker image inspect "$IMAGE" >/dev/null 2>&1; then
    sudo docker image inspect "$IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | awk -F@ 'NF == 2 {print $2}'
  fi
}

remote_image_digest() {
  if docker buildx imagetools inspect "$IMAGE" >/dev/null 2>&1; then
    docker buildx imagetools inspect "$IMAGE" 2>/dev/null | awk '/^Digest:/ {print $2; exit}'
  elif sudo docker buildx imagetools inspect "$IMAGE" >/dev/null 2>&1; then
    sudo docker buildx imagetools inspect "$IMAGE" 2>/dev/null | awk '/^Digest:/ {print $2; exit}'
  elif docker manifest inspect -v "$IMAGE" >/dev/null 2>&1; then
    docker manifest inspect -v "$IMAGE" 2>/dev/null | sed -n 's/.*"Descriptor":{.*"digest":"\([^"]*\)".*/\1/p' | head -1
  elif sudo docker manifest inspect -v "$IMAGE" >/dev/null 2>&1; then
    sudo docker manifest inspect -v "$IMAGE" 2>/dev/null | sed -n 's/.*"Descriptor":{.*"digest":"\([^"]*\)".*/\1/p' | head -1
  fi
}

pull_size_mb() {
  local log_file="$1"
  awk '
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
  ' "$log_file" 2>/dev/null
}

pull_image_if_needed() {
  local remote_digest pull_log spin i pull_pid layers size_msg

  section "Image"
  remote_digest="$(remote_image_digest || true)"
  if [[ -n "$remote_digest" ]] && docker_image_digest | grep -Fxq "$remote_digest"; then
    ok "Already up to date (${IMAGE}@${remote_digest:0:19}...)"
    return 0
  fi

  spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  i=0
  pull_log="$(mktemp)"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" pull >"$pull_log" 2>&1 &
  pull_pid=$!
  while kill -0 "$pull_pid" 2>/dev/null; do
    printf "\r  ${spin:$((i % ${#spin})):1} Pulling latest image..."
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pull_pid" || { cat "$pull_log"; rm -f "$pull_log"; fail "Image pull failed"; }
  layers=$(grep -cE 'Pulling fs layer|Already exists' "$pull_log" 2>/dev/null || true)
  size_msg="$(pull_size_mb "$pull_log")"
  rm -f "$pull_log"
  printf "\r  ✓ Image pulled (%s layers, %s MB)\n" "${layers:-0}" "${size_msg:-0}"
}

cleanup_docker_artifacts() {
  section "Docker cleanup"
  info "Skipped host-wide Docker cleanup. Run Docker prune manually if you want to reclaim unrelated images or containers."
}
