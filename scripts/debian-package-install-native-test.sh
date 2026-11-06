#!/bin/sh
set -eu

# Run only in a disposable digest-pinned Debian base, never on the host.
test "$(id -u)" = 0
test -f /.dockerenv
scripts=/usr/local/libexec/canvas-debian
node "$scripts/debian-repository-lock.mjs" prepare
apt-get update

# Exercise the actual metadata verification again with every network protocol
# pointed at an unreachable port. The build mirror must be sufficient.
apt-get -o Acquire::http::Proxy=http://127.0.0.1:9 -o Acquire::https::Proxy=http://127.0.0.1:9 update
node "$scripts/debian-package-install.mjs" ca-certificates libexif12 libjsoncpp25
dpkg-query -W ca-certificates libexif12 libjsoncpp25

# Authentication must remain fail-closed even after a previous successful update.
release=$(find /var/lib/apt/lists -maxdepth 1 -name '*bookworm_InRelease' -print)
test -n "$release"
cp "$release" /tmp/canvas-original-InRelease
printf '\ntampered\n' >> "$release"
if node "$scripts/debian-package-install.mjs" zstd > /tmp/canvas-release-rejection.log 2>&1; then
  echo 'Tampered InRelease was accepted' >&2
  exit 1
fi
grep -q 'InRelease SHA256 differs' /tmp/canvas-release-rejection.log
cp /tmp/canvas-original-InRelease "$release"

architecture=$(dpkg --print-architecture)
index=$(find /var/lib/apt/lists -maxdepth 1 -name "*bookworm_main_binary-${architecture}_Packages*" -print)
test -n "$index"
cp "$index" /tmp/canvas-original-Packages
/usr/lib/apt/apt-helper cat-file "$index" > /tmp/canvas-tampered-Packages
printf '\nPackage: canvas-tampered-index\n' >> /tmp/canvas-tampered-Packages
plain_index=${index%.lz4}
plain_index=${plain_index%.xz}
plain_index=${plain_index%.gz}
rm "$index"
cp /tmp/canvas-tampered-Packages "$plain_index"
if node "$scripts/debian-package-install.mjs" zstd > /tmp/canvas-index-rejection.log 2>&1; then
  echo 'Tampered Packages was accepted' >&2
  exit 1
fi
grep -q 'Cached APT package index changed' /tmp/canvas-index-rejection.log
rm "$plain_index"
cp /tmp/canvas-original-Packages "$index"

# Re-run a derived stage after the same lists cleanup used by the Dockerfile.
rm -rf /var/lib/apt/lists/*
apt-get update
node "$scripts/debian-package-install.mjs" zstd

# Exercise the Dockerfile's exact hash-pinned PGDG block with APT downloads
# disabled. netbase is a direct client-common dependency that APT previously
# fetched implicitly. The other libraries are supplied by the runtime packages.
node "$scripts/debian-package-install.mjs" netbase sensible-utils perl curl libreadline8 liblz4-1 libzstd1 libpq5
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const dockerfile = fs.readFileSync('/tmp/canvas-debian-Dockerfile', 'utf8');
const start = dockerfile.indexOf('  case "$(dpkg --print-architecture)" in');
const end = dockerfile.indexOf('  rm -f /tmp/*.deb;', start);
assert(start > 0 && end > start);
const argumentsText = ['POSTGRES_CLIENT_VERSION', 'POSTGRES_COMMON_VERSION'].map(name => {
  const value = dockerfile.match(new RegExp(`^ARG ${name}=([^\\n]+)$`, 'mu'))?.[1];
  assert.match(value ?? '', /^[a-zA-Z0-9.+~-]+$/u);
  return `${name}='${value}'`;
}).join('\n');
const commands = dockerfile.slice(start, end).replaceAll('\\\n', '');
assert(commands.includes('apt-get --no-download install'));
fs.writeFileSync('/tmp/canvas-pgdg-install.sh', `set -eu\n${argumentsText}\n${commands}\n`, { flag: 'wx', mode: 0o600 });
NODE
sh /tmp/canvas-pgdg-install.sh
pg_dump --version | grep '18.4'
node "$scripts/debian-repository-lock.mjs" configure
rm -rf /usr/local/share/canvas-debian-snapshot
grep -q 'URIs: https://snapshot.debian.org/' /etc/apt/sources.list.d/debian.sources
printf 'VERIFIED_FROZEN_APT_NATIVE_TEST_PASSED %s\n' "$architecture"
