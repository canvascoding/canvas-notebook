import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const dbIndexSource = await readFile(new URL('../app/lib/db/index.ts', import.meta.url), 'utf8');

const polyfillIndex = serverSource.indexOf("globalThis.AsyncLocalStorage = AsyncLocalStorage");
const nextImportIndex = serverSource.indexOf("const next = require('next')");
const postgresMigrationFunctionIndex = serverSource.indexOf('async function runStartupDatabaseMigrations()');
const postgresMigrationAwaitIndex = serverSource.indexOf('await runStartupDatabaseMigrations()');
const websocketStartupIndex = serverSource.indexOf("console.log('[Startup] Initializing WebSocket Server...')");
const agentRuntimeWarmupIndex = serverSource.indexOf('preloadAgentRuntimeModules()');
const managedCatalogWarmupIndex = serverSource.indexOf('primeCanvasControlPlaneCatalog()');
const nextPrepareIndex = serverSource.indexOf('app.prepare(),');

assert.notEqual(polyfillIndex, -1, 'server.js must polyfill globalThis.AsyncLocalStorage');
assert.notEqual(nextImportIndex, -1, 'server.js must import next');
assert.notEqual(postgresMigrationFunctionIndex, -1, 'server.js must define startup database migrations');
assert.notEqual(postgresMigrationAwaitIndex, -1, 'server.js must await startup database migrations');
assert.notEqual(websocketStartupIndex, -1, 'server.js must initialize websocket startup after migrations');
assert.notEqual(agentRuntimeWarmupIndex, -1, 'server.js must preload agent runtime modules');
assert.notEqual(managedCatalogWarmupIndex, -1, 'server.js must prime the managed model catalog');
assert.notEqual(nextPrepareIndex, -1, 'server.js must await Next preparation with runtime warmup');
assert.ok(
  polyfillIndex < nextImportIndex,
  'server.js must polyfill globalThis.AsyncLocalStorage before importing next',
);
assert.ok(
  postgresMigrationFunctionIndex < postgresMigrationAwaitIndex,
  'server.js must define startup database migrations before awaiting them',
);
assert.ok(
  postgresMigrationAwaitIndex < websocketStartupIndex,
  'server.js must await startup database migrations before runtime modules touch the DB',
);
assert.ok(
  websocketStartupIndex < agentRuntimeWarmupIndex && agentRuntimeWarmupIndex < nextPrepareIndex,
  'server.js must start runtime warmup after websocket initialization and await it before readiness',
);
assert.ok(
  agentRuntimeWarmupIndex < managedCatalogWarmupIndex && managedCatalogWarmupIndex < nextPrepareIndex,
  'server.js must start managed catalog warmup with local runtime warmup and await both before readiness',
);
assert.ok(
  !dbIndexSource.includes('runPostgresMigrations'),
  'app/lib/db/index.ts must not start Postgres migrations from runtime imports',
);

console.log('next-startup-runtime-test: ok');
