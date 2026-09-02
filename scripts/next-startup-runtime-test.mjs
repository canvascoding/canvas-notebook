import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const dbIndexSource = await readFile(new URL('../app/lib/db/index.ts', import.meta.url), 'utf8');
const startupMigrationSource = await readFile(new URL('../app/lib/db/startup-migrations.ts', import.meta.url), 'utf8');
const organizationBootstrapSource = await readFile(new URL('../app/lib/organization/bootstrap.ts', import.meta.url), 'utf8');
const authSetupSource = await readFile(new URL('../app/lib/auth-setup.ts', import.meta.url), 'utf8');
const sessionWorkspaceSource = await readFile(new URL('../app/lib/pi/session-workspace-context.ts', import.meta.url), 'utf8');
const migrationRunnerSource = await readFile(new URL('./run-database-migrations.ts', import.meta.url), 'utf8');
const dockerEntrypointSource = await readFile(new URL('./docker-entrypoint.sh', import.meta.url), 'utf8');
const bootstrapAdminPostgresSource = await readFile(new URL('./bootstrap-admin-postgres.ts', import.meta.url), 'utf8');

const polyfillIndex = serverSource.indexOf("globalThis.AsyncLocalStorage = AsyncLocalStorage");
const nextImportIndex = serverSource.indexOf("const next = require('next')");
const postgresMigrationFunctionIndex = serverSource.indexOf('async function runStartupDatabaseMigrations()');
const postgresMigrationAwaitIndex = serverSource.indexOf('await runStartupDatabaseMigrations()');
const websocketStartupIndex = serverSource.indexOf("console.log('[Startup] Initializing WebSocket Server...')");
const agentRuntimeWarmupIndex = serverSource.indexOf('preloadAgentRuntimeModules()');
const managedCatalogWarmupIndex = serverSource.indexOf('primeCanvasControlPlaneCatalog()');
const nextPrepareIndex = serverSource.indexOf('app.prepare(),');
const entrypointMigrationIndex = dockerEntrypointSource.indexOf('scripts/run-database-migrations.ts');
const agentRuntimeBootstrapIndex = dockerEntrypointSource.indexOf('scripts/bootstrap-agent-runtime.ts');

assert.notEqual(polyfillIndex, -1, 'server.js must polyfill globalThis.AsyncLocalStorage');
assert.notEqual(nextImportIndex, -1, 'server.js must import next');
assert.notEqual(postgresMigrationFunctionIndex, -1, 'server.js must define startup database migrations');
assert.notEqual(postgresMigrationAwaitIndex, -1, 'server.js must await startup database migrations');
assert.notEqual(websocketStartupIndex, -1, 'server.js must initialize websocket startup after migrations');
assert.notEqual(agentRuntimeWarmupIndex, -1, 'server.js must preload agent runtime modules');
assert.notEqual(managedCatalogWarmupIndex, -1, 'server.js must prime the managed model catalog');
assert.notEqual(nextPrepareIndex, -1, 'server.js must await Next preparation with runtime warmup');
assert.notEqual(entrypointMigrationIndex, -1, 'the container entrypoint must run database migrations');
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
  entrypointMigrationIndex < agentRuntimeBootstrapIndex,
  'the container entrypoint must migrate before runtime bootstrap',
);
assert.doesNotMatch(dockerEntrypointSource, /apply-pending-migration-restore/u);
assert.ok(
  !dbIndexSource.includes('runPostgresMigrations'),
  'app/lib/db/index.ts must not start Postgres migrations from runtime imports',
);
assert.match(serverSource, /CANVAS_DATABASE_MIGRATIONS_COMPLETED === 'true'/u);
assert.match(serverSource, /startup-migrations/u);
assert.match(
  serverSource,
  /function resolveImportedServerModule\(importedModule, requiredFunctions, label\)/u,
  'server.js must centralize dynamic TS module export normalization',
);
assert.match(
  serverSource,
  /importedModule\?\.default[\s\S]*importedModule\?\.\['module\.exports'\]/u,
  'server.js must support ESM and CommonJS dynamic import shapes',
);
assert.match(serverSource, /resolveImportedServerModule\([\s\S]*agentRuntimeLoaderModule/u);
assert.match(serverSource, /resolveImportedServerModule\([\s\S]*managedCatalogModule/u);
assert.match(serverSource, /resolveImportedServerModule\([\s\S]*refreshModule/u);
assert.match(serverSource, /resolveImportedServerModule\([\s\S]*lifecycleModule/u);
assert.match(serverSource, /resolveImportedServerModule\([\s\S]*memoryReviewModule/u);
assert.match(startupMigrationSource, /await runPostgresMigrations\(migrationPool\)/u);
assert.match(startupMigrationSource, /await migrationPool\.end\(\)/u);
assert.match(startupMigrationSource, /runMigrations\(migrationDatabase\)/u);
assert.doesNotMatch(
  startupMigrationSource,
  /^import Database from 'better-sqlite3';/mu,
  'Postgres startup must not eagerly load the SQLite native module',
);
assert.match(startupMigrationSource, /loadBetterSqlite3\(\)/u);
assert.doesNotMatch(
  startupMigrationSource,
  /Postgres database migrations completed[\s\S]*runSqliteBootstrapMigrations\(\);[\s\S]*return;/u,
  'Postgres startup must not migrate or create a SQLite sidecar',
);
assert.match(startupMigrationSource, /assertSqliteRuntimeAllowed\('run startup migrations'\)/u);
assert.ok(
  organizationBootstrapSource.indexOf("assertSqliteRuntimeAllowed('open the organization bootstrap database')")
    < organizationBootstrapSource.indexOf('const sqlitePath = resolveSqlitePath()'),
  'the organization SQLite guard must run before resolving or opening the sidecar',
);
assert.ok(
  authSetupSource.indexOf("assertSqliteRuntimeAllowed('open the authentication setup database')")
    < authSetupSource.indexOf('const sqlitePath = getSqlitePath()'),
  'the auth setup SQLite guard must run before resolving or opening the sidecar',
);
assert.ok(
  sessionWorkspaceSource.indexOf("assertSqliteRuntimeAllowed('open the agent workspace context database')")
    < sessionWorkspaceSource.indexOf("path.join(resolveWorkspaceDataRoot(), 'sqlite.db')"),
  'the agent workspace SQLite guard must run before resolving or opening the sidecar',
);
assert.doesNotMatch(startupMigrationSource, /Running SQLite bootstrap migrations/u);
assert.match(migrationRunnerSource, /loadAppEnv\(process\.cwd\(\)\)/u);
assert.match(migrationRunnerSource, /await runStartupDatabaseMigrations\(\)/u);
assert.match(dockerEntrypointSource, /export CANVAS_DATABASE_MIGRATIONS_COMPLETED=true/u);
assert.match(bootstrapAdminPostgresSource, /CANVAS_DATABASE_MIGRATIONS_COMPLETED !== 'true'/u);

console.log('next-startup-runtime-test: ok');
