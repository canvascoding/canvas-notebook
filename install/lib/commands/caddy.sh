#!/usr/bin/env bash

caddy_fix() {
  local domain caddyfile canvas_caddyfile include_line fixed_something=false

  domain="$(configured_domain)"
  caddyfile="/etc/caddy/Caddyfile"
  canvas_caddyfile="/etc/caddy/conf.d/canvas-notebook.caddy"
  include_line="import /etc/caddy/conf.d/*.caddy"

  printf '\n== Caddy fix ==\n'

  if ! command -v caddy >/dev/null 2>&1 && ! command -v systemctl >/dev/null 2>&1; then
    warn "Caddy is not installed; nothing to fix."
    return 1
  fi

  if [[ ! -f "/etc/caddy/conf.d/canvas-notebook.caddy" && ! -f "$caddyfile" ]]; then
    info "No Caddy configuration found. Run 'canvas-notebook caddy-reload' first."
    return 1
  fi

  if ! is_real_domain "$domain"; then
    warn "No public domain configured in BETTER_AUTH_BASE_URL or BASE_URL; cannot fix."
    return 1
  fi

  if [[ -f "$caddyfile" ]]; then
    local escaped_domain duplicate_count
    escaped_domain="$(printf '%s' "$domain" | sed 's/[.[\*^$]/\\&/g')"
    duplicate_count="$(grep -c "^${escaped_domain}[[:space:]]*{" "$caddyfile" 2>/dev/null || printf '0')"
    if [[ "$duplicate_count" -gt 0 ]]; then
      info "Removing duplicate domain definition from ${caddyfile} (${duplicate_count} occurrence(s))"
      remove_domain_from_main_caddyfile "$domain" "$caddyfile"
      ok "Removed duplicate('${domain}') from ${caddyfile}"
      fixed_something=true
    fi
  fi

  if [[ -f "$canvas_caddyfile" ]]; then
    if ! grep -q 'X-Forwarded-Port' "$canvas_caddyfile" 2>/dev/null; then
      info "Adding X-Forwarded-Port header to ${canvas_caddyfile}"
      write_caddy_site_config "$domain" "$canvas_caddyfile"
      ok "Added X-Forwarded-Port 443 to reverse_proxy block"
      fixed_something=true
    fi

    local current_domain
    current_domain="$(sed -n '1s/[[:space:]]*{.*//p' "$canvas_caddyfile" 2>/dev/null)"
    if [[ -n "$current_domain" && "$current_domain" != "$domain" ]]; then
      info "Updating domain in ${canvas_caddyfile}: ${current_domain} -> ${domain}"
      remove_domain_from_main_caddyfile "$current_domain" "$caddyfile"
      write_caddy_site_config "$domain" "$canvas_caddyfile"
      ok "Updated domain to ${domain}"
      fixed_something=true
    fi
  else
    info "Creating ${canvas_caddyfile} for ${domain}"
    run_root mkdir -p /etc/caddy/conf.d
    write_caddy_site_config "$domain" "$canvas_caddyfile"

    if [[ ! -f "$caddyfile" ]]; then
      printf '%s\n' "$include_line" | run_root tee "$caddyfile" >/dev/null
    elif ! grep -Fxq "$include_line" "$caddyfile"; then
      printf '\n%s\n' "$include_line" | run_root tee -a "$caddyfile" >/dev/null
    fi
    ok "Created ${canvas_caddyfile} with X-Forwarded-Port 443"
    fixed_something=true
  fi

  if command -v caddy >/dev/null 2>&1 && [[ -f "$caddyfile" ]]; then
    if ! run_root caddy validate --config "$caddyfile" 2>&1; then
      warn "Caddyfile validation failed — check your Caddy config manually."
      warn "Run: sudo caddy validate --config ${caddyfile}"
      return 0
    fi
  fi

  run_root systemctl reload caddy >/dev/null 2>&1 || run_root systemctl restart caddy >/dev/null 2>&1 || warn "Could not reload Caddy."

  if [[ "$fixed_something" == "true" ]]; then
    ok "Caddy configuration fixed and reloaded"
  else
    ok "Caddy configuration is already correct — no changes needed"
  fi
}

cmd_caddy() {
  printf 'Configured base URL: %s\n' "$(configured_base_url)"
  printf 'Configured Caddy domain: %s\n\n' "$(configured_domain)"

  if command -v systemctl >/dev/null 2>&1; then
    systemctl --no-pager status caddy || true
  else
    warn "systemctl is not available."
  fi

  if [[ -f /etc/caddy/Caddyfile ]]; then
    printf '\n== /etc/caddy/Caddyfile ==\n'
    cat /etc/caddy/Caddyfile
  fi
}

cmd_caddy_reload() {
  sync_caddy_from_compose
}

cmd_caddy_fix() {
  caddy_fix
}