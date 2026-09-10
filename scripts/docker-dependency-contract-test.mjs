import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

assert.match(dockerfile, /RUN npm ci --force --loglevel=warn/);
assert.doesNotMatch(dockerfile, /npm ci[^\n]*--legacy-peer-deps/);
assert.match(dockerfile, /RUN npm prune --omit=dev --force --ignore-scripts/);
assert.doesNotMatch(dockerfile, /npm install tsx/);
assert.ok(manifest.dependencies.tsx, 'tsx must survive production pruning');
assert.ok(!lockfile.packages['node_modules/tsx'].dev);
assert.match(dockerfile, /node --import tsx -e/);
assert.ok(dockerfile.indexOf('RUN npm run build') < dockerfile.indexOf('RUN npm prune'));
assert.match(dockerfile, /sharp-runtime-linkage-test\.mjs/);
console.log('Docker dependency contract: complete locked peers, runtime tsx and preserved native build checks passed.');
