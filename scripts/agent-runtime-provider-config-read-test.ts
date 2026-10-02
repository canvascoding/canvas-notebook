import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import type { CatalogStoreProviderInput } from '../app/lib/agent-runtime-policy/catalog-store';

const moduleInternals = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
const originalLoad = moduleInternals._load;
const runStatements: string[] = [];
let contractOpenDb: (() => Promise<SqlConnection>) | undefined;
const persistedConfig = JSON.stringify({
  authMethod: 'api-key',
  ollamaMode: 'cloud',
  ollamaHost: 'https://ollama.example.test/v1/',
  ollamaCustomModel: ' model-one ',
  ollamaAdditionalModels: ['model-one', 'model-two', 'model-one'],
  openaiCompatibleBaseUrl: 'https://compatible.example.test/v1',
  openaiCompatibleModelSource: 'custom',
  openaiCompatibleCustomModel: 'compatible-model',
  apiKey: 'fixture-provider-key',
  authorization: 'fixture-authorization',
  unknownSetting: 'fixture-unknown-value',
  privateEndpoint: 'https://user:fixture-password@private.example.test/v1',
});

moduleInternals._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') {
    return {
      openDb: async () => contractOpenDb ? contractOpenDb() : ({
        run: async (sql: string) => { runStatements.push(sql); },
        get: async () => undefined,
        all: async (sql: string) => sql.includes('ai_provider_installations') ? [{
          id: `aip_${'a'.repeat(24)}`,
          provider_id: 'fixture-provider',
          display_name: 'Fixture provider',
          source: 'self-hosted',
          credential_scope: 'organization',
          enabled: true,
          status: 'unverified',
          config_json: persistedConfig,
          source_revision: null,
          last_synced_at: null,
          revision: 1,
          verified_at: null,
          verified_by_user_id: null,
        }] : [],
        close: async () => undefined,
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function testCatalogGrantPreservation() {
  const nativePostgres = process.env.CANVAS_RUNTIME_CATALOG_POSTGRES_TEST === '1';
  let closeDatabase: () => Promise<void>;
  if (nativePostgres) {
    const url = new URL(process.env.DATABASE_URL || '');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '55433');
    assert.match(url.pathname, /^\/canvas_editor_test_[a-f0-9]{16}$/);
    assert.match(path.basename(process.env.DATA || ''), /^canvas-yjs-pg-/);
    const actualDb = await import('../app/lib/db');
    contractOpenDb = actualDb.openDb;
    closeDatabase = actualDb.closeDatabaseConnections;
  } else {
    const postgres = new PGlite();
    await postgres.exec(`
      CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL,
        email_verified bigint NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL);
      CREATE TABLE canvas_organization_settings (organization_id text PRIMARY KEY, owner_user_id text REFERENCES "user"(id),
        created_at bigint NOT NULL, updated_at bigint NOT NULL);
      CREATE TABLE canvas_workspaces (id text PRIMARY KEY, organization_id text REFERENCES canvas_organization_settings(organization_id),
        type text NOT NULL, owner_user_id text REFERENCES "user"(id), root_relative_path text NOT NULL,
        display_name text NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL);
      CREATE TABLE ai_provider_installations (id text PRIMARY KEY,
        organization_id text NOT NULL REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
        provider_id text NOT NULL, display_name text NOT NULL, source text NOT NULL, credential_scope text NOT NULL,
        enabled bigint NOT NULL, status text NOT NULL, config_json text, source_revision text, last_synced_at bigint,
        revision bigint NOT NULL, verified_at bigint, verified_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
        created_at bigint NOT NULL, updated_at bigint NOT NULL, UNIQUE (organization_id, provider_id, credential_scope));
      CREATE TABLE ai_provider_models (organization_id text NOT NULL REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
        provider_installation_id text NOT NULL REFERENCES ai_provider_installations(id) ON DELETE CASCADE,
        model_id text NOT NULL, display_name text NOT NULL, enabled bigint NOT NULL, is_provider_default bigint NOT NULL,
        reasoning bigint NOT NULL, supports_vision bigint NOT NULL, thinking_levels_json text NOT NULL, metadata_json text,
        revision bigint NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL,
        PRIMARY KEY (provider_installation_id, model_id));
      CREATE TABLE ai_runtime_defaults (organization_id text PRIMARY KEY REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
        provider_installation_id text REFERENCES ai_provider_installations(id) ON DELETE SET NULL,
        provider_id text, model_id text, thinking_level text, catalog_revision bigint NOT NULL,
        migration_state text, legacy_source_hash text, updated_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
        created_at bigint NOT NULL, updated_at bigint NOT NULL);
      CREATE TABLE ai_user_workspace_provider_grants (id text PRIMARY KEY,
        organization_id text NOT NULL REFERENCES canvas_organization_settings(organization_id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, workspace_id text NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
        agent_id text NOT NULL, provider_installation_id text NOT NULL REFERENCES ai_provider_installations(id) ON DELETE CASCADE,
        allowed_execution_modes_json text NOT NULL, status text NOT NULL CHECK (status IN ('active', 'revoked')),
        revision bigint NOT NULL, granted_at bigint NOT NULL, revoked_at bigint, created_at bigint NOT NULL, updated_at bigint NOT NULL,
        UNIQUE (user_id, workspace_id, agent_id, provider_installation_id));
    `);
    contractOpenDb = async () => ({
      run: async (sql, params) => postgres.query(sql, params),
      get: async (sql, params) => (await postgres.query(sql, params)).rows[0],
      all: async (sql, params) => (await postgres.query(sql, params)).rows,
      close: async () => undefined,
    });
    closeDatabase = () => postgres.close();
  }
  const openConnection = contractOpenDb;
  const { replaceAppRuntimeCatalogStore, readAppRuntimeCatalog, CatalogRevisionConflictError } = await import('../app/lib/agent-runtime-policy/catalog-store');
  const org = 'org-grant-regression';
  const foreignOrg = 'org-foreign-grant-regression';
  const userId = 'user-grant-regression';
  const workspaceId = 'workspace-grant-regression';
  const foreignWorkspaceId = 'workspace-foreign-grant-regression';
  const now = 1_800_000_000_000;
  async function run(sql: string, params: unknown[]) {
    const db = await openConnection();
    try { await db.run(sql, params); } finally { await db.close(); }
  }
  async function rows(table: string, organizationId: string) {
    const db = await openConnection();
    try { return await db.all(`SELECT * FROM ${table} WHERE organization_id = $1 ORDER BY 1, 2`, [organizationId]); }
    finally { await db.close(); }
  }
  async function snapshot() {
    const snapshotRows = [];
    for (const organizationId of [org, foreignOrg]) {
      for (const table of ['ai_provider_installations', 'ai_provider_models', 'ai_runtime_defaults', 'ai_user_workspace_provider_grants']) {
        snapshotRows.push(await rows(table, organizationId));
      }
    }
    return snapshotRows;
  }
  async function grant(organizationId: string, workspace: string, installationId: string, status: 'active' | 'revoked') {
    await run(`INSERT INTO ai_user_workspace_provider_grants
      (id, organization_id, user_id, workspace_id, agent_id, provider_installation_id, allowed_execution_modes_json,
       status, revision, granted_at, revoked_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [`grant-${installationId}-${status}`, organizationId, userId, workspace, `agent-${status}`, installationId,
      '["interactive","personal_automation"]', status, status === 'active' ? 7 : 9, now - 1000,
      status === 'revoked' ? now : null, now - 1000, now]);
  }
  const provider: CatalogStoreProviderInput = {
    installationId: 'installation-retained', providerId: 'ollama', name: 'Retained provider', source: 'built-in',
    credentialScope: 'user', enabled: true, status: 'ready', config: { ollamaHost: 'http://127.0.0.1:11434' },
    sourceRevision: null, lastSyncedAt: null, revision: 1, verifiedAt: now, verifiedByUserId: userId,
    models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true, isProviderDefault: true, reasoning: true,
      supportsVision: false, thinkingLevels: ['off', 'medium'], metadata: { contextWindow: 8192, maxTokens: 1024 }, revision: 1 }],
  };
  const foreignProvider = { ...provider, installationId: 'installation-foreign' };
  const additionalProvider = { ...provider, installationId: 'installation-added', providerId: 'openai', config: {} };
  try {
    await run('INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, 'Grant regression fixture', 'grant-regression@example.invalid', 1, now, now]);
    for (const [organizationId, workspace] of [[org, workspaceId], [foreignOrg, foreignWorkspaceId]]) {
      await run('INSERT INTO canvas_organization_settings (organization_id, owner_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4)',
        [organizationId, userId, now, now]);
      await run('INSERT INTO canvas_workspaces (id, organization_id, type, owner_user_id, root_relative_path, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [workspace, organizationId, 'personal', userId, workspace, 'Grant regression', now, now]);
    }
    let revision = await replaceAppRuntimeCatalogStore({ organizationId: org, actorUserId: userId, expectedRevision: 0,
      migrationState: 'configured', providers: [provider], defaultSelection: { providerInstallationId: provider.installationId,
        providerId: provider.providerId, modelId: 'fixture-model', thinkingLevel: 'off' } });
    await replaceAppRuntimeCatalogStore({ organizationId: foreignOrg, actorUserId: userId, expectedRevision: 0,
      migrationState: 'configured', providers: [foreignProvider], defaultSelection: null });
    for (const status of ['active', 'revoked'] as const) {
      await grant(org, workspaceId, provider.installationId, status);
      await grant(foreignOrg, foreignWorkspaceId, foreignProvider.installationId, status);
    }
    const originalGrants = await rows('ai_user_workspace_provider_grants', org);
    const foreignBefore = (await snapshot()).slice(4);
    assert.equal(originalGrants.length, 2);
    const originalProvider = (await rows('ai_provider_installations', org))[0] as { created_at: unknown };
    const selection = { providerInstallationId: provider.installationId, providerId: provider.providerId,
      modelId: 'fixture-model', thinkingLevel: 'medium' as const };
    async function save(providers: CatalogStoreProviderInput[]) {
      revision = await replaceAppRuntimeCatalogStore({ organizationId: org, actorUserId: userId,
        expectedRevision: revision, migrationState: 'configured', providers, defaultSelection: selection });
    }
    await save([provider]);
    assert.deepEqual(await rows('ai_user_workspace_provider_grants', org), originalGrants, 'Default-only saving must preserve active and revoked grants exactly.');
    assert.equal(((await rows('ai_provider_installations', org))[0] as { created_at: unknown }).created_at, originalProvider.created_at);
    const editedProvider = { ...provider, name: 'Updated provider', config: { ollamaHost: 'http://127.0.0.1:11435' },
      models: [{ ...provider.models[0], metadata: { contextWindow: 32768, maxTokens: 2048 } }] };
    await save([editedProvider]);
    assert.deepEqual(await rows('ai_user_workspace_provider_grants', org), originalGrants, 'Editing a retained provider must preserve grant history exactly.');
    const editedCatalog = await readAppRuntimeCatalog(org);
    assert.equal(editedCatalog.providers[0].config.ollamaHost, editedProvider.config.ollamaHost);
    assert.deepEqual(editedCatalog.providers[0].models[0].metadata, editedProvider.models[0].metadata);
    await save([editedProvider, additionalProvider]);
    assert.deepEqual(await rows('ai_user_workspace_provider_grants', org), originalGrants, 'Adding another provider must preserve unrelated grants.');
    assert.equal((await readAppRuntimeCatalog(org)).providers.length, 2);
    for (const status of ['active', 'revoked'] as const) await grant(org, workspaceId, additionalProvider.installationId, status);

    const beforeStale = await snapshot();
    await assert.rejects(replaceAppRuntimeCatalogStore({ organizationId: org, actorUserId: userId,
      expectedRevision: revision - 1, migrationState: 'configured', providers: [], defaultSelection: null }), CatalogRevisionConflictError);
    assert.deepEqual(await snapshot(), beforeStale, 'Stale revisions must leave both catalogs, defaults and grants unchanged.');
    await assert.rejects(replaceAppRuntimeCatalogStore({ organizationId: org, actorUserId: userId,
      expectedRevision: revision, migrationState: 'configured', providers: [editedProvider, foreignProvider], defaultSelection: selection }),
    /another organization/i);
    assert.deepEqual(await snapshot(), beforeStale, 'A global installation-ID collision must not mutate either organization.');

    await save([editedProvider]);
    assert.deepEqual(await rows('ai_user_workspace_provider_grants', org), originalGrants, 'Removing a provider must cascade only its own grants.');
    assert.equal((await readAppRuntimeCatalog(org)).revision, revision);
    assert.deepEqual((await snapshot()).slice(4), foreignBefore, 'Every save must leave the other organization untouched.');

    const beforeInvalidModel = await snapshot();
    await assert.rejects(replaceAppRuntimeCatalogStore({ organizationId: org, actorUserId: userId,
      expectedRevision: revision, migrationState: 'configured',
      providers: [{ ...editedProvider, models: [editedProvider.models[0], editedProvider.models[0]] }], defaultSelection: selection }),
    /duplicate key|unique constraint/i);
    assert.deepEqual(await snapshot(), beforeInvalidModel, 'An insert failure after provider/model writes must roll back all changes.');
    await assert.rejects(replaceAppRuntimeCatalogStore({ organizationId: 'org-missing-catalog-regression', actorUserId: userId,
      expectedRevision: 0, migrationState: 'configured', providers: [provider], defaultSelection: selection }), /organization is missing/i);
    assert.deepEqual(await snapshot(), beforeInvalidModel, 'A missing organization must fail before any catalog mutation.');

    if (nativePostgres) {
      const racedProvider = { ...additionalProvider, installationId: 'installation-foreign-race' };
      const beforeRaceOwn = (await snapshot()).slice(0, 4);
      let foreignWinner: unknown[][] | undefined;
      let interleaved = false;
      contractOpenDb = async () => {
        const connection = await openConnection();
        return {
          ...connection,
          get: async (sql, params) => {
            if (sql.includes('INSERT INTO ai_provider_installations') && params?.[0] === racedProvider.installationId) {
              assert.equal(interleaved, false);
              interleaved = true;
              contractOpenDb = openConnection;
              const foreignRevision = await replaceAppRuntimeCatalogStore({ organizationId: foreignOrg, actorUserId: userId,
                expectedRevision: 1, migrationState: 'configured', providers: [foreignProvider, racedProvider], defaultSelection: null });
              assert.equal(foreignRevision, 2);
              foreignWinner = (await snapshot()).slice(4);
            }
            return connection.get(sql, params);
          },
        };
      };
      try {
        await assert.rejects(replaceAppRuntimeCatalogStore({ organizationId: org, actorUserId: userId,
          expectedRevision: revision, migrationState: 'configured', providers: [editedProvider, racedProvider], defaultSelection: selection }),
        /another organization/i);
        assert.equal(interleaved, true, 'The competing foreign insert must commit after the precheck and before the target UPSERT.');
        assert.deepEqual((await snapshot()).slice(0, 4), beforeRaceOwn, 'A concurrent foreign ID collision must roll back earlier target writes.');
        assert.deepEqual((await snapshot()).slice(4), foreignWinner, 'The competing organization must retain its exact committed installation and catalog.');
      } finally { contractOpenDb = openConnection; }

      async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([promise, new Promise<T>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), 15_000);
          })]);
        } finally { if (timeout) clearTimeout(timeout); }
      }
      const parallelOrg = 'org-parallel-first-save';
      const parallelWorkspace = 'workspace-parallel-first-save';
      await run('INSERT INTO canvas_organization_settings (organization_id, owner_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4)',
        [parallelOrg, userId, now, now]);
      await run('INSERT INTO canvas_workspaces (id, organization_id, type, owner_user_id, root_relative_path, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [parallelWorkspace, parallelOrg, 'personal', userId, parallelWorkspace, 'Parallel first save', now, now]);
      const beforeParallel = await snapshot();
      let resolveArrived!: () => void;
      const bothArrived = new Promise<void>(resolve => { resolveArrived = resolve; });
      let resolveWinnerReady!: () => void;
      const winnerReady = new Promise<void>(resolve => { resolveWinnerReady = resolve; });
      let arrivals = 0;
      let acquired = 0;
      let winnerRows: unknown[][] | undefined;
      async function parallelRows() {
        const result = [];
        for (const table of ['ai_provider_installations', 'ai_provider_models', 'ai_runtime_defaults', 'ai_user_workspace_provider_grants']) {
          result.push(await rows(table, parallelOrg));
        }
        return result;
      }
      contractOpenDb = async () => {
        const connection = await openConnection();
        return { ...connection, get: async (sql, params) => {
          const organizationLock = sql.includes('FROM canvas_organization_settings') && params?.[0] === parallelOrg;
          if (organizationLock) {
            arrivals += 1;
            if (arrivals === 2) resolveArrived();
            await bounded(bothArrived, 'Both first writers reaching the organization lock');
          }
          const result = await connection.get(sql, params);
          if (organizationLock && ++acquired === 2) await bounded(winnerReady, 'Winning catalog and grant evidence');
          return result;
        } };
      };
      const firstSave = async (value: CatalogStoreProviderInput) => {
        const savedRevision = await replaceAppRuntimeCatalogStore({ organizationId: parallelOrg, actorUserId: userId,
          expectedRevision: 0, migrationState: 'configured', providers: [value], defaultSelection: {
            providerInstallationId: value.installationId, providerId: value.providerId, modelId: 'fixture-model', thinkingLevel: 'off' } });
        try {
          for (const status of ['active', 'revoked'] as const) await grant(parallelOrg, parallelWorkspace, value.installationId, status);
          winnerRows = await parallelRows();
          return { revision: savedRevision, provider: value };
        } finally { resolveWinnerReady(); }
      };
      try {
        const results = await bounded(Promise.allSettled([
          firstSave({ ...provider, installationId: 'installation-parallel-ollama' }),
          firstSave({ ...additionalProvider, installationId: 'installation-parallel-openai' }),
        ]), 'Parallel first saves');
        const winners = results.filter(result => result.status === 'fulfilled');
        const conflicts = results.filter(result => result.status === 'rejected' && result.reason instanceof CatalogRevisionConflictError);
        assert.equal(arrivals, 2);
        assert.equal(acquired, 2);
        assert.equal(winners.length, 1);
        assert.equal(conflicts.length, 1);
        assert.equal((conflicts[0] as PromiseRejectedResult).reason.currentRevision, 1);
        const winner = (winners[0] as PromiseFulfilledResult<{ revision: number; provider: CatalogStoreProviderInput }>).value;
        assert.equal(winner.revision, 1);
        const catalog = await readAppRuntimeCatalog(parallelOrg);
        assert.equal(catalog.revision, 1);
        assert.equal(catalog.providers.length, 1);
        assert.equal(catalog.providers[0].installationId, winner.provider.installationId);
        assert.deepEqual(catalog.defaultSelection, { providerInstallationId: winner.provider.installationId,
          providerId: winner.provider.providerId, modelId: 'fixture-model', thinkingLevel: 'off' });
        assert.equal((await rows('ai_user_workspace_provider_grants', parallelOrg)).length, 2);
        assert.deepEqual(await parallelRows(), winnerRows, 'The losing first save must leave the exact winner catalog/defaults/grants untouched.');
        assert.deepEqual(await snapshot(), beforeParallel, 'Parallel first saves must not affect existing organizations.');
      } finally { contractOpenDb = openConnection; resolveArrived(); resolveWinnerReady(); }

      const runtimeWriter = await openConnection();
      let runtimeTransaction = false;
      let replacement: Promise<PromiseSettledResult<number>> | undefined;
      let resolveOrgLocked!: () => void;
      const orgLocked = new Promise<void>(resolve => { resolveOrgLocked = resolve; });
      const beforeForeignKey = await snapshot();
      try {
        await runtimeWriter.run('BEGIN');
        runtimeTransaction = true;
        await runtimeWriter.run("SET LOCAL lock_timeout = '5s'");
        await runtimeWriter.get('SELECT catalog_revision FROM ai_runtime_defaults WHERE organization_id = $1 FOR UPDATE', [org]);
        contractOpenDb = async () => {
          const connection = await openConnection();
          return { ...connection, get: async (sql, params) => {
            const result = await connection.get(sql, params);
            if (sql.includes('FROM canvas_organization_settings') && params?.[0] === org) resolveOrgLocked();
            return result;
          } };
        };
        replacement = replaceAppRuntimeCatalogStore({ organizationId: org, actorUserId: userId,
          expectedRevision: revision, migrationState: 'configured', providers: [editedProvider], defaultSelection: selection })
          .then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
        await bounded(orgLocked, 'Catalog obtaining the organization lock');
        // The catalog now owns the organization lock and waits for this defaults lock.
        // This real FK insert must acquire organization KEY SHARE without a deadlock.
        await runtimeWriter.run('INSERT INTO canvas_workspaces (id, organization_id, type, owner_user_id, root_relative_path, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          ['workspace-key-share-progress', org, 'personal', userId, 'key-share-progress', 'KEY SHARE progress', now, now]);
        await runtimeWriter.run('COMMIT');
        runtimeTransaction = false;
        const result = await bounded(replacement, 'Catalog completing after the FK writer');
        assert.equal(result.status, 'fulfilled');
        assert.equal((result as PromiseFulfilledResult<number>).value, revision + 1);
        assert.deepEqual(await rows('ai_user_workspace_provider_grants', org), originalGrants);
        assert.deepEqual((await snapshot()).slice(4), beforeForeignKey.slice(4));
      } finally {
        contractOpenDb = openConnection;
        if (runtimeTransaction) await runtimeWriter.run('ROLLBACK');
        await runtimeWriter.close();
        if (replacement) await bounded(replacement, 'Catalog cleanup');
      }
    }
    console.log(`catalog grant preservation: ${nativePostgres ? 11 : 8} PostgreSQL contract scenarios passed (${nativePostgres ? 'native' : 'PGlite'}).`);
  } finally {
    contractOpenDb = undefined;
    await closeDatabase();
  }
}

async function main() {
  try {
    const { readAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-store');
    const catalog = await readAppRuntimeCatalog('org-config-test');
    const config = catalog.providers[0]?.config;

    assert.deepEqual(config, {
      authMethod: 'api-key',
      ollamaMode: 'cloud',
      ollamaHost: 'https://ollama.example.test/v1',
      ollamaCustomModel: 'model-one',
      ollamaAdditionalModels: ['model-one', 'model-two'],
      openaiCompatibleBaseUrl: 'https://compatible.example.test/v1',
      openaiCompatibleModelSource: 'custom',
      openaiCompatibleCustomModel: 'compatible-model',
    });
    const serialized = JSON.stringify(catalog);
    for (const fixtureSecret of ['fixture-provider-key', 'fixture-authorization', 'fixture-password', 'fixture-unknown-value']) {
      assert.equal(serialized.includes(fixtureSecret), false, `unsafe persisted field ${fixtureSecret} must not reach callers`);
    }
    assert.deepEqual(runStatements.map((statement) => statement.trim().split(/\s+/u)[0]), ['BEGIN', 'COMMIT']);
    await testCatalogGrantPreservation();
    console.log('agent-runtime-provider-config-read-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
