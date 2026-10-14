import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './pi-test-database';
import { createSharedConnectionTestDatabase } from './shared-connection-test-database';
import { createPackageStoreRegistryFixture } from './package-store-registry-fixture';
import type { SqlConnection } from '../../app/lib/db';
import type { CapabilityResourceActor } from '../../app/lib/capabilities/resources/contracts';

/** Only the database transport is substituted; all auth/authority/actions stay real. */
export async function createCapabilityPackageStoreApplicationFixture(options: { native?: boolean; nativePoolMax?: 2 | 10 } = {}) {
  if (options.nativePoolMax !== undefined) assert.equal(options.native, true, 'An explicit pool size requires real PostgreSQL.');
  if (options.native) {
    assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1', 'Native gate never silently falls back to PGlite.');
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-store-application-'));
  const engine = options.native ? await createSharedConnectionTestDatabase({ poolMax: options.nativePoolMax }) : { ...await createPiTestDatabase(), native: false };
  if (options.native) assert.equal(engine.native, true);
  const sql = await engine.openDb();
  const registry = await createPackageStoreRegistryFixture(root), organizationId = 'store-application-org';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), instanceId = `store-application-${randomUUID()}`;
  const claims = { sub: instanceId, instanceId, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'managed', status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'store-application-license', hostingMode: 'cloud', edition: 'team',
    licenseClass: 'commercial', licenseEnvironment: 'production', seatLimit: 10, nonBillable: false, entitlementsVersion: 1,
    deploymentMode: 'managed-team', databaseProvider: 'postgres', vectorProvider: 'pgvector', postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true }, features: { teamWorkspace: true, multiUser: true }, quotas: { users: 10 },
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) }), JSON.stringify(claims)].map(value => Buffer.from(value).toString('base64url')).join('.');
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_store_application',
    CANVAS_INSTANCE_ID: instanceId, CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', NODE_ENV: 'test',
    CANVAS_LICENSE_CERT: `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`,
    CANVAS_LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: fingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', AUTH_SECRET: randomBytes(32).toString('hex'), INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'),
    QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', BASE_URL: 'http://localhost:3001', BETTER_AUTH_BASE_URL: 'http://localhost:3001',
    CANVAS_PLUGIN_STORE_REGISTRY_URL: registry.registryUrl('application'), CANVAS_SKILL_STORE_REGISTRY_URL: registry.registryUrl('application') };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, modules = new Map<string, unknown>();
  let providerRequests = 0, authReady: Promise<void> | undefined;
  let afterQuery: ((query: string, params: readonly unknown[]) => Promise<void>) | undefined;
  let beforeRead: ((query: string) => Promise<void>) | undefined;
  let afterRead: ((query: string, params: readonly unknown[]) => Promise<void>) | undefined;
  let beforeFetch: ((url: string) => Promise<void>) | undefined;
  let setupConnectionReleased = false;
  const releaseSetupConnection = async () => {
    if (setupConnectionReleased) return;
    setupConnectionReleased = true;
    await sql.close();
  };
  const database = { ...engine, openDb: async (): Promise<SqlConnection> => {
    const base = await engine.openDb();
    return { ...base,
      get: async (query, params = []) => { await beforeRead?.(query); const result = await base.get(query, params); await afterRead?.(query, params); return result; },
      all: async (query, params = []) => { await beforeRead?.(query); const result = await base.all(query, params); await afterRead?.(query, params); return result; },
      run: async (query, params = []) => { const result = await base.run(query, params); await afterQuery?.(query, params); return result; } };
  } };
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (modules.has(name)) return modules.get(name);
    return originalLoad(name, parent, isMain);
  };
  const close = async () => {
    globalThis.fetch = originalFetch; await registry.close();
    // Construction already propagates an auth failure; teardown must still
    // release its owned database and restore the module/environment boundary.
    await authReady?.catch(() => undefined); loader._load = originalLoad;
    await releaseSetupConnection(); await engine.close();
    assert(path.basename(root).startsWith('canvas-store-application-'));
    const unlock = async (directory: string): Promise<void> => {
      const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(directory, 0o700);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await unlock(path.join(directory, entry.name));
    };
    await unlock(root); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    const users = ['owner', 'alice', 'bob', 'manager', 'unassigned'];
    for (const id of users) await sql.run('INSERT INTO "user"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES($1,$1,$2,$3,1,0,1,1)', [id, `${id}@store-application.example.test`, id === 'owner' ? 'admin' : 'user']);
    await sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES($1,'owner','team',1,1,1)", [organizationId]);
    for (const id of users) {
      const role = id === 'owner' ? 'owner' : 'member';
      await sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES($1,$2,$3,'active',$4,1,1)", [organizationId, id, role, Number(id === 'owner')]);
      await sql.run("INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',$6,$6,$6,$6)", [`seat-${id}`, organizationId, `${id}@store-application.example.test`, id, role, Date.now()]);
      await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,'personal',$3,$1,$3,'active',1,1)", [`personal-${id}`, organizationId, id]);
    }
    for (const id of ['store-team', 'other-team']) await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,'team',$1,$1,'active',1,1)", [id, organizationId]);
    await sql.run("INSERT INTO canvas_workspace_members(organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES($1,'store-team','manager','member','active',1,1,1,1)", [organizationId]);
    const auth = await import('../../app/lib/auth'); authReady = auth.ensureAuthReady(); await authReady;
    const tokens = new Map<string, string>();
    for (const id of users) {
      const token = randomBytes(32).toString('hex'); tokens.set(id, token);
      await sql.run('INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES($1,$2,$3,$4,$4,$5)', [`session-${id}`, Date.now() + 3_600_000, token, Date.now(), id]);
    }
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).origin !== registry.baseUrl) { providerRequests += 1; throw new Error('Only the fixture registry transport is permitted.'); }
      await beforeFetch?.(url);
      return originalFetch(input, init);
    };
    const actor = (userId: string): CapabilityResourceActor => ({ userId, workspaceId: `personal-${userId}` });
    return { root, sql, database, native: engine.native, openObserverConnection: engine.openDb, registry, organizationId, actor, owner: actor('owner'), alice: actor('alice'), manager: actor('manager'),
      organizationScope: { scopeType: 'organization' as const, organizationId }, userScope: (userId: string) => ({ scopeType: 'user' as const, userId }),
      headers: (userId: string) => new Headers({ authorization: `Bearer ${tokens.get(userId)}`, 'content-type': 'application/json', 'x-canvas-workspace-id': `personal-${userId}` }),
      setAfterQuery: (value: typeof afterQuery) => { afterQuery = value; }, setBeforeRead: (value: typeof beforeRead) => { beforeRead = value; },
      setAfterRead: (value: typeof afterRead) => { afterRead = value; }, releaseSetupConnection,
      setBeforeFetch: (value: typeof beforeFetch) => { beforeFetch = value; },
      providerRequests: () => providerRequests, close };
  } catch (error) { await close(); throw error; }
}
