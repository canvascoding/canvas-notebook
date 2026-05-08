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

write_caddy_site_config() {
  local domain="$1" canvas_caddyfile="$2"
  printf '%s {\n    reverse_proxy localhost:3456 {\n        header_up X-Forwarded-Port 443\n    }\n}\n' "$domain" | run_root tee "$canvas_caddyfile" >/dev/null
}

sync_caddy_from_compose() {
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
  run_root systemctl reload caddy >/dev/null 2>&1 || run_root systemctl restart caddy >/dev/null 2>&1 || warn "Could not reload Caddy."
  ok "Caddy synced for https://${domain}"
}