#!/usr/bin/env bash
# Installer Caddy functions. Sources shared/caddy.sh for core Caddy utilities.

# shellcheck source=lib/shared/caddy.sh
. "${SUPPORT_DIR}/lib/shared/caddy.sh"

install_caddy() {
  section "Caddy (HTTPS reverse proxy)"
  if [[ "$SETUP_CADDY" == "true" ]]; then
    if command -v caddy >/dev/null 2>&1; then
      ok "Caddy already installed"
    else
      spinner_step "Installing prerequisites..." run_root apt-get install -y debian-keyring debian-archive-keyring apt-transport-https || warn "Could not install all prerequisite packages — continuing anyway"

      local _gpg_tmp
      _gpg_tmp="$(mktemp)"
      spinner_step "Downloading Caddy GPG key..." curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' -o "$_gpg_tmp"
      if [[ ! -s "$_gpg_tmp" ]]; then
        rm -f "$_gpg_tmp"
        fail "Failed to download Caddy GPG key. Check your internet connection and try again."
      fi
      spinner_step "Importing Caddy GPG key..." run_root gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg "$_gpg_tmp"
      if [[ $? -ne 0 ]]; then
        rm -f "$_gpg_tmp"
        fail "Failed to import Caddy GPG key. The key file may be corrupted or gpg may have issues."
      fi
      rm -f "$_gpg_tmp"

      local _repo_tmp
      _repo_tmp="$(mktemp)"
      spinner_step "Adding Caddy repository..." curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o "$_repo_tmp"
      if [[ ! -s "$_repo_tmp" ]]; then
        rm -f "$_repo_tmp"
        fail "Failed to download Caddy apt repository. Check your internet connection."
      fi
      run_root cp "$_repo_tmp" /etc/apt/sources.list.d/caddy-stable.list
      rm -f "$_repo_tmp"

      spinner_step "Updating package lists..." run_root apt-get update -qq
      if [[ $? -ne 0 ]]; then
        fail "apt-get update failed after adding Caddy repo. Check your network connection and try:\n  sudo apt-get update\n  sudo apt-get install -y caddy"
      fi

      spinner_step "Installing Caddy..." run_root apt-get install -y caddy
      if [[ $? -ne 0 ]]; then
        fail "Failed to install Caddy package. Try manually:\n  sudo apt-get install -y caddy"
      fi
    fi
  else
    ok "Skipped"
  fi
}

detect_public_ip() {
  curl -sf4 https://ifconfig.me 2>/dev/null \
    || curl -sf4 https://api.ipify.org 2>/dev/null \
    || curl -sf4 https://checkip.amazonaws.com 2>/dev/null \
    || true
}

configure_caddy() {
  local domain="$1" server_ip
  local caddyfile="/etc/caddy/Caddyfile"

  if [[ "$SETUP_CADDY" != "true" ]]; then
    if ! command -v caddy >/dev/null 2>&1; then
      return
    fi
    if ! is_real_domain "$domain"; then
      return
    fi
  fi

  section "Public access"
  if is_real_domain "$domain"; then
    spinner_step "Writing Caddy config..." write_caddy_config "$domain"

    if command -v caddy >/dev/null 2>&1; then
      if ! run_root caddy validate --config "$caddyfile" 2>&1; then
        warn "Caddyfile validation failed — check your Caddy config manually."
        warn "You can fix this later by editing ${caddyfile} and running: sudo systemctl reload caddy"
        return 0
      fi
    fi
    if ! run_root systemctl reload caddy 2>&1 && ! run_root systemctl restart caddy 2>&1; then
      warn "Could not reload or restart Caddy. Check: sudo systemctl status caddy"
    fi
    ok "Caddy configured — https://${domain} -> localhost:3456"
    info "Let's Encrypt certificate will be obtained automatically on the first request."

    server_ip="$(detect_public_ip)"
    echo
    warn "Make sure ports 80 and 443 are open in your firewall / security group."
    warn "Make sure your DNS A record points '${domain}' to the public IP of this VM/server."
    if [[ -n "$server_ip" ]]; then
      info "Best-effort detected public IP: ${server_ip}"
      info "Verify it against your cloud provider before changing DNS."
    else
      info "Could not detect a public IP from here. Use the public IP shown by your VM/cloud provider."
    fi
  else
    server_ip="$(detect_public_ip)"
    if [[ -n "$server_ip" ]]; then
      ok "App available at http://${server_ip}:3456"
      info "If this server is behind NAT, use the public IP shown by your VM/cloud provider instead."
    else
      ok "App available at http://<your-public-server-ip>:3456"
      info "Use the public IP shown by your VM/cloud provider."
    fi
    info "To enable HTTPS: set your domain in the config and re-run."
    info "Make sure port 3456 is open in your firewall / security group."
  fi
}