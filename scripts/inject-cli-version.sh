#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
sed -i.bak -E "s/CANVAS_CLI_VERSION=\"[^\"]*\"/CANVAS_CLI_VERSION=\"${VERSION}\"/" "$ROOT/install/bin/canvas-notebook"
rm -f "$ROOT/install/bin/canvas-notebook.bak"
sed -i.bak "s/__CANVAS_CLI_VERSION__/${VERSION}/g" "$ROOT/install/lib/shared/output.sh"
rm -f "$ROOT/install/lib/shared/output.sh.bak"
printf 'Injected CLI version: %s\n' "$VERSION"
