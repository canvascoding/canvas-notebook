#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_TEMPLATE="${1:-}"
[[ "$(uname -s)" == "Linux" ]] || { printf 'linux-cli-installer-test requires Linux\n' >&2; exit 2; }
[[ -d "$PACKAGE_TEMPLATE" ]] || { printf 'Usage: linux-cli-installer-test.sh <package-root>\n' >&2; exit 2; }

case "$(uname -m)" in
  x86_64) architecture=amd64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) printf 'Unsupported Linux architecture: %s\n' "$(uname -m)" >&2; exit 2 ;;
esac

test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

make_fixture() {
  local version="$1" marker="$2" output="$3" package_name old_version fixture archive digest
  package_name="canvas-notebook-linux-cli-${architecture}"
  old_version="$(tr -d '\r\n' < "${PACKAGE_TEMPLATE}/VERSION")"
  fixture="${test_root}/${marker}/${package_name}"
  mkdir -p "$(dirname "$fixture")" "$output"
  cp -a "$PACKAGE_TEMPLATE" "$fixture"
  mv "${fixture}/releases/${old_version}" "${fixture}/releases/${version}"
  printf '%s\n' "$version" > "${fixture}/VERSION"
  printf '%s\n' "$version" > "${fixture}/state/current"
  : > "${fixture}/state/previous"
  printf '%s\n' "$version" > "${fixture}/releases/${version}/VERSION"
  cat > "${fixture}/releases/${version}/dist-cli/main.js" <<EOF
console.log(JSON.stringify({ cliVersion: ${version@Q}, cliGeneration: 'typescript', marker: ${marker@Q} }));
EOF
  "${fixture}/runtime/bin/node" -e '
    const fs = require("node:fs");
    const [file, version] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.cliVersion = version;
    manifest.activeRelease = `releases/${version}`;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "${fixture}/manifest.json" "$version"
  archive="${output}/${package_name}.tar.gz"
  tar -czf "$archive" -C "$(dirname "$fixture")" "$package_name"
  digest="$(sha256sum "$archive" | awk '{print $1}')"
  printf '%s  %s.tar.gz\n' "$digest" "$package_name" > "${output}/${package_name}.sha256"
}

install_fixture() {
  local assets="$1" cli_root="$2" bin_path="$3" package_name
  package_name="canvas-notebook-linux-cli-${architecture}"
  CANVAS_LINUX_CLI_ROOT="$cli_root" \
  CANVAS_LINUX_CLI_BIN_PATH="$bin_path" \
  CANVAS_LINUX_CLI_ARCHIVE="${assets}/${package_name}.tar.gz" \
  CANVAS_LINUX_CLI_CHECKSUM="${assets}/${package_name}.sha256" \
  bash "$ROOT/install/linux-cli.sh" install
}

assets_old="${test_root}/assets-old"
assets_new="${test_root}/assets-new"
make_fixture 2026.8.27 old "$assets_old"
make_fixture 2026.8.28 new "$assets_new"

cli_root="${test_root}/cli"
bin_path="${test_root}/bin/canvas-notebook"
mkdir -p "$(dirname "$bin_path")"
cat > "$bin_path" <<'EOF'
#!/usr/bin/env bash
printf 'legacy-cli\n'
EOF
chmod 755 "$bin_path"

install_fixture "$assets_old" "$cli_root" "$bin_path"
[[ "$("$bin_path" version --json | "${cli_root}/runtime/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).marker))')" == old ]]
[[ "$(tr -d '\r\n' < "${cli_root}/state/current")" == 2026.8.27 ]]
[[ -x "${cli_root}/legacy/canvas-notebook" ]]

install_fixture "$assets_new" "$cli_root" "$bin_path"
[[ "$(tr -d '\r\n' < "${cli_root}/state/current")" == 2026.8.28 ]]
[[ "$(tr -d '\r\n' < "${cli_root}/state/previous")" == 2026.8.27 ]]
[[ "$("$bin_path" version --json | "${cli_root}/runtime/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).marker))')" == new ]]
[[ ! -e "${cli_root}/legacy/canvas-notebook" ]]

CANVAS_LINUX_CLI_ROOT="$cli_root" CANVAS_LINUX_CLI_BIN_PATH="$bin_path" bash "$ROOT/install/linux-cli.sh" rollback
[[ "$(tr -d '\r\n' < "${cli_root}/state/current")" == 2026.8.27 ]]
[[ "$(tr -d '\r\n' < "${cli_root}/state/previous")" == 2026.8.28 ]]
[[ "$("$bin_path" version --json | "${cli_root}/runtime/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).marker))')" == old ]]

fresh_root="${test_root}/fresh-cli"
fresh_bin="${test_root}/fresh-bin/canvas-notebook"
mkdir -p "$(dirname "$fresh_bin")"
printf '#!/usr/bin/env bash\nprintf "fresh-legacy\\n"\n' > "$fresh_bin"
chmod 755 "$fresh_bin"
install_fixture "$assets_new" "$fresh_root" "$fresh_bin"
CANVAS_LINUX_CLI_ROOT="$fresh_root" CANVAS_LINUX_CLI_BIN_PATH="$fresh_bin" bash "$ROOT/install/linux-cli.sh" rollback
[[ "$("$fresh_bin")" == fresh-legacy ]]
[[ "$(tr -d '\r\n' < "${fresh_root}/state/legacy-active")" == legacy ]]

cp "${assets_new}/canvas-notebook-linux-cli-${architecture}.sha256" "${test_root}/bad.sha256"
printf '%064d  canvas-notebook-linux-cli-%s.tar.gz\n' 0 "$architecture" > "${test_root}/bad.sha256"
before="$(tr -d '\r\n' < "${cli_root}/state/current")"
if CANVAS_LINUX_CLI_ROOT="$cli_root" \
  CANVAS_LINUX_CLI_BIN_PATH="$bin_path" \
  CANVAS_LINUX_CLI_ARCHIVE="${assets_new}/canvas-notebook-linux-cli-${architecture}.tar.gz" \
  CANVAS_LINUX_CLI_CHECKSUM="${test_root}/bad.sha256" \
  bash "$ROOT/install/linux-cli.sh" install >/dev/null 2>&1; then
  printf 'Installer accepted a bad checksum\n' >&2
  exit 1
fi
[[ "$(tr -d '\r\n' < "${cli_root}/state/current")" == "$before" ]]

printf 'linux-cli-installer-test: ok (%s)\n' "$architecture"
