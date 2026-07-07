#!/usr/bin/env bash
# macOS installer for the portable Canvas Notebook server CLI.
# Works from a repository checkout, from the packaged CLI bundle, or via:
#   curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/macos.sh | bash

set -euo pipefail

REPO="${CANVAS_REPO:-canvascoding/canvas-notebook}"
VERSION="${CANVAS_VERSION:-${CANVAS_CLI_VERSION:-latest}}"
CLI_ASSET_NAME="canvas-notebook-cli.tar.gz"
CHECKSUM_ASSET_NAME="canvas-notebook-cli.sha256"
CLI_INSTALL_DIR="${CANVAS_CLI_INSTALL_DIR:-${HOME}/Library/Application Support/Canvas Notebook/cli}"
BIN_DIR="${CANVAS_CLI_BIN_DIR:-${HOME}/.local/bin}"
BIN_PATH="${BIN_DIR}/canvas-notebook"
NODE_INSTALL_DIR="${CANVAS_NODE_INSTALL_DIR:-${HOME}/.local/share/canvas-notebook/node}"
AUTO_INSTALL_DEPS="${CANVAS_AUTO_INSTALL_DEPS:-true}"
ORIGINAL_PATH="$PATH"

say() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

download_file() {
  local url="$1"
  local output="$2"
  if ! has_command curl; then
    fail "curl is required to download ${url}"
  fi
  curl -fL --retry 3 --connect-timeout 20 -o "$output" "$url"
}

asset_url() {
  local asset="$1"
  if [[ -n "${CANVAS_CLI_BASE_URL:-}" ]]; then
    printf '%s/%s' "${CANVAS_CLI_BASE_URL%/}" "$asset"
  elif [[ -n "${CANVAS_CLI_URL:-}" && "$asset" == "$CLI_ASSET_NAME" ]]; then
    printf '%s' "$CANVAS_CLI_URL"
  elif [[ -n "${CANVAS_CLI_SHA256_URL:-}" && "$asset" == "$CHECKSUM_ASSET_NAME" ]]; then
    printf '%s' "$CANVAS_CLI_SHA256_URL"
  elif [[ "$VERSION" == "latest" || -z "$VERSION" ]]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$asset"
  else
    printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "${VERSION#refs/tags/}" "$asset"
  fi
}

detect_local_root() {
  local script_path="${BASH_SOURCE[0]:-}"
  local script_dir
  local candidate

  if [[ -z "$script_path" || ! -f "$script_path" ]]; then
    return 1
  fi

  script_dir="$(cd -- "$(dirname -- "$script_path")" >/dev/null 2>&1 && pwd -P)" || return 1
  candidate="$(cd -- "${script_dir}/.." >/dev/null 2>&1 && pwd -P)" || return 1

  if [[ -f "${candidate}/dist-cli/main.js" || -f "${candidate}/package.json" ]]; then
    printf '%s' "$candidate"
    return 0
  fi

  return 1
}

verify_checksum() {
  local archive="$1"
  local checksum_file="$2"
  if ! has_command shasum; then
    say "shasum not found; skipping CLI checksum verification."
    return 0
  fi
  (cd "$(dirname "$archive")" && shasum -a 256 -c "$(basename "$checksum_file")" >&2)
}

download_cli_bundle() {
  local tmp_dir
  local archive
  local checksum_file
  local root_dir

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/canvas-cli.XXXXXX")"
  archive="${tmp_dir}/${CLI_ASSET_NAME}"
  checksum_file="${tmp_dir}/${CHECKSUM_ASSET_NAME}"

  say "Downloading Canvas Notebook CLI bundle..."
  download_file "$(asset_url "$CLI_ASSET_NAME")" "$archive"
  download_file "$(asset_url "$CHECKSUM_ASSET_NAME")" "$checksum_file"
  verify_checksum "$archive" "$checksum_file"

  mkdir -p "$CLI_INSTALL_DIR"
  rm -rf "${CLI_INSTALL_DIR}/canvas-notebook-cli"
  tar -xzf "$archive" -C "$CLI_INSTALL_DIR"

  root_dir="${CLI_INSTALL_DIR}/canvas-notebook-cli"
  [[ -f "${root_dir}/dist-cli/main.js" ]] || fail "Downloaded CLI bundle is missing dist-cli/main.js"
  printf '%s' "$root_dir"
}

node_arch() {
  case "$(uname -m)" in
    arm64) printf 'arm64' ;;
    x86_64) printf 'x64' ;;
    *) fail "Unsupported macOS architecture: $(uname -m)" ;;
  esac
}

install_node_direct() {
  local arch
  local tmp_dir
  local shasums
  local package_name
  local archive
  local expected
  local actual

  arch="$(node_arch)"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/canvas-node.XXXXXX")"
  shasums="${tmp_dir}/SHASUMS256.txt"

  say "Downloading Node.js latest v22.x for macOS ${arch}..."
  download_file "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" "$shasums"
  package_name="$(awk -v arch="$arch" '$2 ~ ("node-v.*-darwin-" arch "\\.tar\\.gz") { print $2; exit }' "$shasums")"
  [[ -n "$package_name" ]] || fail "Could not resolve Node.js package for macOS ${arch}"

  archive="${tmp_dir}/${package_name}"
  download_file "https://nodejs.org/dist/latest-v22.x/${package_name}" "$archive"
  expected="$(awk -v file="$package_name" '$2 == file { print $1; exit }' "$shasums")"
  actual="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
  [[ "$expected" == "$actual" ]] || fail "Node.js checksum verification failed"

  rm -rf "$NODE_INSTALL_DIR"
  mkdir -p "$NODE_INSTALL_DIR"
  tar -xzf "$archive" -C "$NODE_INSTALL_DIR" --strip-components 1
  export PATH="${NODE_INSTALL_DIR}/bin:${PATH}"
}

ensure_node() {
  if has_command node; then
    return 0
  fi

  if [[ "$AUTO_INSTALL_DEPS" == "false" ]]; then
    fail "Node.js is required. Install Node.js or unset CANVAS_AUTO_INSTALL_DEPS=false."
  fi

  if has_command brew; then
    say "Installing Node.js with Homebrew..."
    brew install node
  else
    install_node_direct
  fi

  has_command node || fail "Node.js installation did not add node to PATH"
}

docker_app_path() {
  if [[ -d "/Applications/Docker.app" ]]; then
    printf '/Applications/Docker.app'
  elif [[ -d "${HOME}/Applications/Docker.app" ]]; then
    printf '%s/Applications/Docker.app' "$HOME"
  fi
}

add_docker_cli_to_path() {
  local app_path
  app_path="$(docker_app_path || true)"
  if [[ -n "$app_path" && -x "${app_path}/Contents/Resources/bin/docker" ]]; then
    export PATH="${app_path}/Contents/Resources/bin:${PATH}"
  fi
}

docker_ready() {
  add_docker_cli_to_path
  has_command docker && docker info >/dev/null 2>&1
}

install_docker_direct() {
  local arch
  local tmp_dir
  local dmg
  local mount_path
  local target_dir
  local attach_output

  case "$(uname -m)" in
    arm64) arch="arm64" ;;
    x86_64) arch="amd64" ;;
    *) fail "Unsupported macOS architecture for Docker Desktop: $(uname -m)" ;;
  esac

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/canvas-docker.XXXXXX")"
  dmg="${tmp_dir}/Docker.dmg"
  say "Downloading Docker Desktop for macOS ${arch}..."
  download_file "https://desktop.docker.com/mac/main/${arch}/Docker.dmg" "$dmg"

  attach_output="$(hdiutil attach -nobrowse -quiet "$dmg")"
  mount_path="$(printf '%s\n' "$attach_output" | awk '/\/Volumes\// { print substr($0, index($0, "/Volumes/")); exit }')"
  [[ -n "$mount_path" && -d "${mount_path}/Docker.app" ]] || fail "Could not mount Docker Desktop DMG"

  if [[ -w "/Applications" ]]; then
    target_dir="/Applications"
  else
    target_dir="${HOME}/Applications"
    mkdir -p "$target_dir"
  fi

  rm -rf "${target_dir}/Docker.app"
  cp -R "${mount_path}/Docker.app" "$target_dir/"
  hdiutil detach "$mount_path" -quiet || true
}

ensure_docker_desktop() {
  if docker_ready; then
    return 0
  fi

  if [[ -z "$(docker_app_path || true)" ]]; then
    if [[ "$AUTO_INSTALL_DEPS" == "false" ]]; then
      fail "Docker Desktop is required. Install Docker Desktop or unset CANVAS_AUTO_INSTALL_DEPS=false."
    fi

    if has_command brew; then
      say "Installing Docker Desktop with Homebrew..."
      brew install --cask docker
    else
      install_docker_direct
    fi
  fi

  add_docker_cli_to_path
  local app_path
  app_path="$(docker_app_path || true)"
  [[ -n "$app_path" ]] || fail "Docker Desktop is installed but Docker.app was not found"

  say "Starting Docker Desktop..."
  open "$app_path" >/dev/null 2>&1 || open -a Docker >/dev/null 2>&1 || true

  local attempt=0
  while [[ "$attempt" -lt "${CANVAS_DOCKER_WAIT_ATTEMPTS:-90}" ]]; do
    if docker_ready; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  fail "Docker Desktop is not reachable. Start Docker Desktop and re-run this installer."
}

ensure_cli_root() {
  local local_root
  local_root="$(detect_local_root || true)"

  if [[ -n "$local_root" ]]; then
    if [[ ! -f "${local_root}/dist-cli/main.js" ]]; then
      has_command npm || fail "npm is required to build the local portable CLI"
      (cd "$local_root" && npm run cli:build >&2)
    fi
    printf '%s' "$local_root"
    return 0
  fi

  download_cli_bundle
}

install_wrapper() {
  local main_js="$1"
  local node_bin
  node_bin="$(command -v node)"

  mkdir -p "$BIN_DIR"
  cat > "$BIN_PATH" <<EOF
#!/usr/bin/env sh
exec "${node_bin}" "${main_js}" "\$@"
EOF
  chmod +x "$BIN_PATH"
  export PATH="${BIN_DIR}:${PATH}"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "This installer is for macOS only."
fi

ensure_node
ensure_docker_desktop

ROOT_DIR="$(ensure_cli_root)"
MAIN_JS="${ROOT_DIR}/dist-cli/main.js"
[[ -f "$MAIN_JS" ]] || fail "Portable CLI entrypoint not found: ${MAIN_JS}"

install_wrapper "$MAIN_JS"

say "Installed CLI wrapper: ${BIN_PATH}"
if [[ ":${ORIGINAL_PATH}:" != *":${BIN_DIR}:"* ]]; then
  say "Add this directory to PATH if your shell cannot find canvas-notebook: ${BIN_DIR}"
fi

export CANVAS_CLI_PATH="$BIN_PATH"
"$(command -v node)" "$MAIN_JS" install

if [[ "${CANVAS_INSTALL_SERVICE:-true}" != "false" ]]; then
  "$(command -v node)" "$MAIN_JS" service install
fi

if [[ "${CANVAS_OPEN_BROWSER:-true}" != "false" ]]; then
  open "http://localhost:3456" >/dev/null 2>&1 || true
fi

say
say "Canvas Notebook is available at http://localhost:3456"
