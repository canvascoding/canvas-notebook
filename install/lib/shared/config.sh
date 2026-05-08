#!/usr/bin/env bash
# Config management redirects to config_json.sh for backward compatibility.
# Any code sourcing config.sh will get config_json.sh instead.

# shellcheck source=lib/shared/config_json.sh
. "${SHARED_DIR}/config_json.sh"