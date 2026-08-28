#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(uname -s)" == "Linux" ]] || {
  printf 'linux-cli-package-integration-test requires Linux\n' >&2
  exit 2
}
command -v curl >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || {
  printf 'curl, sha256sum and jq are required\n' >&2
  exit 2
}

case "$(uname -m)" in
  x86_64) canvas_arch=amd64; node_arch=x64 ;;
  aarch64|arm64) canvas_arch=arm64; node_arch=arm64 ;;
  *) printf 'Unsupported Linux architecture: %s\n' "$(uname -m)" >&2; exit 2 ;;
esac

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
curl -fsSL --retry 3 -o "$test_root/SHASUMS256.txt" https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
node_package="$(awk -v arch="$node_arch" '$2 ~ ("^node-v.*-linux-" arch "\\.tar\\.gz$") { print $2; exit }' "$test_root/SHASUMS256.txt")"
[[ -n "$node_package" ]] || { printf 'Official Node.js Linux package was not found\n' >&2; exit 1; }
curl -fsSL --retry 3 -o "$test_root/$node_package" "https://nodejs.org/dist/latest-v22.x/$node_package"
(cd "$test_root" && grep "  $node_package$" SHASUMS256.txt | sha256sum -c - >/dev/null)
mkdir "$test_root/node"
tar -xzf "$test_root/$node_package" -C "$test_root/node" --strip-components 1

CANVAS_LINUX_CLI_ARCH="$canvas_arch" \
CANVAS_LINUX_CLI_NODE_BINARY="$test_root/node/bin/node" \
CANVAS_LINUX_CLI_SKIP_BUILD=true \
node "$ROOT/scripts/package-linux-cli.mjs" >/dev/null

package_root="$ROOT/dist-linux-cli/$canvas_arch/canvas-notebook-linux-cli-$canvas_arch"
launcher="$package_root/bin/canvas-notebook"
jq -e --arg arch "$canvas_arch" '.platform == "linux" and .architecture == $arch and .runtimeValidated == true' "$package_root/manifest.json" >/dev/null
if ldd "$package_root/runtime/bin/node" | grep -q 'libnode'; then
  printf 'Bundled Node.js unexpectedly depends on a host libnode\n' >&2
  exit 1
fi
version_json="$(CANVAS_INSTALL_DIR="$test_root/install" CANVAS_DATA_DIR="$test_root/data" "$launcher" version --json)"
jq -e '.cliGeneration == "typescript" and (.cliVersion | length > 0)' <<<"$version_json" >/dev/null
bash "$ROOT/scripts/linux-cli-installer-test.sh" "$package_root"

printf 'linux-cli-package-integration-test: ok (%s, %s)\n' "$canvas_arch" "$("$package_root/runtime/bin/node" --version)"
