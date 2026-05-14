#!/usr/bin/env bash
# Shared Caddy utility functions for Canvas Notebook CLI and installer.
# Sourced by both install/bin/canvas-notebook and install/lib/caddy.sh

[[ -n "${_SHARED_CADDY_LOADED:-}" ]] && return 0
_SHARED_CADDY_LOADED=1

is_real_domain() {
  local domain="$1"
  [[ -n "$domain" ]] && [[ "$domain" != "localhost" ]] && ! [[ "$domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

remove_domain_from_main_caddyfile() {
  local domain="$1" caddyfile="$2"
  if [[ ! -f "$caddyfile" ]]; then return; fi
  local escaped_domain
  escaped_domain="$(printf '%s' "$domain" | sed 's/[.[\*^$]/\\&/g')"
  grep -q "^${escaped_domain}[[:space:]]*{" "$caddyfile" 2>/dev/null || return
  local tmpfile
  tmpfile="$(mktemp)"
  sed "/^${escaped_domain}[[:space:]]*{/,/^}/d" "$caddyfile" > "$tmpfile"
  sed '/^$/N;/^\n$/d' "$tmpfile" > "${tmpfile}.clean"
  run_root cp "${tmpfile}.clean" "$caddyfile"
  rm -f "$tmpfile" "${tmpfile}.clean"
}

remove_default_caddy_site() {
  local caddyfile="$1"
  if [[ ! -f "$caddyfile" ]]; then return; fi
  if ! grep -qE '^:[0-9]+[[:space:]]*\{' "$caddyfile" 2>/dev/null; then return; fi
  local tmpfile
  tmpfile="$(mktemp)"
  sed '/^:[0-9]*[[:space:]]*{/,/^}/d' "$caddyfile" > "$tmpfile"
  sed '/^$/N;/^\n$/d' "$tmpfile" > "${tmpfile}.clean"
  if ! run_root cp "${tmpfile}.clean" "$caddyfile"; then
    rm -f "$tmpfile" "${tmpfile}.clean"
    return
  fi
  rm -f "$tmpfile" "${tmpfile}.clean"
  ok "Removed default Caddy site from ${caddyfile}"
}

write_caddy_site_config() {
  local domain="$1" canvas_caddyfile="$2"
  printf '%s {\n    reverse_proxy localhost:3456 {\n        header_up X-Forwarded-Port 443\n    }\n}\n' "$domain" | run_root tee "$canvas_caddyfile" >/dev/null
}

sync_caddy() {
  local domain caddyfile canvas_caddyfile include_line
  domain="$(configured_domain)"
  caddyfile="/etc/caddy/Caddyfile"
  canvas_caddyfile="/etc/caddy/conf.d/canvas-notebook.caddy"
  include_line="import /etc/caddy/conf.d/*.caddy"

  if ! is_real_domain "$domain"; then
    info "No public domain configured in BETTER_AUTH_BASE_URL or BASE_URL; skipping Caddy sync."
    return 0
  fi

  if ! command -v caddy >/dev/null 2>&1 && ! command -v systemctl >/dev/null 2>&1; then
    info "Caddy is not installed; skipping Caddy sync."
    return 0
  fi

  remove_default_caddy_site "$caddyfile"
  remove_domain_from_main_caddyfile "$domain" "$caddyfile"
  run_root mkdir -p /etc/caddy/conf.d
  write_caddy_site_config "$domain" "$canvas_caddyfile"
  if [[ ! -f "$caddyfile" ]]; then
    printf '%s\n' "$include_line" | run_root tee "$caddyfile" >/dev/null
  elif ! grep -Fxq "$include_line" "$caddyfile"; then
    printf '\n%s\n' "$include_line" | run_root tee -a "$caddyfile" >/dev/null
  fi
  if command -v caddy >/dev/null 2>&1; then
    if ! run_root caddy validate --config "$caddyfile" 2>&1; then
      warn "Caddyfile validation failed — check your Caddy config manually."
      warn "Run: sudo caddy validate --config ${caddyfile}"
      return 0
    fi
  fi
  if ! run_root systemctl reload caddy 2>&1 && ! run_root systemctl restart caddy 2>&1; then
    warn "Could not reload or restart Caddy. Check: sudo systemctl status caddy"
  fi
  ok "Caddy synced for https://${domain}"
}

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
    local escaped_domain
    escaped_domain="$(printf '%s' "$domain" | sed 's/[.[\*^$]/\\&/g')"
    if grep -qE '^:[0-9]+[[:space:]]*\{' "$caddyfile" 2>/dev/null; then
      info "Removing default site from ${caddyfile}"
      remove_default_caddy_site "$caddyfile"
      fixed_something=true
    fi
    if grep -q "^${escaped_domain}[[:space:]]*{" "$caddyfile" 2>/dev/null; then
      info "Removing duplicate domain definition from ${caddyfile}"
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

  if ! run_root systemctl reload caddy 2>&1 && ! run_root systemctl restart caddy 2>&1; then
    warn "Could not reload or restart Caddy. Check: sudo systemctl status caddy"
  fi

  if [[ "$fixed_something" == "true" ]]; then
    ok "Caddy configuration fixed and reloaded"
  else
    ok "Caddy configuration is already correct — no changes needed"
  fi
}