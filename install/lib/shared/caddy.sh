#!/usr/bin/env bash
# Shared Caddy utility functions for Canvas Notebook CLI and installer.
# Sourced by both install/bin/canvas-notebook and install/lib/caddy.sh

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