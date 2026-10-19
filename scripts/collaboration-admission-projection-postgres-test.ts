import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual original admission/publication/materializer code and one owned PG18
// fixture. No SQL rows, reservations, outcomes, file writers, guards or auth
// results are replaced. This tests internal projection protocol exclusion, not
// a public MCP/OAuth caller, an active Room drain or a completed Move/Delete.
let currentCase = 'setup', groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

export async function collaborationAdmissionProjectionPostgresTest(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error('Admission projection PG exceeded its 180-second bound.', { currentCase, groups }); process.exit(1);
  }, 180_000);
  watchdog.unref();
  try {
    await withNativeCopyMetadataOwnerFixture(async h => {
      const { openDb } = await import('../app/lib/db');
      const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
      const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
      const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
      const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
      const { withCollaborationProjectionPublicationGuard: guard } = await import('../app/lib/collaboration/projection-publication-guard');
      const { CollaborationFileOperationProjectionPendingError } = await import('../app/lib/collaboration/checkpoint-errors');
      const { materializeCollaborationCheckpoint } = await import('../app/lib/collaboration/checkpoint');
      const { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest, collaborationAdmissionLockKey } =
        await import('../app/lib/collaboration/room-admission-contract');
      const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
      const { createCollaborationAdmissionQuiescenceService } = await import('../app/lib/collaboration/room-admission-quiescence');
      const { createCollaborationAdmissionHandoffService } = await import('../app/lib/collaboration/room-admission-handoff');
      const ownerActor = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
      const workspace = await readPostgresWorkspaceForActorOnConnection(h.connection, ownerActor, h.source.workspaceId);
      assert(workspace?.permissions.canRead && workspace.permissions.canWrite);
      assert(/^copy_metadata_[a-f0-9]{32}$/u.test(h.schema)); const schema = `"${h.schema}"`;
      const admission = createCollaborationAdmissionService({ openConnection: openDb });
      const quiescence = createCollaborationAdmissionQuiescenceService({ openConnection: openDb });
      const handoff = createCollaborationAdmissionHandoffService({ openConnection: openDb,
        withMutationLocks: async (workspaceIds, operation) => {
          assert.deepEqual(workspaceIds, [workspace.workspaceId]); return withWorkspaceMutationLock(workspace.workspaceId, operation);
        } });
      const primary = await h.upload('projection-target.md', Buffer.from('# Projection target 🧪\n'));
      const sibling = await h.upload('projection-target.md-sibling.md', Buffer.from('# Unrelated exact scope\n'));
      const nested = await h.upload('projection-subtree/target.md', Buffer.from('# Subtree target\n'));
      const primaryState = await load(h.connection, primary.documentId), siblingState = await load(h.connection, sibling.documentId),
        nestedState = await load(h.connection, nested.documentId);
      assert(primaryState && siblingState && nestedState);
      for (const state of [primaryState, siblingState, nestedState]) {
        assert.equal(state.status, 'active'); assert.equal(state.workspaceId, workspace.workspaceId);
        assert.equal(state.checkpointSequence, state.documentSequence);
      }

      const requestFor = (state: PersistedCollaborationState, scopePath = state.path,
        kind: 'exact' | 'subtree' = 'exact'): CollaborationAdmissionRequest => {
        assert.equal(state.status, 'active');
        const actionPayloadText = JSON.stringify({ version: 1, purpose: 'projection-fence-regression', documentId: state.documentId });
        return captureCollaborationAdmissionRequest({ requestId: crypto.randomUUID(), actorId: 'owner', action: 'move', actionPayloadText,
          actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
          scopes: [{ workspaceId: state.workspaceId, organizationId: state.organizationId, path: scopePath, kind }],
          expectedDocuments: [{ documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
            path: state.path, representation: state.representation, lifecycleGeneration: state.lifecycleGeneration,
            schemaVersion: state.schemaVersion, status: 'active' }] }).request;
      };
      const snapshot = async () => {
        const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
          AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)' OR c.relname='file_revisions')
          ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
        assert(tables.length > 11 && tables.length <= 512); const domain: Record<string, unknown> = {};
        for (const table of tables) {
          assert.equal(typeof table.relname, 'string'); const name = `"${String(table.relname).replaceAll('"', '""')}"`;
          const rows = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${schema}.${name} t
            ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
          assert(rows.length <= 10000); domain[table.relname] = rows;
        }
        const files: unknown[] = [];
        for (const selected of [h.source, h.destination]) {
          const pending = [''];
          while (pending.length) {
            assert(files.length < 10000); const relative = pending.pop()!, full = path.join(selected.rootPath, relative);
            const stat = await fs.lstat(full, { bigint: true }); assert(!stat.isSymbolicLink());
            const entry = { workspaceId: selected.workspaceId, path: relative, dev: String(stat.dev), ino: String(stat.ino),
              mode: String(stat.mode), uid: String(stat.uid), nlink: String(stat.nlink), size: String(stat.size),
              mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
            files.push(stat.isFile() ? { ...entry, sha256: crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex') } : entry);
            if (stat.isDirectory()) for (const name of (await fs.readdir(full)).sort().reverse()) pending.push(path.join(relative, name));
            else assert(stat.isFile());
          }
        }
        return { tables, domain, files };
      };
      const expectDeferred = async (state: PersistedCollaborationState) => {
        // This is the missing P0-only case: no legacy B1 intent exists to make
        // the older pending-original predicate independently reject publication.
        const originals = (await h.admin.query(`SELECT
          (SELECT count(*)::integer FROM ${schema}.workspace_file_operation_move_intents) AS moves,
          (SELECT count(*)::integer FROM ${schema}.workspace_file_operation_delete_intents) AS deletes`)).rows[0];
        assert.deepEqual(originals, { moves: 0, deletes: 0 });
        const before = await snapshot(); let callbacks = 0;
        await assert.rejects(guard(state, async () => { callbacks++; assert.fail('Reserved projection callback must not start.'); }),
          CollaborationFileOperationProjectionPendingError);
        assert.equal(callbacks, 0);
        // Exercise the actual ordinary checkpoint entry too: neither its file
        // writer nor its registry state_version finalizer may be reached.
        await assert.rejects(materializeCollaborationCheckpoint({ state, workspace, actorType: 'system' }),
          CollaborationFileOperationProjectionPendingError);
        assert.deepEqual(await snapshot(), before, 'Deferred projection must preserve every domain row/xmin and workspace inode/bytes.');
      };
      const project = async (state: PersistedCollaborationState) => {
        const before = await load(h.connection, state.documentId); assert(before);
        const bytes = await fs.readFile(path.join(workspace.rootPath, before.path));
        const result = await materializeCollaborationCheckpoint({ state: before, workspace, actorType: 'system' });
        const after = await load(h.connection, before.documentId); assert(after);
        assert.equal(result.state.documentId, before.documentId); assert.equal(result.state.projectionFinalized, true);
        assert.equal(after.documentSequence, before.documentSequence); assert.equal(after.persistedAt, before.persistedAt);
        assert.deepEqual(Buffer.from(after.yjsState), Buffer.from(before.yjsState)); assert.deepEqual(Buffer.from(after.stateVector), Buffer.from(before.stateVector));
        assert.deepEqual(await fs.readFile(path.join(workspace.rootPath, after.path)), bytes);
        const registered = (await h.admin.query(`SELECT state_version FROM ${schema}.collaboration_documents WHERE id=$1`, [after.documentId])).rows;
        assert.equal(registered.length, 1); assert.equal(Number(registered[0].state_version), after.checkpointSequence);
      };

      currentCase = 'unreserved genuine shared guard and ordinary projection';
      let entered = 0;
      assert.equal(await guard(primaryState, async assertCurrent => {
        entered++; await assertCurrent();
        // Independent real backend cannot acquire the exclusive P0 key while
        // this exact publication callback retains its shared session guard.
        await h.admin.query('BEGIN');
        try {
          const held = (await h.admin.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
            [collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0]; assert.equal(held.locked, false);
        } finally { await h.admin.query('ROLLBACK'); }
        await assertCurrent(); return 'unreserved';
      }), 'unreserved');
      assert.equal(entered, 1); await project(primaryState); groups++;

      currentCase = 'durable exact reservation defers before B1 without domain effects';
      const exactRequest = requestFor(primaryState), exact = await admission.reserve(exactRequest);
      assert.equal(exact.status, 'reserved'); assert.equal((await admission.read(exactRequest))?.status, 'reserved');
      await expectDeferred(primaryState); groups++;

      currentCase = 'real cancellation restores ordinary publication';
      const cancelled = await admission.cancel(exactRequest, exact.revision); assert.equal(cancelled.status, 'cancelled');
      await project(primaryState); groups++;

      currentCase = 'exact reservation does not block a different document or path prefix';
      const disjointRequest = requestFor(primaryState), disjoint = await admission.reserve(disjointRequest);
      assert.equal(disjoint.status, 'reserved'); assert(siblingState.path.startsWith(primaryState.path));
      await project(siblingState); await expectDeferred(primaryState);
      assert.equal((await admission.cancel(disjointRequest, disjoint.revision)).status, 'cancelled'); groups++;

      currentCase = 'subtree reservation blocks its native descendant but not an outside document';
      const subtreeRequest = requestFor(nestedState, 'projection-subtree', 'subtree'), subtree = await admission.reserve(subtreeRequest);
      assert.equal(subtree.status, 'reserved'); await expectDeferred(nestedState); await project(primaryState);
      assert.equal((await admission.cancel(subtreeRequest, subtree.revision)).status, 'cancelled'); groups++;

      currentCase = 'proved draining target blocks until genuine no-write terminal abort';
      const terminalRequest = requestFor(primaryState); assert.equal((await admission.reserve(terminalRequest)).status, 'reserved');
      const proof = await quiescence.prove(terminalRequest, primaryState.documentId);
      assert.equal(proof.kind, 'vacant'); assert.equal((await admission.read(terminalRequest))?.status, 'draining');
      await expectDeferred(primaryState); const beforeAbort = await snapshot();
      const outcome = await handoff.abort(terminalRequest, {
        // Trusted internal protocol test caller; this does not substitute or
        // claim public MCP authorization. Re-read the actual fixture owner ACL.
        authorize: async selected => {
          assert.deepEqual(selected, terminalRequest);
          const current = await readPostgresWorkspaceForActorOnConnection(h.connection, ownerActor, workspace.workspaceId);
          assert(current?.permissions.canRead && current.permissions.canWrite);
        },
        prepare: async database => {
          await database.get('SELECT pg_advisory_xact_lock($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
          const current = await load(database, primaryState.documentId); assert(current);
          assert.equal(current.documentSequence, primaryState.documentSequence); assert.equal(current.persistedAt, primaryState.persistedAt);
          assert.deepEqual(Buffer.from(current.yjsState), Buffer.from(primaryState.yjsState));
        },
      }, 'precondition_failed');
      assert.equal(outcome.version, 2); if (outcome.version !== 2) assert.fail('Expected genuine no-write abort outcome.');
      assert.equal(outcome.disposition, 'aborted'); assert.equal(outcome.reasonCode, 'precondition_failed');
      assert.equal((await admission.read(terminalRequest))?.status, 'committed');
      assert.deepEqual(await handoff.readOutcome(terminalRequest), outcome);
      const afterAbort = await snapshot(); assert.deepEqual(afterAbort.tables, beforeAbort.tables); assert.deepEqual(afterAbort.files, beforeAbort.files);
      for (const [table, rows] of Object.entries(beforeAbort.domain)) if (!table.startsWith('collaboration_admission_')) {
        assert.deepEqual(afterAbort.domain[table], rows, 'A genuine protocol abort may not write the native/document/physical domain.');
      }
      await project(primaryState); groups++;
    });
    assert.equal(groups, 6); completed = true;
    console.log('Admission projection PG: 6/6 genuine reservation/publication/materializer families; owned fixture closed; no Room/MCP/OAuth/browser acceptance.');
  } finally { clearTimeout(watchdog); }
}

void collaborationAdmissionProjectionPostgresTest().catch(error => {
  const rawCode = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error('Admission projection PG failed.', { currentCase, groups,
    code: typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(rawCode) ? rawCode : 'UNCLASSIFIED' });
  process.exitCode = 1;
});
