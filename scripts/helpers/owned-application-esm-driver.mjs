// Genuine SDK namespaces for the three declared raw test drivers only.
// Mirrors workspace-tree-native-test; no Auth or application module is mocked.
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.resolve(process.argv[1] ?? '');
const guestDrivers = new Set([
  path.join(root, 'scripts/collaboration-guest-challenge-driver.ts'),
  path.join(root, 'scripts/owned-file-guest-challenge-driver.ts'),
]);
const storageDriver = path.join(root, 'scripts/owned-yjs-authority-storage-read.ts');
assert.equal(path.resolve(process.cwd()), path.resolve(root));
assert(guestDrivers.has(entry) || entry === storageDriver, 'The real ESM bridge is confined to its declared raw drivers.');
assert(process.execArgv.includes('--conditions=react-server'));
if (guestDrivers.has(entry)) assert.equal(process.env.COLLABORATION_E2E, '1');
else assert.equal(process.env.CANVAS_YJS_AUTHORITY_E2E, '1');

// Await real ESM namespaces before tsx evaluates application files as CommonJS.
const actualEsm = new Map();
const originalLoad = Module._load;
for (const name of ['@earendil-works/pi-ai/compat', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core']) {
  actualEsm.set(name, await import(name));
}
function ownedDriverActualEsmBridge(request, ...args) {
  if (actualEsm.has(request)) return actualEsm.get(request);
  return Reflect.apply(originalLoad, this, [request, ...args]);
}
// The bridge exists only in this dedicated one-shot child; retain its original exit.
Module._load = ownedDriverActualEsmBridge;
