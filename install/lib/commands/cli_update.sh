#!/usr/bin/env bash

cmd_cli_update() {
  log_msg "cli-update started"
  local tmp_installer
  tmp_installer="$(mktemp /tmp/canvas-notebook-install.XXXXXX.sh)"
  info "Downloading latest installer from GitHub..."
  if ! curl -fsSL "$INSTALL_SCRIPT_URL" -o "$tmp_installer"; then
    rm -f "$tmp_installer"
    fail "Failed to download installer from $INSTALL_SCRIPT_URL"
  fi
  chmod +x "$tmp_installer"
  info "Installing updated CLI and systemd service..."
  if CLI_UPDATE_ONLY=true bash "$tmp_installer"; then
    rm -f "$tmp_installer"
    ok "Canvas Notebook management CLI updated successfully"
    log_msg "cli-update completed"
  else
    rm -f "$tmp_installer"
    fail "CLI update failed — previous version is still in place"
  fi
  info "Running Caddy configuration health fix..."
  caddy_fix || true
}