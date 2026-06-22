import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { OrganizationPermissionState } from '@/app/lib/organization/bootstrap';

function testState(databaseProvider: string): OrganizationPermissionState {
  return {
    configured: true,
    organizationId: 'org-knowledge-test',
    ownerUserId: 'owner-user',
    teamFeaturesEnabled: true,
    databaseProvider,
    permission: {
      role: 'owner',
      status: 'active',
      canWriteTeamWorkspace: true,
      canCreatePublicLinks: true,
      canCreateTeamAutomations: true,
      canSharePluginsAndSkills: true,
      canExport: true,
      canDeleteTeamFiles: true,
      canDeleteStudioAssets: true,
      canManageBackups: true,
      canMigrateDatabase: true,
      canEnableKnowledge: true,
      canRecoverWorkspaces: true,
    },
  };
}

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-knowledge-settings-'));
  const previousData = process.env.DATA;
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousDatabaseProvider = process.env.CANVAS_DATABASE_PROVIDER;
  const previousVectorEnabled = process.env.CANVAS_POSTGRES_VECTOR_ENABLED;

  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_POSTGRES_VECTOR_ENABLED = 'false';

  try {
    const {
      readKnowledgeOperationalLogs,
      readKnowledgeParsingSettings,
      resolveKnowledgeResourceStatus,
      updateKnowledgeParsingSettings,
    } = await import('../app/lib/knowledge/settings-service');

    const sqliteState = testState('sqlite');
    const { settings: defaults, storage } = await readKnowledgeParsingSettings(sqliteState);
    assert.equal(storage.scope, 'organization');
    assert.equal(defaults.knowledgeAutoIngestionEnabled, false);
    assert.equal(defaults.heavyDocumentParsingEnabled, false);
    assert.equal(defaults.doclingEnabled, false);
    assert.equal(defaults.ocrEnabled, false);
    assert.equal(defaults.embeddingIndexingEnabled, false);
    assert.equal(defaults.remoteParsingEnabled, false);

    const sqliteStatus = await resolveKnowledgeResourceStatus(defaults, sqliteState);
    assert.equal(sqliteStatus.postgresReady, false);
    assert.equal(sqliteStatus.canEnableKnowledge, false);
    assert.ok(sqliteStatus.blockers.includes('requires_postgres'));

    const doclingStatus = await resolveKnowledgeResourceStatus({ ...defaults, doclingEnabled: true, ocrEnabled: true }, sqliteState);
    assert.equal(doclingStatus.parser.docling, 'not_checked');
    assert.equal(doclingStatus.parser.ocr, 'not_checked');

    await assert.rejects(
      () => updateKnowledgeParsingSettings({
        state: sqliteState,
        actorUserId: 'owner-user',
        updates: {
          knowledgeAutoIngestionEnabled: true,
          embeddingIndexingEnabled: true,
        },
      }),
      /requires_postgres/u,
    );

    const afterBlocked = await readKnowledgeParsingSettings(sqliteState);
    assert.equal(afterBlocked.settings.knowledgeAutoIngestionEnabled, false);

    const safeUpdate = await updateKnowledgeParsingSettings({
      state: sqliteState,
      actorUserId: 'owner-user',
      updates: {
        maxDocumentSizeMb: 64,
        minimumFreeMemoryMb: 768,
        remoteParsingEnabled: true,
        secretToken: 'should-not-be-logged',
      } as never,
    });
    assert.equal(safeUpdate.settings.maxDocumentSizeMb, 64);
    assert.equal(safeUpdate.settings.minimumFreeMemoryMb, 768);
    assert.equal(safeUpdate.settings.remoteParsingEnabled, true);
    assert.equal(safeUpdate.settings.knowledgeAutoIngestionEnabled, false);

    const logFile = path.join(dataRoot, 'system', 'logs', 'knowledge-operational.jsonl');
    const rawLogs = await readFile(logFile, 'utf8');
    assert.equal(rawLogs.includes('should-not-be-logged'), false);
    assert.equal(rawLogs.includes('secretToken'), false);
    assert.ok(rawLogs.includes('knowledge_settings.update_blocked'));
    assert.ok(rawLogs.includes('knowledge_settings.updated'));
    const logs = await readKnowledgeOperationalLogs();
    assert.ok(logs.length >= 2);
    assert.ok(logs.every((entry) => Array.isArray(entry.changedKeys)));

    await appendFile(logFile, '{broken-json\n');
    const logsWithMalformedLine = await readKnowledgeOperationalLogs();
    assert.ok(logsWithMalformedLine.length >= 2);

    for (let index = 0; index < 505; index += 1) {
      await assert.rejects(
        () => updateKnowledgeParsingSettings({
          state: sqliteState,
          actorUserId: 'owner-user',
          updates: {
            knowledgeAutoIngestionEnabled: true,
          },
        }),
        /requires_postgres/u,
      );
    }
    const cappedRawLogs = await readFile(logFile, 'utf8');
    assert.ok(cappedRawLogs.split('\n').filter(Boolean).length <= 500);

    console.log('knowledge-settings-test: ok');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousCanvasDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousCanvasDataRoot;
    if (previousDatabaseProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousDatabaseProvider;
    if (previousVectorEnabled === undefined) delete process.env.CANVAS_POSTGRES_VECTOR_ENABLED;
    else process.env.CANVAS_POSTGRES_VECTOR_ENABLED = previousVectorEnabled;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
