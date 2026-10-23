// Explicitly unexercised Auth seam for the direct path service unit fixture only.
// The real service, plan, scope, error classes and every assertion stay imported.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import Module from 'node:module';

assert.equal(process.env.NODE_ENV, 'test', 'The path-service Auth preload is test-only.');
assert.equal(path.resolve(process.argv[1] ?? ''),
  fileURLToPath(new URL('../workspace-path-operation-service-test.ts', import.meta.url)),
  'The Auth seam is confined to the declared path-service unit entrypoint.');

function workspacePathServiceUnitAuthBoundary() {
  throw new Error('The path-service unit fixture must not access real Auth; use the genuine principal/HTTP suites for authorization.');
}

const auth = new Proxy(Object.freeze(Object.create(null)), {
  get: workspacePathServiceUnitAuthBoundary,
  set: workspacePathServiceUnitAuthBoundary,
  has: workspacePathServiceUnitAuthBoundary,
  ownKeys: workspacePathServiceUnitAuthBoundary,
  getOwnPropertyDescriptor: workspacePathServiceUnitAuthBoundary,
  defineProperty: workspacePathServiceUnitAuthBoundary,
  deleteProperty: workspacePathServiceUnitAuthBoundary,
  getPrototypeOf: workspacePathServiceUnitAuthBoundary,
  setPrototypeOf: workspacePathServiceUnitAuthBoundary,
});

// Resolve the same canonical local module for ESM and TSX's CommonJS require.
// The mock is installed as a Node preload before the test's static graph loads.
mock.module(new URL('../../app/lib/auth.ts', import.meta.url), {
  cache: true,
  namedExports: { auth },
});

// Auth is not the only import path into PI: the real planner reaches the
// runtime catalog through checkpoint/public-share/request-principal modules.
// Mirror workspace-tree-native-test's actual ESM-to-CJS bridge, restricted to
// the sole PI value import reachable by this unit's static application graph.
const actualPiCompat = await import('@earendil-works/pi-ai/compat');
const originalLoad = Module._load;
function workspacePathServiceUnitActualEsmBridge(request, ...args) {
  if (request === '@earendil-works/pi-ai/compat') return actualPiCompat;
  return Reflect.apply(originalLoad, this, [request, ...args]);
}
Module._load = workspacePathServiceUnitActualEsmBridge;
