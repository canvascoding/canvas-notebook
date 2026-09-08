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
  local proxy_token="" internal_key=""
  local preview_origin=""
  if declare -F config_json_read >/dev/null; then
    internal_key="$(config_json_read env.CANVAS_INTERNAL_API_KEY 2>/dev/null || true)"
    preview_origin="$(config_json_read env.CANVAS_HTML_PREVIEW_ORIGIN 2>/dev/null || true)"
  fi
  preview_origin="${preview_origin:-https://preview.$domain}"
  preview_origin="$(CANVAS_PREVIEW_SITE="$preview_origin" CANVAS_PREVIEW_APP_HOST="$domain" python3 - <<'PY'
import os,re,urllib.parse
value=urllib.parse.urlsplit(os.environ['CANVAS_PREVIEW_SITE'])
host=value.hostname or ''
assert value.scheme=='https' and not value.username and not value.password
assert value.path in ('','/') and not value.query and not value.fragment
assert host != os.environ['CANVAS_PREVIEW_APP_HOST'] and len(host)<=253
assert re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',host)
port=value.port
assert port is None or 1<=port<=65535
print('https://'+host+(':'+str(port) if port and port!=443 else ''))
PY
  )" || return 1
  if [[ ${#internal_key} -ge 32 ]]; then
    proxy_token="$(CANVAS_PROXY_DERIVATION_KEY="$internal_key" python3 -c 'import hashlib,hmac,os; print(hmac.new(os.environ["CANVAS_PROXY_DERIVATION_KEY"].strip().encode(), b"canvas-notebook/proxy-client-address/v1", hashlib.sha256).hexdigest())')" || return 1
  fi
  printf '%s {\n    handle /__canvas-host/operations/* {\n        @not_read not method GET\n        respond @not_read 405\n        reverse_proxy 127.0.0.1:3457\n    }\n    handle /__canvas-host/* {\n        respond 404\n    }\n    handle {\n        reverse_proxy localhost:3456 {\n            header_up X-Forwarded-Port 443\n' "$domain"
  if [[ -n "$proxy_token" ]]; then
    printf '            header_up X-Canvas-Proxy-Token %s\n            header_up X-Canvas-Proxy-Client-IP {remote_host}\n' "$proxy_token"
  else
    printf '            header_up -X-Canvas-Proxy-Token\n            header_up -X-Canvas-Proxy-Client-IP\n'
  fi
  printf '        }\n    }\n}\n'
  printf '\n%s {\n    @preview {\n        method GET HEAD\n        path /__preview/*\n    }\n    handle @preview {\n        reverse_proxy localhost:3456 {\n            header_up -Cookie\n            header_up -Authorization\n            header_up -Proxy-Authorization\n            header_down -Set-Cookie\n            header_down -X-Frame-Options\n' "$preview_origin"
  if [[ -n "$proxy_token" ]]; then
    printf '            header_up X-Canvas-Proxy-Token %s\n            header_up X-Canvas-Proxy-Client-IP {remote_host}\n' "$proxy_token"
  else
    printf '            header_up -X-Canvas-Proxy-Token\n            header_up -X-Canvas-Proxy-Client-IP\n'
  fi
  printf '        }\n    }\n    handle {\n        respond 404\n    }\n}\n'
}

write_caddy_config() {
  local domain="$1"
  local tmp
  tmp="$(mktemp)"
  if ! caddy_site_block "$domain" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  run_root mkdir -p "$(dirname "$CADDYFILE")"
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

  if ! command -v caddy >/dev/null 2>&1; then
    info "Caddy is not installed; skipping Caddy sync."
    return 0
  fi

  info "Writing Caddy config for ${domain}..."
  write_caddy_config "$domain" || return 1

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

  if ! command -v caddy >/dev/null 2>&1; then
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
      current_block="$(cat "$CADDYFILE" 2>/dev/null)"
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
