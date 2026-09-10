import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-pi-server-import-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
const testDatabase = await createPiTestDatabase();
const moduleInternals = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown; _resolveFilename: unknown };
const originalLoad = moduleInternals._load;
const originalResolveFilename = moduleInternals._resolveFilename;
// Execute the exact resolver bootstrap from server.js without loading env files,
// starting HTTP, or copying the alias implementation into the test.
const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const bootstrapStart = serverSource.indexOf("const Module = require('module');");
const bootstrapEnd = serverSource.indexOf("const http = require('http');");
assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart);
const resolveAlias = runInNewContext(`${serverSource.slice(bootstrapStart, bootstrapEnd)}\nresolveEsmOnlyPackageAlias;`, { require: createRequire(new URL('../server.js', import.meta.url)), process }) as (request: string, aliases: Map<string, string>) => string | null;
const aliases = new Map([['fixture/utils/*', '/fixture/dist/utils/*.js'], ['fixture/utils/exact', '/fixture/exact.js']]);
assert.equal(resolveAlias('fixture/utils/uuid', aliases), '/fixture/dist/utils/uuid.js');
assert.equal(resolveAlias('fixture/utils/exact', aliases), '/fixture/exact.js');
for (const subpath of ['../secret', './secret', 'node_modules/secret', '%2e%2e/secret', 'nested\\secret', '']) {
  assert.equal(resolveAlias(`fixture/utils/${subpath}`, aliases), null);
}
const serverLoad = moduleInternals._load;
moduleInternals._load = function load(request, parent, isMain) {
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDatabase;
  return serverLoad.call(this, request, parent, isMain);
};
try {
  // Real server import graph, real Pi packages. Only storage is isolated.
  const loader = await import('../server/agent-runtime-loader');
  await loader.preloadAgentRuntimeModules();
  const runtime = await loader.getRuntimeService();
  const router = await loader.getChannelRouter();
  assert.equal(typeof runtime.sendMessage, 'function');
  assert.equal(typeof runtime.prewarmSessionRuntime, 'function');
  assert.equal(typeof router.handleInboundChannelMessage, 'function');
  assert.equal(await loader.getRuntimeService(), runtime);
  console.log('Real server runtime and channel imports passed');
} finally {
  moduleInternals._load = originalLoad;
  moduleInternals._resolveFilename = originalResolveFilename;
  await testDatabase.close();
  rmSync(dataDir, { recursive: true, force: true });
}
