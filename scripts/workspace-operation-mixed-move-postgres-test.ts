import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Actual JWT/session/consent -> fixed public MCP service -> genuine claimed
// Move owner -> FD move, PG18 receipts and native link changes. No browser,
// OAuth issuance or selected-raw-source import acceptance is claimed here.
let phase = 'fixture', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const code = (error: unknown): string | null => error instanceof Error
  && typeof Object.getOwnPropertyDescriptor(error, 'code')?.value === 'string'
  ? Object.getOwnPropertyDescriptor(error, 'code')!.value : null;

export async function workspaceOperationMixedMovePostgresTest(): Promise<void> {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { decodeDirectMcpWorkspaceMoveRequestV1: decode } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { runDirectMcpWorkspaceMoveService: service } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: inspect } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { stageWorkspaceLinkSourceAuthorityObservation } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { captureWorkspaceOperationNativeSourceEvidenceV3 } = await import('../app/lib/files/workspace-operation-native-source-evidence-v3');
    const { workspaceOperationMixedSourceSnapshot } = await import('../app/lib/files/workspace-operation-mixed-source-evidence');
    const { buildWorkspaceMixedReadLinkGraphV3 } = await import('../app/lib/markdown/workspace-native-link-graph');
    const clientId = `mixed-move-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'owner','Actual mixed Move fixture',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'owner','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
      VALUES($1,'owner',100,100) ON CONFLICT(workspace_id) DO NOTHING`, [h.source.workspaceId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
      VALUES($1,'owner',$2,100,100)`, [clientId, h.source.workspaceId]);
    const seconds = Math.floor(Date.now() / 1000);
    const jwt = await auth.api.signJWT({ body: { payload: { sub: 'owner', azp: clientId, sid: 'session-owner',
      iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600,
      scope: 'knowledge:write knowledge:read' } } }); assert(jwt.token);
    const authInfo: AuthInfo = { token: jwt.token, clientId: 'ignored-caller-value', scopes: [] };
    const run = (input: Record<string, unknown>) => service(decode({ api_version: 1, workspace_id: h.source.workspaceId, ...input }), authInfo);
    const sourcePath = 'a-mixed-target.md', destinationPath = 'z-mixed-target.md', incomingPath = 'c-mixed-incoming.md';
    const rawPath = 'b-mixed-raw.md', rawFile = path.join(h.source.rootPath, rawPath);
    const target = await h.upload(sourcePath, Buffer.from('# Mixed target\n\nOriginal native body.\n'));
    const keep = await h.upload('m-mixed-keep.md', Buffer.from('# Keep\n\nA second actual native target.\n'));
    const incoming = await h.upload(incomingPath, Buffer.from(`[Target](${sourcePath}) [[Raw M1]]\n`));
    await h.metadata(h.source, sourcePath, { title: 'Preserved Move title', isFavorite: true, pinned: true });
    const rawBytes = Buffer.from(`---\naliases: [Raw M1]\n---\n# Raw\n\n[Self](${rawPath}) äöü 😀\n`);
    await fs.writeFile(rawFile, rawBytes, { flag: 'wx', mode: 0o600 });
    const rawStamp = async () => ({ identity: filesystemFileVersion(await fs.lstat(rawFile)),
      bytes: crypto.createHash('sha256').update(await fs.readFile(rawFile)).digest('hex') });
    const rawBefore = await rawStamp();
    const rawUnchanged = async () => {
      assert.deepEqual(await rawStamp(), rawBefore);
      assert.deepEqual(await fs.readFile(rawFile), rawBytes);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [h.source.workspaceId, rawPath])).rows[0].n, 0, 'Reading an unselected raw source must not initialize a notebook.');
    };
    const selections = [{ source_path: sourcePath, destination_path: destinationPath }];
    phase = 'actual mixed preview without writes';
    let writes = 0;
    const preview = await h.withProbe(async event => {
      if (/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|NOTIFY)\b/iu.test(event.text)
        || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
    }, () => run({ action: 'preview', selections }));
    assert.equal(writes, 0); assert(preview.action === 'preview');
    assert.equal(preview.preview.linkChanges.rewrites, 1); assert.equal(preview.preview.coverage.complete, true);
    const originalObservation = await stageWorkspaceLinkSourceAuthorityObservation(h.source);
    const originalGraph = buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedSourceSnapshot(
      captureWorkspaceOperationNativeSourceEvidenceV3(captureWorkspaceOperationJobScope(h.source), originalObservation)));
    const originalAlias = originalGraph.edges.find(edge => edge.sourceKind === 'native' && edge.source.documentId === incoming.documentId && edge.literal === 'Raw M1');
    assert(originalAlias);
    assert.equal(originalAlias?.resolution.status, 'resolved'); assert.equal(originalAlias.resolution.target?.path, rawPath);
    assert.equal(originalAlias.resolution.target?.documentId, null);
    assert(originalGraph.edges.some(edge => edge.sourceKind === 'physical-read' && edge.source.path === rawPath
      && edge.resolution.status === 'resolved' && edge.resolution.target?.path === rawPath));
    await rawUnchanged(); groups++;
    phase = 'actual mixed apply and native link rewrite';
    const operationId = crypto.randomUUID(), command = { selections, operation_id: operationId, plan_id: preview.preview.planId };
    const applied = await run({ action: 'apply', ...command }); assert(applied.action === 'apply');
    assert.equal(applied.operation.completion.status, 'confirmed'); assert.equal(applied.operation.execution.finalization, 'complete');
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, sourcePath)), { code: 'ENOENT' });
    assert((await fs.lstat(path.join(h.source.rootPath, destinationPath))).isFile());
    const moved = await load(h.connection, target.documentId), linked = await load(h.connection, incoming.documentId); assert(moved && linked);
    assert.equal(moved.documentId, target.documentId); assert.equal(moved.lifecycleGeneration, target.lifecycleGeneration);
    assert.equal(moved.path, destinationPath); assert.equal(linked.path, incomingPath);
    const inventory = inspect(linked);
    assert(inventory.links.some(link => link.targetPathText === destinationPath));
    assert(inventory.links.some(link => link.literal === 'Raw M1'), 'The unchanged physical alias remains in native content.');
    const finalObservation = await stageWorkspaceLinkSourceAuthorityObservation(h.source);
    const finalGraph = buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedSourceSnapshot(
      captureWorkspaceOperationNativeSourceEvidenceV3(captureWorkspaceOperationJobScope(h.source), finalObservation)));
    const finalAlias = finalGraph.edges.find(edge => edge.sourceKind === 'native' && edge.source.documentId === incoming.documentId && edge.literal === 'Raw M1');
    assert(finalAlias);
    assert.equal(finalAlias?.resolution.status, 'resolved'); assert.equal(finalAlias.resolution.target?.path, rawPath);
    assert(finalGraph.edges.some(edge => edge.sourceKind === 'physical-read' && edge.source.path === rawPath
      && edge.resolution.status === 'resolved' && edge.resolution.target?.path === rawPath));
    const rows = (await h.admin.query('SELECT plan_json FROM workspace_file_operation_batches WHERE batch_id=$1', [applied.operation.batchId])).rows;
    assert.equal(rows.length, 1); const plan = typeof rows[0].plan_json === 'string' ? JSON.parse(rows[0].plan_json) : rows[0].plan_json;
    assert.equal(plan.planIdentityVersion, 3); assert.equal(plan.sourceEvidence.evidenceVersion, 3);
    const intent = (await h.admin.query('SELECT intent_text FROM workspace_file_operation_move_intents WHERE batch_id=$1', [applied.operation.batchId])).rows[0]; assert(intent);
    assert.equal(JSON.parse(intent.intent_text).version, 3);
    const prepared = (await h.admin.query('SELECT preparation_text FROM workspace_file_operation_move_preparations WHERE batch_id=$1', [applied.operation.batchId])).rows[0]; assert(prepared);
    assert.equal(JSON.parse(prepared.preparation_text).version, 2);
    await rawUnchanged(); groups++;
    phase = 'historical retry does not move replacement at old path';
    const replacement = await h.upload(sourcePath, Buffer.from('# New identity at former path\n')); assert.notEqual(replacement.documentId, target.documentId);
    const recovered = await run({ action: 'recover', ...command }); assert(recovered.action === 'recover');
    assert.equal(recovered.alreadyKnown, true); assert.equal(recovered.operation.completion.status, 'confirmed');
    assert.equal((await load(h.connection, replacement.documentId))?.path, sourcePath); await rawUnchanged(); groups++;
    phase = 'stale physical evidence rejects before any action write';
    const secondSelections = [{ source_path: 'm-mixed-keep.md', destination_path: 'd-mixed-keep.md' }];
    const stale = await run({ action: 'preview', selections: secondSelections }); assert(stale.action === 'preview');
    await fs.appendFile(rawFile, '\nChanged after preview.\n');
    writes = 0;
    await h.withProbe(async event => { if (/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|NOTIFY)\b/iu.test(event.text)) writes++; }, async () => {
      await assert.rejects(run({ action: 'apply', selections: secondSelections, operation_id: crypto.randomUUID(), plan_id: stale.preview.planId }),
        error => code(error) === 'PATH_PLAN_CHANGED');
    });
    assert.equal(writes, 0); assert.equal((await load(h.connection, keep.documentId))?.path, 'm-mixed-keep.md');
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, 'd-mixed-keep.md')), { code: 'ENOENT' }); groups++;
    phase = 'actual path receipt COMMIT acknowledgement loss';
    const fresh = await run({ action: 'preview', selections: secondSelections }); assert(fresh.action === 'preview');
    const secondCommand = { selections: secondSelections, operation_id: crypto.randomUUID(), plan_id: fresh.preview.planId };
    const changedRaw = await rawStamp(); let lost = false;
    let pathReceipt: { client: MetadataSqlEvent['client']; batchId: string; intentDigest: string; receiptText: string;
      receiptDigest: string; stepKey: string; pid: number; xid: string } | undefined;
    await h.withProbe(async event => {
      if (/\bINSERT\b/iu.test(event.text) && event.text.includes('workspace_file_operation_move_path_receipts') && !pathReceipt) {
        assert.equal(event.result.rowCount, 1);
        const backend = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        assert.equal(typeof backend.xid, 'string');
        pathReceipt = { client: event.client, batchId: String(event.values[0]), intentDigest: String(event.values[1]),
          receiptText: String(event.values[2]), receiptDigest: String(event.values[3]), stepKey: String(event.values[4]),
          pid: Number(backend.pid), xid: backend.xid };
      }
      if (pathReceipt && event.client === pathReceipt.client && /^COMMIT\s*;?$/iu.test(event.text.trim()) && !lost) {
        const backend = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        assert.equal(Number(backend.pid), pathReceipt.pid); assert.equal(backend.xid, null);
        const committed = (await h.admin.query(`SELECT r.intent_digest,r.receipt_text,r.receipt_digest,r.xmin::text AS xmin,
          i.intent_digest AS original_intent FROM workspace_file_operation_move_path_receipts r
          JOIN workspace_file_operation_move_intents i USING(batch_id) WHERE r.batch_id=$1 AND r.step_key=$2`,
        [pathReceipt.batchId, pathReceipt.stepKey])).rows;
        assert.equal(committed.length, 1); assert.equal(committed[0].intent_digest, pathReceipt.intentDigest);
        assert.equal(committed[0].original_intent, pathReceipt.intentDigest); assert.equal(committed[0].receipt_text, pathReceipt.receiptText);
        assert.equal(committed[0].receipt_digest, pathReceipt.receiptDigest);
        assert.equal(committed[0].xmin, String(BigInt(pathReceipt.xid) % (BigInt(1) << BigInt(32))));
        lost = true; throw Object.assign(new Error('Actual mixed Move path receipt COMMIT acknowledgement lost.'), { code: 'M1_ACK_LOST' });
      }
    }, async () => {
      try { const result = await run({ action: 'apply', ...secondCommand });
        assert(result.action === 'apply'); assert(['confirmed', 'not_confirmed'].includes(result.operation.completion.status));
      } catch (error) {
        assert(!(error instanceof assert.AssertionError)); assert(lost);
        assert(['M1_ACK_LOST', 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED'].includes(code(error) ?? ''), `Unexpected ACK error ${code(error)}`);
      }
    });
    assert(pathReceipt && lost, 'The actual receipt INSERT and successful COMMIT must both have executed.');
    assert.deepEqual(await rawStamp(), changedRaw); groups++;
    phase = 'recover same mixed operation after committed path receipt';
    const final = await run({ action: 'recover', ...secondCommand }); assert(final.action === 'recover');
    assert.equal(final.operation.completion.status, 'confirmed'); assert.equal(final.alreadyKnown, true);
    assert.equal((await load(h.connection, keep.documentId))?.path, 'd-mixed-keep.md');
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, 'm-mixed-keep.md')), { code: 'ENOENT' });
    assert.deepEqual(await rawStamp(), changedRaw); groups++;
    console.log(JSON.stringify({ fixture: 'm1-actual-mixed-move', groups, actualPublicMcpService: true,
      actualOriginalOwner: true, unchangedPhysicalSource: true, nativeLinksRewritten: true,
      actualCatalogueReordering: true, historicalReplacementPreserved: true, stalePhysicalRejectedWithoutWrites: true,
      actualPathReceiptCommitAckLossRecovered: true }));
  });
  complete = true;
}

workspaceOperationMixedMovePostgresTest().catch(error => {
  const describe = (value: unknown, depth = 0): unknown => !(value instanceof Error) || depth > 4 ? null : ({
    name: value.name, code: code(value), message: value instanceof assert.AssertionError ? value.message : undefined,
    ...(value instanceof AggregateError ? { errors: value.errors.slice(0, 4).map(child => describe(child, depth + 1)) } : {}),
    ...(value.cause instanceof Error ? { cause: describe(value.cause, depth + 1) } : {}),
    source: value.stack?.split('\n').filter(line => /(?:app|scripts)\//u.test(line)).slice(0, 4),
  });
  console.error(JSON.stringify({ fixture: 'm1-actual-mixed-move', phase, groups, failure: describe(error) })); process.exitCode = 1;
});
