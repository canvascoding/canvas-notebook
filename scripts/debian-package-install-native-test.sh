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
if node "$scripts/debian-package-install.mjs" zstd; then
  echo 'Tampered InRelease was accepted' >&2
  exit 1
fi
cp /tmp/canvas-original-InRelease "$release"

architecture=$(dpkg --print-architecture)
index=$(find /var/lib/apt/lists -maxdepth 1 -name "*bookworm_main_binary-${architecture}_Packages*" -print)
test -n "$index"
cp "$index" /tmp/canvas-original-Packages
printf '\ntampered\n' >> "$index"
if node "$scripts/debian-package-install.mjs" zstd; then
  echo 'Tampered Packages was accepted' >&2
  exit 1
fi
cp /tmp/canvas-original-Packages "$index"

# Re-run a derived stage after the same lists cleanup used by the Dockerfile.
rm -rf /var/lib/apt/lists/*
apt-get update
node "$scripts/debian-package-install.mjs" zstd
node "$scripts/debian-repository-lock.mjs" configure
rm -rf /usr/local/share/canvas-debian-snapshot
grep -q 'URIs: https://snapshot.debian.org/' /etc/apt/sources.list.d/debian.sources
printf 'VERIFIED_FROZEN_APT_NATIVE_TEST_PASSED %s\n' "$architecture"
