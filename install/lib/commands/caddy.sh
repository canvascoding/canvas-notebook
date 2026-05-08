#!/usr/bin/env bash

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
  config_json_to_env
  sync_caddy
}

cmd_caddy_fix() {
  caddy_fix
}