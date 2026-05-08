#!/usr/bin/env bash
# Installer Docker functions. Sources shared docker.sh for image/pull utilities.

# shellcheck source=lib/shared/docker.sh
. "${SUPPORT_DIR}/lib/shared/docker.sh"

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
    local _docker_user="${SUDO_USER:-${USER:-$(id -un)}}"
    if ! id -nG "$_docker_user" | grep -qw docker; then
      run_root usermod -aG docker "$_docker_user"
      warn "Added '$_docker_user' to the docker group — using sudo docker for this session."
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

cleanup_docker_artifacts() {
  section "Docker cleanup"
  info "Skipped host-wide Docker cleanup. Run Docker prune manually if you want to reclaim unrelated images or containers."
}