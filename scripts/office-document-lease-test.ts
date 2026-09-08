import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { setFileCollaborationConnectionFactoryForTests } from '../app/lib/files/collaboration-repository';
import {
  acquireFileLock, assertFileCollaborationWriteAllowed, assertNoActiveOfficeLeases,
  ensureFileRevisionForCurrentContent, getFileCollaborationState, releaseFileLock, renewFileLock,
} from '../app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-office-lease-'));
  process.env.DATA = root;
  const database = new PGlite();
  try {
    await runPostgresMigrations(database as unknown as Parameters<typeof runPostgresMigrations>[0]);
    setFileCollaborationConnectionFactoryForTests(async () => ({
      get: async (sql, params = []) => (await database.query(sql, params)).rows[0],
      all: async (sql, params = []) => (await database.query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await database.query(sql, params)).affectedRows ?? 0 }),
      close: () => undefined,
    }));
    for (const workspaceType of ['personal', 'team'] as const) {
      const workspace: WorkspaceContext = {
        workspaceId: `office-${workspaceType}`, workspaceType, rootPath: root,
        organizationId: null, ownerUserId: 'alice', legacy: false,
        permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
      };
      const docPath = 'folder/document.docx';
      const base = await ensureFileRevisionForCurrentContent({ workspace, path: docPath, contentHash: 'a'.repeat(64), sizeBytes: 10 });
      const state = await getFileCollaborationState({ workspace, path: docPath, ensureDocument: true });
      assert.equal(state.lockRequired, true);
      assert.equal(state.lineageId, base.lineageId);
      const write = { workspace, path: docPath, actorUserId: 'alice', actorSessionId: 'tab-a', baseRevisionId: base.id };
      const isCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
      await assert.rejects(() => assertFileCollaborationWriteAllowed(write), isCode('FILE_LOCK_REQUIRED'));
      await assert.rejects(() => acquireFileLock({ workspace, path: docPath, lockedByUserId: 'alice' }), isCode('FILE_LOCK_SESSION_REQUIRED'));
      const { lock } = await acquireFileLock({ workspace, path: docPath, lockedByUserId: 'alice', lockedBySessionId: 'tab-a', baseRevisionId: base.id });
      for (const [user, session] of [['alice', 'tab-b'], ['alice', 'agent-run'], ['bob', 'tab-a']]) {
        await assert.rejects(() => acquireFileLock({ workspace, path: docPath, lockedByUserId: user, lockedBySessionId: session }), isCode('FILE_LOCKED'));
        await assert.rejects(() => assertFileCollaborationWriteAllowed({ ...write, actorUserId: user, actorSessionId: session, lockId: lock.id }), isCode('FILE_LOCKED'));
      }
      await assert.rejects(() => assertFileCollaborationWriteAllowed(write), isCode('FILE_LOCK_STALE'));
      await assertFileCollaborationWriteAllowed({ ...write, lockId: lock.id });
      await assert.rejects(() => assertNoActiveOfficeLeases(workspace, ['folder']), isCode('FILE_LOCKED'));
      await assertNoActiveOfficeLeases(workspace, ['unrelated']);
      await assert.rejects(() => releaseFileLock({ workspace, lockId: lock.id, actorUserId: 'alice', actorSessionId: 'tab-b' }), isCode('FILE_LOCK_PERMISSION_DENIED'));
      const renewed = await renewFileLock({ ...write, actorSessionId: 'tab-a', lockId: lock.id, nowMs: lock.expiresAt - 1, ttlMs: 30_000 });
      assert.equal(renewed.lock.id, lock.id);
      await assert.rejects(() => renewFileLock({ ...write, actorSessionId: 'tab-a', lockId: lock.id, nowMs: renewed.lock.expiresAt }), isCode('FILE_LOCK_STALE'));
      const replacement = await acquireFileLock({ workspace, path: docPath, lockedByUserId: 'alice', lockedBySessionId: 'tab-a', nowMs: renewed.lock.expiresAt });
      assert.notEqual(replacement.lock.id, lock.id);
      await assert.rejects(() => assertFileCollaborationWriteAllowed({ ...write, lockId: lock.id, nowMs: renewed.lock.expiresAt + 1 }), isCode('FILE_LOCK_STALE'));
      await assert.rejects(() => renewFileLock({ ...write, actorSessionId: 'tab-a', lockId: lock.id, nowMs: renewed.lock.expiresAt + 1 }), isCode('FILE_LOCK_STALE'));
      await assertFileCollaborationWriteAllowed({ ...write, lockId: replacement.lock.id, nowMs: renewed.lock.expiresAt + 1 });
      console.log(`PASS ${workspaceType}: session ownership, expiry, fencing, renewal, descendant path guard`);
    }
  } finally {
    setFileCollaborationConnectionFactoryForTests(null);
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
