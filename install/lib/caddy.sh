#!/usr/bin/env bash

install_caddy() {
  section "Caddy (HTTPS reverse proxy)"
  if [[ "$SETUP_CADDY" == "true" ]]; then
    if command -v caddy >/dev/null 2>&1; then
      ok "Caddy already installed"
    else
      info "Installing Caddy..."
      run_root apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1 || true
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | run_root gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | run_root tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      run_root apt-get update -qq >/dev/null
      run_root apt-get install -y caddy >/dev/null
      ok "Caddy installed"
    fi
  else
    ok "Skipped"
  fi
}

is_real_domain() {
  local host="$1"
  [[ -n "$host" ]] \
    && [[ "$host" != "localhost" ]] \
    && ! [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

detect_public_ip() {
  curl -sf4 https://ifconfig.me 2>/dev/null \
    || curl -sf4 https://api.ipify.org 2>/dev/null \
    || curl -sf4 https://checkip.amazonaws.com 2>/dev/null \
    || true
}

configure_caddy() {
  local domain="$1" caddyfile canvas_caddyfile include_line server_ip
  if [[ "$SETUP_CADDY" != "true" ]]; then return; fi

  caddyfile="/etc/caddy/Caddyfile"
  canvas_caddyfile="/etc/caddy/conf.d/canvas-notebook.caddy"
  include_line="import /etc/caddy/conf.d/*.caddy"

  section "Public access"
  if is_real_domain "$domain"; then
    run_root mkdir -p /etc/caddy/conf.d
    printf '%s {\n    reverse_proxy localhost:3456\n}\n' "$domain" | run_root tee "$canvas_caddyfile" >/dev/null
    if [[ ! -f "$caddyfile" ]]; then
      printf '%s\n' "$include_line" | run_root tee "$caddyfile" >/dev/null
    elif ! grep -Fxq "$include_line" "$caddyfile"; then
      printf '\n%s\n' "$include_line" | run_root tee -a "$caddyfile" >/dev/null
    fi
    run_root caddy validate --config "$caddyfile" >/dev/null 2>&1 || fail "Caddyfile validation failed."
    run_root systemctl reload caddy || run_root systemctl restart caddy
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
