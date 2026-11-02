import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import { stageWorkspaceLinkSourceAuthorityObservation } from '../app/lib/markdown/workspace-source-authority-stage';
import { startWorkspaceProjectionWriter } from './helpers/workspace-projection-writer';

// Genuine cross-process flock and filesystem behavior. The SQL trace models an
// empty catalogue only; this suite does not establish PostgreSQL or ACL authority.
function emptyCatalogueConnection(trace: string[], beforeClose?: () => Promise<void>): SqlConnection {
  let transaction = false;
  return {
    run: async sql => {
      trace.push(sql);
      if (sql.startsWith('BEGIN')) { assert.equal(transaction, false); transaction = true; }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { assert.equal(transaction, true); transaction = false; }
      return { changes: 0 };
    },
    get: async sql => {
      trace.push(sql); assert.equal(transaction, true);
      if (sql.includes('pg_advisory_xact_lock_shared')) return {};
      assert(sql.includes('LEFT JOIN collaboration_documents')); return undefined;
    },
    all: async sql => {
      trace.push(sql); assert.equal(transaction, true);
      assert(sql.includes('has_state_history')); return [];
    },
    close: async () => { trace.push('close'); assert.equal(transaction, false); await beforeClose?.(); },
  };
}

async function ownedFixture(operation: (workspace: WorkspaceContext, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-source-projection-lock-'));
  const previousData = process.env.DATA;
  process.env.DATA = root;
  const files = path.join(root, 'files'); await fs.mkdir(files, { mode: 0o700 });
  const workspace: WorkspaceContext = { workspaceId: `source-projection-${randomUUID()}`, rootPath: files,
    workspaceType: 'personal', organizationId: null, legacy: false, status: 'active', permissions: {
      canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true,
    } };
  try { await operation(workspace, root); }
  finally {
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function writer(workspace: WorkspaceContext, gated: boolean) {
  return startWorkspaceProjectionWriter({ workspaceId: workspace.workspaceId,
    filePath: path.join(workspace.rootPath, 'projection.md'), mode: 'create', content: '# Projected\n', gated });
}

test('source observation waits for a separate projection writer before opening its read transaction', { timeout: 20_000 }, async () =>
  ownedFixture(async workspace => {
    const projection = writer(workspace, true); const trace: string[] = [];
    let observation: ReturnType<typeof stageWorkspaceLinkSourceAuthorityObservation> | undefined;
    let opened = false;
    try {
      await projection.wait('acquired');
      observation = stageWorkspaceLinkSourceAuthorityObservation(workspace, { openConnection: async () => {
        opened = true; return emptyCatalogueConnection(trace);
      } });
      await delay(150);
      assert.equal(opened, false, 'The reader must acquire the existing kernel fence before SQL checkout.');
      projection.child.stdin.end('publish\n');
      const result = await observation;
      assert.equal(result.stage.coverage.complete, true, JSON.stringify(result.stage.coverage.gaps));
      assert.equal(result.stage.sources.length, 1);
      assert.equal(result.stage.sources[0].kind, 'physical');
      assert(trace.includes('COMMIT')); assert.equal(trace.at(-1), 'close');
      const [code] = await projection.exit; assert.equal(code, 0);
    } finally { await projection.close(); await observation?.catch(() => {}); }
  }));

test('source observation retains the kernel fence through filesystem rechecks and connection cleanup', { timeout: 20_000 }, async () =>
  ownedFixture(async workspace => {
    await fs.writeFile(path.join(workspace.rootPath, 'source.md'), '# Source\n');
    const trace: string[] = []; let projection: ReturnType<typeof writer> | undefined;
    let enteredDuringRead = false, enteredBeforeClose = false;
    try {
      const result = await stageWorkspaceLinkSourceAuthorityObservation(workspace, {
        openConnection: async () => emptyCatalogueConnection(trace, async () => {
          assert(projection); enteredBeforeClose = projection.events.has('acquired');
        }),
        afterSourceFingerprint: async () => {
          projection = writer(workspace, false); await projection.wait('attempting'); await delay(150);
          enteredDuringRead = projection.events.has('acquired');
        },
      });
      assert.equal(enteredDuringRead, false, 'Projection must wait until the complete observation ends.');
      assert.equal(enteredBeforeClose, false, 'Close must retain the same kernel fence.');
      assert.equal(result.stage.coverage.complete, true, JSON.stringify(result.stage.coverage.gaps));
      assert.equal(result.stage.sources.length, 1); assert(trace.includes('COMMIT'));
      assert(projection); await projection.wait('published'); const [code] = await projection.exit; assert.equal(code, 0);
      assert.equal(await fs.readFile(path.join(workspace.rootPath, 'projection.md'), 'utf8'), '# Projected\n');
    } finally { await projection?.close(); }
  }));

test('source observation remains reentrant under an existing workspace kernel fence', { timeout: 10_000 }, async () =>
  ownedFixture(async workspace => {
    await fs.writeFile(path.join(workspace.rootPath, 'source.md'), '# Source\n');
    const trace: string[] = [];
    const observation = await withWorkspaceMutationLock(workspace.workspaceId, () =>
      stageWorkspaceLinkSourceAuthorityObservation(workspace, { openConnection: async () => emptyCatalogueConnection(trace) }));
    assert.equal(observation.stage.coverage.complete, true);
    assert(trace.includes('COMMIT')); assert.equal(trace.at(-1), 'close');
  }));

test('an external writer bypassing the kernel protocol still invalidates the source observation', { timeout: 10_000 }, async () =>
  ownedFixture(async workspace => {
    await fs.writeFile(path.join(workspace.rootPath, 'source.md'), '# Source\n');
    const trace: string[] = [];
    const observation = await stageWorkspaceLinkSourceAuthorityObservation(workspace, {
      openConnection: async () => emptyCatalogueConnection(trace),
      afterSourceFingerprint: async () => { await fs.writeFile(path.join(workspace.rootPath, 'source.md'), '# Changed\n'); },
    });
    assert.equal(observation.stage.coverage.complete, false);
    assert.equal(observation.stage.sources.length, 0);
    assert(observation.stage.coverage.gaps.some(gap => gap.code === 'physical-source-changed'));
    assert(trace.includes('ROLLBACK')); assert.equal(trace.includes('COMMIT'), false);
  }));
