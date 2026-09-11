import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as Y from 'yjs';
import { visibleAgentTargetAnchors } from '../app/lib/collaboration/agent-target-decorations';
import type * as Sagas from '../app/lib/collaboration/agent-sagas';
import type * as Persistence from '../app/lib/collaboration/persistence';
import type * as Lifecycle from '../app/lib/files/collaboration-repository/lifecycle-repository';
import type * as OperationsUi from '../app/components/editor/CollaborationAgentOperations';
import type { CollaborationAgentOperation } from '../app/lib/collaboration/agent-operations-client';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function compile<T>(file: string, dependencies: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  new Function('require', 'module', 'exports', compiled.outputText)(
    (name: string) => name === 'server-only' ? {} : name in dependencies ? dependencies[name] : load(name),
    { exports }, exports,
  );
  return exports as T;
}

function database(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE collaboration_agent_sagas (
      saga_id TEXT PRIMARY KEY, workspace_id TEXT, organization_id TEXT, initiated_by_user_id TEXT,
      actor_id TEXT, idempotency_key TEXT, requested_atomicity TEXT, status TEXT, correlation_id TEXT,
      causation_id TEXT, error_code TEXT, created_at INTEGER, updated_at INTEGER,
      UNIQUE(workspace_id, initiated_by_user_id, idempotency_key));
    CREATE TABLE collaboration_agent_saga_documents (
      saga_id TEXT, document_id TEXT, ordinal INTEGER, operation_id TEXT, compensation_operation_id TEXT,
      status TEXT, error_code TEXT, updated_at INTEGER);
    CREATE TABLE collaboration_agent_operations (
      operation_id TEXT PRIMARY KEY, document_id TEXT, status TEXT, error_code TEXT,
      cancel_requested_at INTEGER, updated_at INTEGER, cas_version INTEGER DEFAULT 0);
    CREATE TABLE collaboration_yjs_states (
      document_id TEXT PRIMARY KEY, workspace_id TEXT, organization_id TEXT, path TEXT, representation TEXT,
      lifecycle_generation INTEGER, schema_version INTEGER, yjs_state BLOB, state_vector BLOB,
      document_sequence INTEGER, persisted_at INTEGER, checkpointed_at INTEGER, checkpoint_sequence INTEGER,
      canonical_hash TEXT, serialized_hash TEXT, newline_style TEXT, has_bom INTEGER, degraded INTEGER,
      status TEXT, compacted_at INTEGER, compaction_count INTEGER DEFAULT 0);
    CREATE TABLE collaboration_yjs_state_backups (
      backup_id TEXT, document_id TEXT, lifecycle_generation INTEGER, schema_version INTEGER, representation TEXT,
      yjs_state BLOB, state_vector BLOB, document_sequence INTEGER, reason TEXT, created_at INTEGER, expires_at INTEGER);
    CREATE TABLE collaboration_excalidraw_states (workspace_id TEXT, path TEXT, status TEXT, lifecycle_generation INTEGER);
  `);
  const statement = (sql: string) => sqlite.prepare(sql.replace(
    /left\(path, char_length\((\$\d+)\) \+ 1\)/gu, 'substr(path, 1, length($1) + 1)',
  ));
  const args = (values: unknown[] = []) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value as SQLInputValue]));
  const connection = {
    get: async (sql: string, values: unknown[] = []) => statement(sql).get(args(values)),
    all: async (sql: string, values: unknown[] = []) => statement(sql).all(args(values)),
    run: async (sql: string, values: unknown[] = []) => statement(sql).run(args(values)),
    close: async () => {},
  };
  return { connection, sqlite };
}

const workspace: WorkspaceContext = {
  workspaceId: 'workspace', workspaceType: 'organization', organizationId: 'organization', rootPath: '/unused', legacy: false,
  permissions: { canRead: true, canWrite: true, canRunAgent: true, canDelete: true,
    canCreatePublicLinks: true, canManageWorkspace: true },
};

function operation(documentId: string, status = 'persisted_yjs', durability = 'persisted_yjs') {
  return { operationId: `operation-${documentId}`, operationStatus: status, durability, appliedTargetIds: ['target'] };
}

async function sagaHarness(t: TestContext, apply: (id: string) => ReturnType<typeof operation>,
  revert: (id: string) => ReturnType<typeof operation> = (id) => operation(id, 'reverted')) {
  const db = database(t);
  const applied: string[] = [];
  const reverted: string[] = [];
  const sagas = await compile<typeof Sagas>('app/lib/collaboration/agent-sagas.ts', {
    '@/app/lib/db': { openDb: async () => db.connection },
    './agent-operations': {
      applyPersistedAgentTextOperation: async (input: { documentId: string }) => { applied.push(input.documentId); return apply(input.documentId); },
      revertAgentOperation: async (input: { operationId: string }) => { reverted.push(input.operationId); return revert(input.operationId); },
    },
  });
  const execute = () => sagas.applyPersistedAgentTextSaga({ workspace, initiatedByUserId: 'user', actorId: 'agent',
    actorDisplayName: 'Agent', idempotencyKey: 'test', runGeneration: 1,
    documents: [{ documentId: 'a', targets: [] }, { documentId: 'b', targets: [] }],
  });
  return { sagas, execute, applied, reverted };
}

for (const status of ['persisted_yjs', 'checkpointed_file']) {
  test(`a saga completes and compensates documents confirmed as ${status}`, async (t) => {
    const h = await sagaHarness(t, (id) => operation(id, status, status), (id) => operation(id, 'reverted', status));
    const result = await h.execute();
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.documents.map((document) => document.status), ['applied', 'applied']);
    assert.deepEqual(h.applied, ['a', 'b']);
    const repeated = await h.execute();
    assert.equal(repeated.sagaId, result.sagaId);
    assert.equal(h.applied.length, 2, 'completed sagas remain idempotent');
    const compensated = await h.sagas.compensateAgentTextSaga({ sagaId: result.sagaId, workspace, userId: 'user', idempotencyKey: 'revert' });
    assert.equal(compensated.status, 'compensated');
    assert.deepEqual(compensated.documents.map((document) => document.status), ['compensated', 'compensated']);
    assert.equal(h.reverted.length, 2);
  });
}

test('partially applied or unconfirmed saga results still require compensation/review', async (t) => {
  const h = await sagaHarness(t, (id) => id === 'a' ? operation(id) : operation(id, 'partially_applied'));
  const result = await h.execute();
  assert.equal(result.status, 'partially_applied');
  assert.deepEqual(result.documents.map((document) => document.status), ['compensation_required', 'compensation_required']);
});

test('an unconfirmed result is not a successful saga merely because its status claims persistence', async (t) => {
  const h = await sagaHarness(t, (id) => operation(id, 'persisted_yjs', 'pending'));
  const result = await h.execute();
  assert.equal(result.status, 'partially_applied');
  assert.deepEqual(h.applied, ['a']);
  assert.equal(result.documents[1].status, 'skipped');
});

test('compensation accepts persisted_yjs but preserves partial and pending review states', async (t) => {
  const h = await sagaHarness(t, (id) => operation(id), (id) => id.endsWith('-a')
    ? operation(id, 'persisted_yjs') : operation(id, 'partially_applied'));
  const result = await h.execute();
  const reverted = await h.sagas.compensateAgentTextSaga({ sagaId: result.sagaId, workspace, userId: 'user', idempotencyKey: 'revert' });
  assert.equal(reverted.status, 'compensation_review');
  assert.deepEqual(reverted.documents.map((document) => document.status), ['compensated', 'compensation_review']);
});

async function persistenceHarness(t: TestContext, statuses: string[]) {
  const db = database(t);
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'Document');
  try {
    await db.connection.run(`INSERT INTO collaboration_yjs_states (
      document_id, workspace_id, organization_id, path, representation, lifecycle_generation, schema_version,
      yjs_state, state_vector, document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
      canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
    ) VALUES ('doc', 'workspace', 'organization', 'folder/document.md', 'plain_text', 1, 1,
      $1, $2, 2, 1, 1, 2, 'hash', 'hash', 'lf', 0, 0, 'active')`,
    [Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc)]);
  } finally { doc.destroy(); }
  for (const status of statuses) await db.connection.run(
    'INSERT INTO collaboration_agent_operations (operation_id, document_id, status) VALUES ($1, $2, $3)',
    [status, 'doc', status],
  );
  const persistence = await compile<typeof Persistence>('app/lib/collaboration/persistence.ts', {
    '@/app/lib/db': { openDb: async () => db.connection },
    '@/app/lib/files/workspace-mutation-lock': { withWorkspaceMutationLock: (_id: string, run: () => unknown) => run() },
    '@/app/lib/files/collaboration-repository': {},
    '@/app/lib/markdown/obsidian-metadata': {}, '@/app/lib/markdown/rich-markdown-codec': {},
    './types': { isRichTextCollaborationRepresentation: (representation: string) => representation !== 'plain_text' },
    './markdown-state': { createPlainTextYDoc: (content: string) => {
      const fresh = new Y.Doc(); fresh.getText('content').insert(0, content); return fresh;
    } },
    './runtime-state': { getCollaborationRoomConnectionCount: () => 0,
      withCollaborationRoomLifecycleLock: (_id: string, run: () => unknown) => run() },
    './server-runtime': { Y },
  });
  return { ...db, persistence };
}

test('completed Yjs operations neither block compaction nor expire during representation migration', async (t) => {
  const h = await persistenceHarness(t, ['persisted_yjs', 'checkpointed_file']);
  const compacted = await h.persistence.compactCollaborationState({ documentId: 'doc', expectedLifecycleGeneration: 1 });
  assert.equal(compacted.lifecycleGeneration, 2);
  const migrated = await h.persistence.changeCollaborationRepresentation({ documentId: 'doc', expectedLifecycleGeneration: 2,
    representation: 'plain_text', schemaVersion: 2 });
  assert.equal(migrated.lifecycleGeneration, 3);
  assert.deepEqual((await h.connection.all('SELECT status FROM collaboration_agent_operations ORDER BY status')).map((row) => row.status),
    ['checkpointed_file', 'persisted_yjs']);
});

for (const status of ['applying', 'applied_to_ydoc']) {
  test(`${status} still prevents compaction and migration`, async (t) => {
    const h = await persistenceHarness(t, [status]);
    await assert.rejects(() => h.persistence.compactCollaborationState({ documentId: 'doc', expectedLifecycleGeneration: 1 }), /operations.*pending/u);
    await assert.rejects(() => h.persistence.changeCollaborationRepresentation({ documentId: 'doc', expectedLifecycleGeneration: 1,
      representation: 'plain_text', schemaVersion: 2 }), /authoritative agent apply/u);
    assert.equal((await h.persistence.loadCollaborationState('doc'))?.lifecycleGeneration, 1);
  });
}

test('archiving preserves completed agent history while cancelling outstanding work in the path scope', async (t) => {
  const h = await persistenceHarness(t, ['persisted_yjs', 'checkpointed_file', 'applying', 'needs_review']);
  const lifecycle = await compile<typeof Lifecycle>('app/lib/files/collaboration-repository/lifecycle-repository.ts', {
    './lineage-revision-repository': {}, '@/app/lib/file-guests/lifecycle': {},
  });
  await lifecycle.archivePersistedCollaborationStatePathScopes(h.connection as Parameters<typeof lifecycle.archivePersistedCollaborationStatePathScopes>[0],
    { workspaceId: 'workspace', paths: ['folder'], nowMs: 100 });
  const rows = await h.connection.all('SELECT operation_id, status, error_code FROM collaboration_agent_operations ORDER BY operation_id');
  assert.deepEqual(rows.map((row) => [row.operation_id, row.status, row.error_code]), [
    ['applying', 'cancelled', 'document_deleted'], ['checkpointed_file', 'checkpointed_file', null],
    ['needs_review', 'cancelled', 'document_deleted'], ['persisted_yjs', 'persisted_yjs', null],
  ]);
  assert.equal((await h.persistence.loadCollaborationStateIncludingArchived('doc'))?.status, 'archived');
});

test('the activity UI offers revert for persisted operations only to an allowed actor with applied targets', async () => {
  let current: CollaborationAgentOperation = {
    operationId: 'operation', operationStatus: 'persisted_yjs', status: 'applied_to_ydoc', durability: 'persisted_yjs',
    actorId: 'agent', actionsAllowed: true, appliedTargetIds: ['target'], targetAnchors: [], conflicts: [],
  };
  const container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const ui = await compile<typeof OperationsUi>('app/components/editor/CollaborationAgentOperations.tsx', {
    react: { ...React, useState: (initial: unknown) => {
      const actual = React.useState(initial);
      return Array.isArray(initial) ? [[current], () => {}] : actual;
    } },
    'next-intl': { useTranslations: () => (key: string) => key },
    sonner: { toast: { success() {}, error() {} } },
    '@/app/lib/collaboration/agent-operations-client': {}, '@/app/lib/files/client': {},
    '@/components/ui/button': { Button: ({ children, disabled }: { children?: React.ReactNode; disabled?: boolean }) => <button disabled={disabled}>{children}</button> },
    '@/components/ui/popover': { Popover: container, PopoverContent: container, PopoverTrigger: container },
    '@/components/ui/scroll-area': { ScrollArea: container },
    '@/components/ui/tabs': { Tabs: container, TabsContent: container, TabsList: container, TabsTrigger: container },
    '@/lib/utils': { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') },
  });
  const render = () => renderToStaticMarkup(<ui.CollaborationAgentOperations documentId="doc" />);
  assert.match(render(), />agentRevert</u);
  assert.doesNotMatch(render(), /agentActiveChanges/u, 'confirmed operations belong to history instead of permanent active work');
  current = { ...current, actionsAllowed: false };
  assert.doesNotMatch(render(), />agentRevert</u);
  current = { ...current, actionsAllowed: true, appliedTargetIds: [] };
  assert.doesNotMatch(render(), />agentRevert</u);
  current = { ...current, appliedTargetIds: ['target'], operationStatus: 'applied_to_ydoc' };
  assert.doesNotMatch(render(), />agentRevert</u);
  assert.match(render(), /agentActiveChanges/u);
});

test('durable success removes pending highlights while running and review operations remain visible', () => {
  const current: CollaborationAgentOperation = {
    operationId: 'operation', operationStatus: 'persisted_yjs', status: 'applied_to_ydoc', durability: 'persisted_yjs',
    actorId: 'agent', actionsAllowed: true, appliedTargetIds: ['target'], conflicts: [],
    targetAnchors: [{ targetId: 'target', groupId: 'group', startAnchor: 'start', endAnchor: 'end' }],
  };
  for (const status of ['persisted_yjs', 'checkpointed_file', 'reverted'] as const) {
    assert.deepEqual(visibleAgentTargetAnchors([{ ...current, operationStatus: status }]), []);
  }
  for (const status of ['applied_to_ydoc', 'needs_review', 'partially_applied', 'semantic_conflict'] as const) {
    assert.deepEqual(visibleAgentTargetAnchors([{ ...current, operationStatus: status }]), [
      { operationId: 'operation', ...current.targetAnchors[0] },
    ]);
  }
});
