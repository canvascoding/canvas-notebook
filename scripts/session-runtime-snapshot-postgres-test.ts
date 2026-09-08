import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { buildPiSessionRuntimeSnapshotCas } from '../app/lib/agent-runtime-policy/runtime-store';
import type { AiSessionRuntimeSnapshot } from '../app/lib/agent-runtime-policy/types';

const previousDatabaseProvider = process.env.CANVAS_DATABASE_PROVIDER;
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
process.env.DATABASE_URL = 'postgresql://session-runtime-snapshot-test';

const oldSnapshot: AiSessionRuntimeSnapshot = {
  selection: {
    providerInstallationId: 'installation-old',
    providerId: 'provider-old',
    modelId: 'model-old',
    thinkingLevel: 'medium',
  },
  catalogRevision: 7,
  policyRevision: 9,
  selectionSource: 'session',
};

const newSnapshot: AiSessionRuntimeSnapshot = {
  selection: {
    providerInstallationId: 'installation-new',
    providerId: 'provider-new',
    modelId: 'model-new',
    thinkingLevel: 'high',
  },
  catalogRevision: 7,
  policyRevision: 9,
  selectionSource: 'workspace_default',
};

const contextRevision = {
  organizationId: 'organization-one',
  workspaceId: 'workspace-one',
  expectedCatalogRevision: 7,
  expectedPolicyRevision: 9,
};

const updateSql = (snapshotCasSql: string, contextCasSql: string) => `
  UPDATE pi_sessions
  SET provider = $1, model = $2, thinking_level = $3,
      runtime_provider_installation_id = $4, runtime_catalog_revision = $5,
      runtime_policy_revision = $6, runtime_selection_source = $7, updated_at = $8
  WHERE session_id = $9 AND user_id = $10 AND agent_id = $11
  ${snapshotCasSql}
  ${contextCasSql}
`;

const baseParams = (sessionId: string) => [
  newSnapshot.selection.providerId,
  newSnapshot.selection.modelId,
  newSnapshot.selection.thinkingLevel,
  newSnapshot.selection.providerInstallationId,
  newSnapshot.catalogRevision,
  newSnapshot.policyRevision,
  newSnapshot.selectionSource,
  Date.now(),
  sessionId,
  'user-one',
  'agent-one',
];

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await postgres.exec(`
      CREATE TABLE ai_runtime_defaults (
        organization_id text PRIMARY KEY,
        catalog_revision bigint NOT NULL
      );
      CREATE TABLE ai_workspace_model_policies (
        organization_id text NOT NULL,
        workspace_id text NOT NULL,
        revision bigint NOT NULL,
        PRIMARY KEY (organization_id, workspace_id)
      );
      CREATE TABLE pi_sessions (
        session_id text PRIMARY KEY,
        user_id text NOT NULL,
        agent_id text NOT NULL,
        provider text,
        model text,
        thinking_level text,
        runtime_provider_installation_id text,
        runtime_catalog_revision bigint,
        runtime_policy_revision bigint,
        runtime_selection_source text,
        updated_at bigint NOT NULL
      );
      INSERT INTO ai_runtime_defaults (organization_id, catalog_revision)
      VALUES ('organization-one', 7);
      INSERT INTO ai_workspace_model_policies (organization_id, workspace_id, revision)
      VALUES ('organization-one', 'workspace-one', 9);
      INSERT INTO pi_sessions (session_id, user_id, agent_id, updated_at)
      VALUES ('session-null', 'user-one', 'agent-one', 0);
      INSERT INTO pi_sessions (
        session_id, user_id, agent_id, provider, model, thinking_level,
        runtime_provider_installation_id, runtime_catalog_revision,
        runtime_policy_revision, runtime_selection_source, updated_at
      ) VALUES (
        'session-existing', 'user-one', 'agent-one', 'provider-old', 'model-old', 'medium',
        'installation-old', 7, 9, 'session', 0
      );
    `);

    const nullSnapshotCas = buildPiSessionRuntimeSnapshotCas({ compareSnapshot: null, contextRevision });
    assert.doesNotMatch(nullSnapshotCas.snapshotCasSql + nullSnapshotCas.contextCasSql, /\?/u);
    assert.match(nullSnapshotCas.contextCasSql, /organization_id = \$12/u);
    assert.match(nullSnapshotCas.contextCasSql, /workspace_id = \$15/u);
    assert.match(nullSnapshotCas.contextCasSql, /\) = \$16/u);
    const nullResult = await postgres.query(
      updateSql(nullSnapshotCas.snapshotCasSql, nullSnapshotCas.contextCasSql),
      [...baseParams('session-null'), ...nullSnapshotCas.params],
    );
    assert.equal(nullResult.affectedRows, 1);

    const existingSnapshotCas = buildPiSessionRuntimeSnapshotCas({ compareSnapshot: oldSnapshot, contextRevision });
    assert.doesNotMatch(existingSnapshotCas.snapshotCasSql + existingSnapshotCas.contextCasSql, /\?/u);
    assert.match(existingSnapshotCas.snapshotCasSql, /runtime_provider_installation_id = \$12/u);
    assert.match(existingSnapshotCas.snapshotCasSql, /runtime_selection_source = \$18/u);
    assert.match(existingSnapshotCas.contextCasSql, /organization_id = \$19/u);
    assert.match(existingSnapshotCas.contextCasSql, /workspace_id = \$22/u);
    assert.match(existingSnapshotCas.contextCasSql, /\) = \$23/u);
    const existingResult = await postgres.query(
      updateSql(existingSnapshotCas.snapshotCasSql, existingSnapshotCas.contextCasSql),
      [...baseParams('session-existing'), ...existingSnapshotCas.params],
    );
    assert.equal(existingResult.affectedRows, 1);

    const staleContextCas = buildPiSessionRuntimeSnapshotCas({
      compareSnapshot: newSnapshot,
      contextRevision: { ...contextRevision, expectedPolicyRevision: 10 },
    });
    const staleResult = await postgres.query(
      updateSql(staleContextCas.snapshotCasSql, staleContextCas.contextCasSql),
      [...baseParams('session-existing'), ...staleContextCas.params],
    );
    assert.equal(staleResult.affectedRows, 0);
  } finally {
    await postgres.close();
    if (previousDatabaseProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousDatabaseProvider;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

main()
  .then(() => console.log('session runtime snapshot PostgreSQL CAS test passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
