import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CollaborationDirectActivitySession } from '../app/lib/collaboration/direct-activity-session';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

// Actual activity runtime, Better Auth and PostgreSQL. These cases isolate the
// post-consumer observation; the mobile browser case also covers a live room,
// durable mutation, failed file export and retry after a later peer edit.
await withNativeCopyMetadataOwnerFixture(async h => {
  const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
  const { loadCollaborationState } = await import('../app/lib/collaboration/persistence');
  const { createCollaborationServer } = await import('../server/collaboration-server');
  const { createCollaborationRoomOwnerOptions } = await import('../app/lib/collaboration/room-owner-options');
  const { withCollaborationDirectActivitySession: activity } = await import('../app/lib/collaboration/direct-activity-session');
  const { AgentDirectConnectionAuthorizationError } = await import('../app/lib/collaboration/direct-connection');
  const { CollaborationAdmissionError, collaborationAdmissionLockKey, collaborationAdmissionActionDigest } = await import('../app/lib/collaboration/room-admission-contract');
  const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
  const { openDb } = await import('../app/lib/db');
  const filePath = 'activity-completion/original.md', content = '# Original\n\nRetained native content.\n';
  const native = await h.upload(filePath, Buffer.from(content));
  const selected = await requireRequestWorkspace(await h.request(h.source, 'owner', true), { permissions: 'canWrite' });
  assert.equal(selected.response, null);
  if (selected.response) assert.fail('The genuine owner request was rejected.');
  const state = await loadCollaborationState(native.documentId); assert(state);
  const scope = { documentId: native.documentId, workspaceId: selected.workspace.workspaceId,
    organizationId: selected.workspace.organizationId ?? null, path: filePath,
    representation: state.representation, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion };
  const input = { documentId: scope.documentId, documentPath: scope.path,
    documentRepresentation: scope.representation, documentLifecycleGeneration: scope.lifecycleGeneration,
    documentSchemaVersion: scope.schemaVersion, requiresFileCheckpointIdentity: false,
    workspace: selected.workspace, actorType: 'user' as const, actorId: selected.session.user.id,
    initiatedByUserId: selected.session.user.id, actorDisplayName: 'Actual completion fixture',
    actorSessionId: String(selected.session.session.id), operationId: randomUUID() };
  const target = async () => ({
    registry: (await h.admin.query('SELECT to_jsonb(d) AS body,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [scope.documentId])).rows,
    native: (await h.admin.query('SELECT to_jsonb(s) AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [scope.documentId])).rows,
    bytes: await readFile(path.join(h.source.rootPath, filePath)),
  });
  let baseline = await target(), groups = 0;
  const unchanged = async () => assert.deepEqual(await target(), baseline, 'The completion checks cannot mutate the original target.');
  const admissionConflict = (error: unknown) => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT';
  const key = collaborationAdmissionLockKey(scope.workspaceId);
  const admission = createCollaborationAdmissionService({ openConnection: openDb });
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = createCollaborationServer(server, { roomOwner: createCollaborationRoomOwnerOptions() });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    assert.equal(await activity(input, async session => { await session.assertOpen(); return 'original-result'; }), 'original-result');
    await unchanged(); groups++;

    // Acquire the peer only AFTER strict entry/consumer authorization. The
    // old final writer try-lock rejected this already completed operation.
    let retained: CollaborationDirectActivitySession | undefined;
    try {
      assert.equal(await activity(input, async session => {
        retained = session; await session.assertOpen();
        await h.admin.query('BEGIN'); await h.admin.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key]);
        return 'completed-under-real-reader';
      }), 'completed-under-real-reader');
    } finally { await h.admin.query('ROLLBACK'); }
    assert(retained);
    await assert.rejects(retained.assertOpen(), error => error instanceof Error && Reflect.get(error, 'code') === 'ROOM_OWNER_BUSY');
    await unchanged(); groups++;

    try {
      await assert.rejects(activity(input, async () => {
        await h.admin.query('BEGIN'); await h.admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
        return 'must-not-escape-an-exclusive-writer';
      }), admissionConflict);
    } finally { await h.admin.query('ROLLBACK'); }
    await unchanged(); groups++;

    try {
      await assert.rejects(activity(input, async session => {
        await h.admin.query('BEGIN'); await h.admin.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key]);
        // The public facade must ignore caller-supplied mode selectors and
        // retain strict writer admission, including after the local patch.
        await Reflect.apply(session.assertOpen, session, ['completion', true]);
        assert.fail('An exposed current check must never select shared completion.');
      }), admissionConflict);
    } finally { await h.admin.query('ROLLBACK'); }
    await unchanged(); groups++;

    let cancel: (() => Promise<unknown>) | undefined;
    try {
      await assert.rejects(activity(input, async () => {
        const actionPayloadText = JSON.stringify({ kind: 'actual-completion-reservation' });
        const request = { requestId: randomUUID(), actorId: input.actorId, action: 'compact' as const,
          actionPayloadText, actionDigest: collaborationAdmissionActionDigest('compact', actionPayloadText),
          scopes: [{ workspaceId: scope.workspaceId, organizationId: scope.organizationId, path: scope.path, kind: 'exact' as const }],
          expectedDocuments: [{ ...scope, status: 'active' as const }] };
        const reserved = await admission.reserve(request); assert.equal(reserved.status, 'reserved');
        cancel = () => admission.cancel(request, reserved.revision);
        return 'must-not-escape-an-active-reservation';
      }), admissionConflict);
    } finally { if (cancel) await cancel(); }
    await unchanged(); groups++;

    const expiry = (await h.admin.query('SELECT expires_at FROM "session" WHERE id=$1', [input.actorSessionId])).rows[0].expires_at;
    try {
      await assert.rejects(activity(input, async () => {
        await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1', [input.actorSessionId]);
        return 'must-not-escape-expired-authentication';
      }), error => error instanceof Error && Reflect.get(error, 'code') === 'COLLABORATION_ACCESS_REVOKED');
    } finally { await h.admin.query('UPDATE "session" SET expires_at=$2 WHERE id=$1', [input.actorSessionId, expiry]); }
    await unchanged(); groups++;

    try {
      await assert.rejects(activity(input, async () => {
        await h.admin.query('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [scope.documentId, 'activity-completion/replaced.md']);
        return 'must-not-escape-changed-native-identity';
      }), error => error instanceof AgentDirectConnectionAuthorizationError
        && error.message === 'Collaboration document identity, lifecycle, or representation is unavailable or stale.');
    } finally { await h.admin.query('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [scope.documentId, scope.path]); }
    // This deliberate committed identity fault changes only the fixture's
    // native xmin. Its original fields and binary bytes must be restored.
    const restored = await target();
    assert.deepEqual(restored.native.map(row => row.body), baseline.native.map(row => row.body));
    assert.deepEqual(restored.registry, baseline.registry); assert.deepEqual(restored.bytes, baseline.bytes);
    baseline = restored; await unchanged(); groups++;
    assert.equal(await activity(input, async () => 'fresh-restored-control'), 'fresh-restored-control');
    await unchanged(); groups++;
    console.log(JSON.stringify({ suite: 'native-direct-activity-completion', groups,
      actualSharedReaderAllowed: true, actualExclusiveWriterDenied: true, actualReservationDenied: true,
      publicSelectorBypassDenied: true, disposedFacadeDenied: true, expiredSessionDenied: true,
      changedIdentityDenied: true, originalNativeAndFileBytesRetained: true }));
  } finally {
    await h.admin.query('ROLLBACK');
    await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
completed = true;
