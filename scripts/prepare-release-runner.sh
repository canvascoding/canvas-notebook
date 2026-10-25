#!/usr/bin/env bash
set -euo pipefail

# This may remove preinstalled SDKs and create swap. Never run it on a developer
# machine or a persistent self-hosted runner.
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${CANVAS_RELEASE_RUNNER_ENVIRONMENT:-}" != "github-hosted" || "$(uname -s)" != "Linux" ]]; then
  echo "Release runner preparation requires an ephemeral GitHub-hosted Linux runner." >&2
  exit 1
fi

swap_file="${RUNNER_TEMP:?RUNNER_TEMP must be set}/canvas-release.swap"
# The cold compiler has exceeded 34 GiB of RAM plus swap. Keep enough bounded
# headroom for its peak without depending on the runner's incidental swap size.
swap_gib=32
workspace_gib=14
required_kib=$(((swap_gib + workspace_gib) * 1024 * 1024))

available_kib() {
  df -Pk "$RUNNER_TEMP" | awk 'END { print $4 }'
}

echo "Release runner resources before preparation:"
df -h "$RUNNER_TEMP"
free -h

if [[ -e "$swap_file" ]]; then
  echo "Refusing to overwrite an existing release swap file: $swap_file" >&2
  exit 1
fi

# The application build needs Node/Python. Android, .NET, Haskell and CodeQL
# SDKs are unused by this job. Remove only large SDKs, only until enough free
# space remains for the swap file plus the dependency/build/artifact workspace.
unused_sdks=(
  /usr/local/lib/android
  /usr/share/dotnet
  /opt/ghc
  /usr/local/.ghcup
  /opt/hostedtoolcache/CodeQL
)
for sdk in "${unused_sdks[@]}"; do
  if (( $(available_kib) >= required_kib )); then break; fi
  if [[ ! -d "$sdk" ]]; then continue; fi
  sdk_kib="$(sudo du -sk "$sdk" | awk '{ print $1 }')"
  if (( sdk_kib < 512 * 1024 )); then continue; fi
  printf 'Removing unused hosted-runner SDK %s (%s MiB).\n' "$sdk" "$((sdk_kib / 1024))"
  sudo rm -rf -- "$sdk"
done

if (( $(available_kib) < required_kib )); then
  echo "Insufficient free disk for ${swap_gib} GiB swap and ${workspace_gib} GiB build workspace." >&2
  df -h "$RUNNER_TEMP"
  exit 1
fi

sudo install -m 600 /dev/null "$swap_file"
sudo fallocate -l "${swap_gib}G" "$swap_file"
sudo mkswap "$swap_file"
sudo swapon "$swap_file"

echo "Release runner resources after preparation:"
df -h "$RUNNER_TEMP"
free -h
