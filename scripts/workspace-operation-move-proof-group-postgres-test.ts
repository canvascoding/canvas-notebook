import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import type { WorkspaceRequestPrincipalAccess } from '../app/lib/workspaces/request-principal';

// Genuine requests, Store claims, Owner B, raw PG replies and retained recovery.
// Faults change real rows/DDL or lose an actual reply; no successful reply,
// actor or permission is substituted. This is not a compiled HTTP/UI proof.
let complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const errorCode = (error: unknown) => error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
await withNativeCopyMetadataOwnerFixture(async h => {
  const { openDb } = await import('../app/lib/db');
  const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
  const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
  const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
  const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
  const { executeWorkspaceOperationOriginalMove: execute } = await import('../app/lib/files/workspace-operation-original-move-runner');
  const { WORKSPACE_OPERATION_ORIGINAL_MOVE_TABLE_SPECS: specs } = await import('../app/lib/db/workspace-operation-original-move-migration');
  const { loadCollaborationState } = await import('../app/lib/collaboration/persistence');
  const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
  const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
  type Access = Pick<WorkspaceRequestPrincipalAccess, 'workspace' | 'userId' | 'sessionId'>;
  const access = await withWorkspaceRequestPrincipal<Access>(await h.request(h.source, 'owner', true),
    { workspaceId: h.source.workspaceId, permission: 'canWrite' }, async principal => {
      const database = await openDb(); let committed = false;
      await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
      try {
        const result = await withWorkspaceRequestPrincipalOnConnection<Access>(database, principal, async current => {
          await current.assertCurrent();
          return { workspace: current.workspace, userId: current.userId, sessionId: current.sessionId };
        });
        await database.run('COMMIT'); committed = true; return result;
      } finally {
        if (!committed) await database.run('ROLLBACK');
        await database.close(committed ? undefined : new Error('Discarding unsuccessful fixture Principal.'));
      }
    });
  const sourcePath = 'target.md', destinationPath = 'moved/target.md', incomingPath = 'incoming.md';
  const target = await h.upload(sourcePath, Buffer.from('# Original target\n\nKept content.\n'));
  const incoming = await h.upload(incomingPath, Buffer.from('[Target](target.md)\n'));
  for (let index = 0; index < 7; index++) await h.upload(`unrelated-${index}.md`, Buffer.from(`Unrelated ${index}.\n`));
  const plan = await buildWorkspaceOperationBatchPlan({ scope: { workspace: access.workspace, fileOptions: { workspace: access.workspace } },
    actions: [{ reviewId: randomUUID(), kind: 'move', selections: [{ sourcePath, destinationPath }] }] });
  assert.equal(plan.version, 3); assert.equal(plan.readiness, 'ready');
  const batchId = randomUUID(), store = new WorkspaceOperationBatchStore();
  await store.createDirect({ batchId, plan, authorization: { mode: 'direct', actorUserId: access.userId,
    actorId: access.userId, actorType: 'user', actorSessionId: access.sessionId, actorDisplayName: 'Actual group proof fixture',
    requestHash: hash(randomUUID()), jobScope: captureWorkspaceOperationJobScope(access.workspace) } });
  const initial = await store.claim(randomUUID()); assert(initial); assert.equal(initial.batchId, batchId);
  let claimed = initial;
  const documentRows = async () => (await h.admin.query(`SELECT to_jsonb(d) AS document,d.xmin::text AS document_xmin,
    to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin,to_jsonb(s) AS native,s.xmin::text AS native_xmin
    FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
    JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.workspace_id=$1 ORDER BY d.id`, [h.source.workspaceId])).rows;
  const before = await documentRows(), sourceBytes = await readFile(path.join(h.source.rootPath, sourcePath));
  const hasOriginalIntent = async () => Boolean((await h.admin.query(`SELECT 1 FROM workspace_file_operation_move_intents
    WHERE batch_id=$1 AND NOT EXISTS(SELECT 1 FROM workspace_file_operation_move_path_receipts WHERE batch_id=$1)`, [batchId])).rowCount);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const ownerClients = new Set<MetadataSqlEvent['client']>();
  const isActualOwner = (event: MetadataSqlEvent) => {
    // The original Owner's actual lock-identity reply identifies its real B.
    // Admission preparation does not have this continuously held Owner fence.
    if (event.text.includes('AS room_count') && event.result.rows[0]?.workspace_held === true) ownerClients.add(event.client);
    return ownerClients.has(event.client);
  };
  const faults = ['invalid-target', 'changed-trigger', 'reply-loss'] as const;
  for (const fault of faults) {
    ownerClients.clear(); let injected = 0, actualSetReads = 0;
    await assert.rejects(h.withProbe(async event => {
      if (!isActualOwner(event) || !event.text.includes('FROM collaboration_admission_targets')
        || !event.text.includes('document_id = ANY($2::text[])') || !event.text.includes('FOR UPDATE')
        || !await hasOriginalIntent()) return;
      actualSetReads++;
      if (injected) return;
      assert(Array.isArray(event.values[1]) && event.values[1].length > 1 && event.values[1].length <= 8);
      injected++;
      if (fault === 'invalid-target') await event.raw(`UPDATE collaboration_admission_targets SET active=false
        WHERE request_id=$1 AND document_id=$2`, [event.values[0], event.values[1][0]]);
      else if (fault === 'changed-trigger') await event.raw(`ALTER TABLE ${quote(specs[0].table)} DISABLE TRIGGER ${quote(specs[0].immutableTrigger)}`);
      else throw Object.assign(new Error('Lost an actual proof-set acknowledgement.'), { code: 'GROUP_PROOF_ACK_LOST' });
    }, () => store.withClaim(claimed, async claim => {
      assert(await store.heartbeatClaim(claimed));
      return execute({ claim, workspace: access.workspace });
    })), error =>
      errorCode(error) === (fault === 'invalid-target' ? 'JOB_LIFECYCLE_CHANGED'
        : fault === 'changed-trigger' ? 'ORIGINAL_MOVE_STORAGE_CHANGED' : 'GROUP_PROOF_ACK_LOST'));
    assert.equal(injected, 1, 'Reach one actual proof-set reply; never silently replay its failure.');
    assert.equal(actualSetReads, 1, 'A failed actual proof-set read is not retried before the caller explicitly resumes.');
    assert.deepEqual(await documentRows(), before, 'Rejected groups preserve every original document, lineage, state and xmin.');
    assert.deepEqual(await readFile(path.join(h.source.rootPath, sourcePath)), sourceBytes);
    assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_move_path_receipts WHERE batch_id=$1', [batchId])).rows[0].n, 0);
    assert(await store.finishClaim(claimed, { status: 'needs_recovery', errorCode: 'GROUP_PROOF_FIXTURE_FAULT', phase: 'recovery' }));
    await store.enqueue({ batchId, planId: claimed.planId, userId: access.userId, displayName: 'Actual group proof fixture', action: 'resume' });
    const next = await store.claim(randomUUID()); assert(next); assert.equal(next.batchId, batchId); claimed = next;
    console.log('MOVE_PROOF_GROUP_CASE', JSON.stringify({ fault, passed: true, actualReply: true, originalDataPreserved: true }));
  }
  let fallbackInjected = false, peerBlocked = false, groupReads = 0, individualProofReads = 0;
  ownerClients.clear();
  const result = await h.withProbe(async event => {
    if (!isActualOwner(event)) return;
    const groupedRead = event.text.includes('FROM collaboration_admission_targets')
      && event.text.includes('document_id = ANY($2::text[])') && event.text.includes('FOR UPDATE');
    const individualRead = event.text.includes('FROM collaboration_admission_targets') && event.text.includes('document_id = $2 FOR UPDATE');
    const headerRead = event.text.includes('FROM collaboration_admission_requests') && event.text.includes('request_id = $1 FOR UPDATE');
    if (!groupedRead && !individualRead && !headerRead) return;
    if (!await hasOriginalIntent()) return;
    if (groupedRead) {
      assert(Array.isArray(event.values[1]) && event.values[1].length <= 8); groupReads++;
    }
    if (individualRead) individualProofReads++;
    if (!headerRead) return;
    if (!fallbackInjected) {
      // A real unproven row must take the unchanged individual proof writer.
      await event.raw(`UPDATE collaboration_admission_targets SET status='reserved',release_id=NULL,
        quiescence_kind=NULL,quiescence_text=NULL,source_outcome_request_id=NULL
        WHERE request_id=$1 AND document_id=(SELECT document_id FROM collaboration_admission_targets
          WHERE request_id=$1 ORDER BY document_id COLLATE "C" LIMIT 1)`, [event.values[0]]);
      fallbackInjected = true;
    }
    if (!peerBlocked) {
      await h.admin.query('BEGIN');
      try {
        await h.admin.query("SET LOCAL lock_timeout='50ms'");
        await assert.rejects(h.admin.query('UPDATE "user" SET banned=1 WHERE id=$1', [access.userId]), error => errorCode(error) === '55P03');
        peerBlocked = true;
      } finally { await h.admin.query('ROLLBACK'); }
    }
  }, () => store.withClaim(claimed, async claim => {
    assert(await store.heartbeatClaim(claimed));
    const completion = await execute({ claim, workspace: access.workspace });
    assert(await store.finishClaim(claimed, { status: 'applied', completedActions: claimed.totalActions, phase: 'complete' }));
    return completion;
  }));
  assert(fallbackInjected && peerBlocked && groupReads >= 2 && individualProofReads > 0);
  assert(result.native && result.pathReceipts.length === 1);
  const actual = await loadCollaborationState(target.documentId), peer = await loadCollaborationState(incoming.documentId);
  assert(actual && peer); assert.equal(actual.path, destinationPath);
  authoritativeNativeCollaborationSnapshot(actual); authoritativeNativeCollaborationSnapshot(peer);
  const links = await inspectPersistedDocumentLinks(peer);
  assert(links.links.some(link => link.targetPathText === destinationPath));
  const isUnrelated = (row: typeof before[number]) => row.document.id !== target.documentId && row.document.id !== incoming.documentId;
  assert.deepEqual((await documentRows()).filter(isUnrelated), before.filter(isUnrelated));
  console.log('MOVE_PROOF_GROUP_PROOF', JSON.stringify({ passed: true, faultCases: faults.length, retainedOriginalRecovery: true,
    groupReads, groupLimit: 8, peerPolicyWriteBlocked: peerBlocked, realUnprovenFallback: individualProofReads > 0,
    unrelatedRowsAndXminPreserved: true, actualPostgres: true, actualOwner: true, noPositiveReplySubstitution: true }));
});
complete = true;
