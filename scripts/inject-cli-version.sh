#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
VERSION="$(node -e "console.log(require('$ROOT/package.json').version)")"
sed -i.bak "s/__CANVAS_CLI_VERSION__/${VERSION}/g" "$ROOT/install/lib/shared/output.sh"
rm -f "$ROOT/install/lib/shared/output.sh.bak"
printf 'Injected CLI version: %s\n' "$VERSION"