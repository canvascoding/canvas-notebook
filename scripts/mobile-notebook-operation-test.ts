import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import ts from 'typescript';
import { Y } from '../app/lib/collaboration/server-runtime';
import { sha256Text } from '../app/lib/collaboration/persistence';
import { MOBILE_NOTEBOOK_OPERATION_STATEMENTS } from '../app/lib/db/mobile-notebook-operation-migration';
import type * as Operations from '../app/lib/mobile/notebook-operations';
import type * as Notebook from '../app/lib/mobile/notebook';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function compile<T>(filename: string, dependencies: Record<string, unknown>): T {
  const absolute = path.resolve(filename);
  const load = createRequire(absolute);
  const { outputText } = ts.transpileModule(readFileSync(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exports = {};
  new Function('require', 'module', 'exports', outputText)(
    (name: string) => name === 'server-only' ? {} : name in dependencies ? dependencies[name] : load(name),
    { exports }, exports);
  return exports as T;
}

async function main() {
  const database = new DatabaseSync(':memory:');
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'Original');
  try {
    database.exec("PRAGMA foreign_keys=ON; CREATE TABLE collaboration_yjs_states(document_id text PRIMARY KEY); INSERT INTO collaboration_yjs_states VALUES ('doc');");
    // Execute twice to test the additive migration's restart behavior.
    for (let run = 0; run < 2; run++) for (const sql of MOBILE_NOTEBOOK_OPERATION_STATEMENTS) database.exec(sql);
    const bind = (values: unknown[] = []) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value as SQLInputValue]));
    const operations = compile<typeof Operations>('app/lib/mobile/notebook-operations.ts', {
      '@/app/lib/db': { openDb: async () => ({
        get: async (sql: string, values?: unknown[]) => database.prepare(sql).get(bind(values)),
        run: async (sql: string, values?: unknown[]) => database.prepare(sql).run(bind(values)),
        close: async () => {},
      }) },
    });
    const state = { documentId: 'doc', workspaceId: 'workspace', path: 'test.txt', status: 'active',
      lifecycleGeneration: 1, schemaVersion: 1, representation: 'plain_text', documentSequence: 1,
      checkpointSequence: 1, yjsState: Y.encodeStateAsUpdate(doc) };
    let calls = 0;
    let crashBeforeApply = true;
    const notebook = compile<typeof Notebook>('app/lib/mobile/notebook.ts', {
      './notebook-operations': operations,
      '@/app/lib/files/workspace-mutation-lock': { withWorkspaceMutationLock: async (_id: string, apply: () => unknown) => apply() },
      '@/app/lib/filesystem/workspace-files': {
        getFileStats: async () => ({ size: 8, modified: Date.now() }),
        readFile: async () => Buffer.from('Original'),
      },
      '@/app/lib/files/collaboration-policy': {
        getFileCollaborationState: async () => ({ document: { id: 'doc' }, latestRevision: { id: 'revision' }, strategy: 'crdt_text', requiresRevisionCheck: true }),
        ensureFileRevisionForCurrentContent: async () => ({ id: 'revision' }),
      },
      '@/app/lib/collaboration/document-state-service': {
        selectInitialTextCollaborationRepresentation: () => 'plain_text',
        resolveTextCollaborationState: async () => ({ state }),
      },
      '@/app/lib/collaboration/persistence': { sha256Text, loadCollaborationState: async () => state },
      '@/app/lib/collaboration/agent-file-edits': {
        readCurrentCollaborationTextSnapshot: async () => ({ content: doc.getText('content').toString(), sha256: sha256Text(doc.getText('content').toString()) }),
      },
      '@/app/lib/collaboration/direct-connection': {
        runCollaborationDirectConnection: async (input: { requiresFileCheckpointIdentity: boolean }, apply: (live: typeof doc) => unknown) => {
          assert.equal(input.requiresFileCheckpointIdentity, false);
          calls++;
          if (calls === 2 && crashBeforeApply) throw new Error('simulated process loss before live apply');
          const result = apply(doc);
          state.yjsState = Y.encodeStateAsUpdate(doc);
          state.documentSequence++;
          return result;
        },
      },
    });
    const input = {
      workspace: { workspaceId: 'workspace', permissions: { canWrite: true } } as WorkspaceContext,
      fileOptions: {}, actorUserId: 'owner', actorSessionId: 'session',
      path: 'test.txt', content: 'Applied', expectedSha256: sha256Text('Original'),
      baseRevisionId: 'revision', idempotencyKey: 'operation-test-1',
    };
    await assert.rejects(() => notebook.saveMobileNotebookDocument(input), /simulated process loss/);
    assert.equal(doc.getText('content').toString(), 'Original');
    const prepared = database.prepare('SELECT * FROM mobile_notebook_operations').get();
    assert.ok(prepared?.yjs_update, 'the exact delta is recorded before touching the live document');
    crashBeforeApply = false;
    const result = await notebook.saveMobileNotebookDocument(input);
    assert.equal(result.saveReceipt?.durable, true);
    assert.equal(result.saveReceipt?.projectionPending, true);
    assert.equal(doc.getText('content').toString(), 'Applied');
    assert.equal(database.prepare('SELECT yjs_update FROM mobile_notebook_operations').get()?.yjs_update, null);
    // The peer removes all of the mobile edit. Its historical receipt still
    // proves application; a lost-response retry must not insert it again.
    doc.getText('content').delete(0, doc.getText('content').length);
    doc.getText('content').insert(0, 'Peer');
    const retried = await notebook.saveMobileNotebookDocument(input);
    assert.equal(retried.content, 'Peer');
    assert.equal(retried.saveReceipt?.operationId, result.saveReceipt?.operationId);
    await assert.rejects(() => notebook.saveMobileNotebookDocument({ ...input, content: 'Another' }),
      (error: unknown) => error instanceof notebook.MobileNotebookError && error.code === 'IDEMPOTENCY_CONFLICT');
    state.lifecycleGeneration++;
    await assert.rejects(() => notebook.saveMobileNotebookDocument(input),
      (error: unknown) => error instanceof notebook.MobileNotebookError && error.code === 'IDEMPOTENCY_CONFLICT');
    database.exec("DELETE FROM collaboration_yjs_states WHERE document_id='doc'");
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM mobile_notebook_operations').get()?.count, 0);
    console.log('Mobile operation: additive migration, prepare/crash/retry, compaction, later peer deletion, key collision and lifecycle fencing passed.');
  } finally { doc.destroy(); database.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
