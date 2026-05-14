#!/usr/bin/env bash
# Shared Caddy utility functions for Canvas Notebook CLI and installer.
# Sourced by both install/bin/canvas-notebook and install/lib/caddy.sh

[[ -n "${_SHARED_CADDY_LOADED:-}" ]] && return 0
_SHARED_CADDY_LOADED=1

is_real_domain() {
  local domain="$1"
  [[ -n "$domain" ]] && [[ "$domain" != "localhost" ]] && ! [[ "$domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

CADDYFILE="/etc/caddy/Caddyfile"

caddy_site_block() {
  local domain="$1"
  printf '%s {\n    reverse_proxy localhost:3456 {\n        header_up X-Forwarded-Port 443\n    }\n}\n' "$domain"
}

write_caddy_config() {
  local domain="$1"
  local tmp
  tmp="$(mktemp)"
  caddy_site_block "$domain" > "$tmp"
  run_root cp "$tmp" "$CADDYFILE"
  rm -f "$tmp"
}

sync_caddy() {
  local domain
  domain="$(configured_domain)"

  if ! is_real_domain "$domain"; then
    info "No public domain configured in BETTER_AUTH_BASE_URL or BASE_URL; skipping Caddy sync."
    return 0
  fi

  if ! command -v caddy >/dev/null 2>&1 && ! command -v systemctl >/dev/null 2>&1; then
    info "Caddy is not installed; skipping Caddy sync."
    return 0
  fi

  info "Writing Caddy config for ${domain}..."
  write_caddy_config "$domain"

  if command -v caddy >/dev/null 2>&1; then
    if ! run_root caddy validate --config "$CADDYFILE" 2>&1; then
      warn "Caddyfile validation failed — check your Caddy config manually."
      warn "Run: sudo caddy validate --config ${CADDYFILE}"
      return 0
    fi
  fi
  if ! run_root systemctl reload caddy 2>&1 && ! run_root systemctl restart caddy 2>&1; then
    warn "Could not reload or restart Caddy. Check: sudo systemctl status caddy"
  fi
  ok "Caddy synced for https://${domain}"
}

caddy_fix() {
  local domain fixed_something=false

  domain="$(configured_domain)"

  printf '\n== Caddy fix ==\n'

  if ! command -v caddy >/dev/null 2>&1 && ! command -v systemctl >/dev/null 2>&1; then
    warn "Caddy is not installed; nothing to fix."
    return 1
  fi

  if ! is_real_domain "$domain"; then
    warn "No public domain configured in BETTER_AUTH_BASE_URL or BASE_URL; cannot fix."
    return 1
  fi

  if [[ -f "$CADDYFILE" ]]; then
    if ! grep -q "^${domain}[[:space:]]*{" "$CADDYFILE" 2>/dev/null; then
      info "Rewriting ${CADDYFILE} with correct domain config"
      write_caddy_config "$domain"
      fixed_something=true
    else
      local current_block expected_block
      current_block="$(grep -A3 "^${domain}[[:space:]]*{" "$CADDYFILE" 2>/dev/null)"
      expected_block="$(caddy_site_block "$domain")"
      if [[ "$current_block" != "$expected_block" ]]; then
        info "Updating domain config in ${CADDYFILE}"
        write_caddy_config "$domain"
        fixed_something=true
      fi
    fi
  else
    info "Creating ${CADDYFILE} for ${domain}"
    write_caddy_config "$domain"
    fixed_something=true
  fi

  local canvas_caddyfile="/etc/caddy/conf.d/canvas-notebook.caddy"
  if [[ -f "$canvas_caddyfile" ]]; then
    info "Removing legacy conf.d config (no longer needed)"
    run_root rm -f "$canvas_caddyfile"
    fixed_something=true
  fi

  if command -v caddy >/dev/null 2>&1 && [[ -f "$CADDYFILE" ]]; then
    if ! run_root caddy validate --config "$CADDYFILE" 2>&1; then
      warn "Caddyfile validation failed — check your Caddy config manually."
      warn "Run: sudo caddy validate --config ${CADDYFILE}"
      return 0
    fi
  fi

  if ! run_root systemctl reload caddy 2>&1 && ! run_root systemctl restart caddy 2>&1; then
    warn "Could not reload or restart Caddy. Check: sudo systemctl status caddy"
  fi

  if [[ "$fixed_something" == "true" ]]; then
    ok "Caddy configuration fixed and reloaded"
  else
    ok "Caddy configuration is already correct — no changes needed"
  fi
}