import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lstat, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real PG18/FD/Request/Owner and existing fixture closure. Direct SQL below is
// labelled fixture setup only; every Copy birth/link/publication uses the real
// fixed owner. No new managed stack, transport server or generic runner.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
async function nativeCopyHtmlOwnerPostgresTest(): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  const files = ['scripts/workspace-operation-native-copy-html-owner-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-managed-copy-plan-v6.ts', 'app/lib/files/workspace-operation-html-copy-stage.ts',
    'app/lib/files/workspace-operation-native-copy-html-graph.ts', 'app/lib/files/workspace-operation-native-copy-html-link-receipt.ts',
    'app/lib/files/workspace-operation-html-copy-observation.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-native-copy-phase-read.ts', 'app/lib/files/workspace-operation-native-copy-metadata.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/files/workspace-operation-native-source-evidence.ts', 'app/lib/files/workspace-operation-mixed-source-evidence-v5.ts',
    'app/lib/markdown/workspace-native-copy-link-updates-v4.ts', 'app/lib/markdown/workspace-native-link-clone-v4.ts',
    'app/lib/files/workspace-operation-native-copy-public.ts', 'app/lib/files/workspace-operation-native-copy-html-public.ts',
    'app/lib/mcp/server/workspace-copy-tool-contract.ts', 'app/lib/files/workspace-file-operation-service.ts',
    'app/lib/collaboration/native-copy-persistence.ts', 'app/lib/markdown/native-link-mutation-persistence.ts',
    'app/lib/markdown/workspace-native-link-mutations.ts', 'app/lib/filesystem/prepared-workspace-path-copy.ts',
    'scripts/workspace-operation-native-copy-owner-postgres-test.ts', 'scripts/workspace-operation-native-copy-metadata-owner-postgres-test.ts',
    'scripts/workspace-operation-native-copy-views-postgres-test.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(file))])));
  console.log(JSON.stringify({ suite: 'native-copy-html-owner', sourcePins: pins }));
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { previewWorkspaceNativeCopyOperation: preview, executeWorkspaceNativeCopyOperation: execute } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { loadCollaborationStateOnConnection: load, persistCollaborationYDoc } = await import('../app/lib/collaboration/persistence');
    const { createPlainTextYDoc, createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { authoritativeNativeCollaborationSnapshot: snapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { inspectPersistedDocumentLinksV4: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { workspaceOperationNativeCopyPublicPreview: publicPreview } = await import('../app/lib/files/workspace-operation-native-copy-public');
    const store = new WorkspaceOperationStaging(), journal = new WorkspaceOperationJournal();
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
      sourceWorkspace: h.source, destinationWorkspace: h.destination });
    const stablePath = `stable-${crypto.randomUUID()}.md`; await h.upload(stablePath, Buffer.from('# Stable original target\n'));
    const htmlPath = `unrelated-${crypto.randomUUID()}.html`, htmlBytes = Buffer.from(`<p>Unrelated <a href="${stablePath}">stable</a></p>\n`);
    await writeFile(path.join(h.source.rootPath, htmlPath), htmlBytes, { flag: 'wx', mode: 0o600 });
    const htmlIdentity = await lstat(path.join(h.source.rootPath, htmlPath));
    const sourceRow = async (documentId: string) => (await h.admin.query(`SELECT d.id,d.lineage_id,d.path,d.state_version,d.status,
      s.representation,s.yjs_state,s.state_vector,s.document_sequence,s.persisted_at,s.lifecycle_generation
      FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1`, [documentId])).rows[0];
    const ledger = async (id: string) => (await h.admin.query(`SELECT publication_status,publication_fingerprint,private_result,created_at,xmin::text AS xmin
      FROM collaboration_native_copy_receipts WHERE operation_id=$1`, [id])).rows[0];
    const group = async (name: string, run: () => Promise<void>) => { currentCase = name; await run(); groups++; console.log(`PASS native-copy-html-owner ${groups}: ${name}`); };
    type Representation = 'plain_text' | 'tiptap_xml' | 'tiptap_blocks';
    const seed = async (representation: Representation = 'plain_text', folder = false) => {
      const prefix = `html-copy-${crypto.randomUUID()}`, sourcePath = folder ? `${prefix}/note.md` : `${prefix}.md`;
      const keepPath = folder ? `${prefix}/keep.md` : `${prefix}-keep.md`, incomingPath = `${prefix}-incoming.md`;
      const targetPath = folder ? `${prefix}-copied/note.md` : `${prefix}-copy.md`, keepTarget = folder ? `${prefix}-copied/keep.md` : `${prefix}-keep-copy.md`;
      const relative = (target: string) => folder ? path.posix.basename(target) : target;
      const text = `[Self](${relative(sourcePath)})\n\n[Keep](${relative(keepPath)})\n\nOriginal native body.\n`
        + (representation === 'plain_text' ? '<span>Safe inline HTML</span>\n' : '');
      const note = await h.upload(sourcePath, Buffer.from(text)), keep = await h.upload(keepPath, Buffer.from('# Keep\n'));
      const incoming = await h.upload(incomingPath, Buffer.from(`[Original](${sourcePath})\n`));
      // Explicit private representation fixture. It changes real Yjs bytes and
      // the representation column coherently; it is not a user edit claim.
      for (const [id, content] of [[note.documentId, text], [keep.documentId, '# Keep\n']] as const) {
        const doc = representation === 'plain_text' ? createPlainTextYDoc(content) : createRichMarkdownYDoc(content, representation);
        try { assert.equal((await h.admin.query('UPDATE collaboration_yjs_states SET representation=$1,yjs_state=$2,state_vector=$3 WHERE document_id=$4',
          [representation, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), id])).rowCount, 1); }
        finally { doc.destroy(); }
      }
      await h.metadata(h.source, sourcePath, { title: `Original ${representation}`, isFavorite: true, pinned: true }, 'owner');
      await h.metadata(h.source, sourcePath, { isFavorite: true, pinned: true }, 'member');
      const selections = folder ? [{ sourcePath: prefix, destinationPath: `${prefix}-copied` }]
        : [{ sourcePath, destinationPath: targetPath }, { sourcePath: keepPath, destinationPath: keepTarget }];
      const operationId = crypto.randomUUID(), plan = await preview({ origin, request: await h.request(), selections });
      assert.equal(plan.version, 6); assert(plan.version === 6);
      const input = async () => ({ origin, request: await h.request(), operationId, selections, expectedPlanId: plan.planId });
      return { prefix, sourcePath, keepPath, incomingPath, targetPath, keepTarget, note, keep, incoming, selections, operationId, plan, input,
        sourceBefore: await sourceRow(note.documentId), incomingBefore: await sourceRow(incoming.documentId),
        sourceTitles: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, sourcePath])).rows,
        sourcePersonal: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 ORDER BY user_id', [h.source.workspaceId, sourcePath])).rows };
    };
    type Job = Awaited<ReturnType<typeof seed>>;
    const apply = async (job: Job) => execute(await job.input());
    const assertComplete = async (job: Job, result: Awaited<ReturnType<typeof execute>>) => {
      assert.equal(result.execution.status, 'complete', JSON.stringify(result.execution)); assert.equal((await journal.get(job.operationId))?.status, 'completed');
      const birth = await ledger(job.operationId); assert(birth); assert.equal(birth.publication_status, 'published');
      const completion = (await h.admin.query("SELECT receipt_json,xmin::text AS xmin FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='copy-completion'", [job.operationId])).rows[0];
      assert(completion); const body = JSON.parse(completion.receipt_json); assert.equal(body.version, 6); assert.equal(body.stageDigest, birth.publication_fingerprint);
      assert.equal(body.htmlAssessmentProof, job.plan.nativePathPlan.htmlAssessmentProof); assert.equal(completion.xmin, birth.xmin);
      assert.equal(body.metadata.copyCreatedAt, Number(birth.created_at));
      const target = (await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status=$3',
        [h.destination.workspaceId, job.targetPath, 'active'])).rows[0]; assert(target);
      assert.notEqual(target.id, job.note.documentId); assert.notEqual(target.lineage_id, job.sourceBefore.lineage_id);
      const state = await load(h.connection, target.id, true); assert(state); assert.equal(state.lifecycleGeneration, 1);
      const actual = links(state); assert(actual.links.some(link => link.targetPathText === path.posix.basename(job.targetPath)));
      assert(actual.links.some(link => link.targetPathText === path.posix.basename(job.keepTarget)));
      assert.equal(state.documentSequence, job.targetPath.includes('/') ? 0 : 1, 'Folder preserves equal relative spelling; root-file copy rewrites.');
      const row = (await h.admin.query('SELECT title,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, job.targetPath])).rows[0];
      assert.equal(row.title, `Original ${state.representation}`); assert.equal(row.xmin, birth.xmin);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_user_states WHERE workspace_id=$1 AND path=ANY($2::text[])',
        [h.destination.workspaceId, [job.targetPath, job.keepTarget]])).rows[0].n, 0);
      assert.deepEqual(await sourceRow(job.note.documentId), job.sourceBefore); assert.deepEqual(await sourceRow(job.incoming.documentId), job.incomingBefore);
      assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, job.sourcePath])).rows, job.sourceTitles);
      assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2 ORDER BY user_id', [h.source.workspaceId, job.sourcePath])).rows, job.sourcePersonal);
      assert.deepEqual(await readFile(path.join(h.source.rootPath, htmlPath)), htmlBytes);
      assert.equal((await lstat(path.join(h.source.rootPath, htmlPath))).ino, htmlIdentity.ino);
      const receipt = birth.private_result.documents.find((item: { clone: { documentId: string } }) => item.clone.documentId === target.id); assert(receipt);
      assert.notEqual(receipt.clone.documentId, receipt.source.documentId);
      if (state.representation !== 'plain_text') assert(Object.entries(receipt.blockIdMapping).every(([old, fresh]) => old !== fresh));
      assert.equal(await store.loadOwnedCopyByOperationId(job.operationId), null, 'Confirmed Stage7 retires through its exact decoder.');
      return { birth, completion, target, state: snapshot(state) };
    };
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) await group(`${representation}: real independent cross-workspace Copy beside untouched HTML`, async () => {
      const job = await seed(representation), result = await apply(job); await assertComplete(job, result);
      const page = publicPreview(job.plan); assert.equal(page.version, 5); assert.equal(page.coverage.complete, false);
      assert.equal(page.linkAssessment?.complete, true);
    });
    await group('native folder and subtree links keep independent IDs without redirecting original incoming links', async () => {
      const job = await seed('tiptap_blocks', true); await assertComplete(job, await apply(job));
    });
    await group('actual B1 COMMIT ACK loss retains Stage7 and original clone IDs; one recovery publishes', async () => {
      const job = await seed(); let fired = false, b1 = false, ownerPid = 0, ownerXid = '';
      const interrupted = await h.withProbe(async event => {
        if (/^\s*INSERT\s+INTO\s+collaboration_native_copy_receipts\b/iu.test(event.text)) {
          const row = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
          ownerPid = row.pid; ownerXid = row.xid; b1 = true;
        }
        if (b1 && !fired && /^\s*COMMIT\s*$/iu.test(event.text) && (await ledger(job.operationId))?.publication_status === 'native_committed') {
          fired = true; throw new Error('Owned genuine B1 COMMIT acknowledgement loss.');
        }
      }, () => apply(job));
      assert(fired && ownerPid > 0 && /^[1-9][0-9]*$/u.test(ownerXid)); assert.equal(interrupted.execution.status, 'needs_recovery');
      assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED');
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid=$1', [ownerPid])).rows[0].n, 0);
      const before = await ledger(job.operationId); assert.equal(before.publication_status, 'native_committed');
      const retained = await store.loadOwnedCopyByOperationId(job.operationId); assert(retained); assert.equal(retained.version, 7);
      const recovered = await apply(job); assert.equal(recovered.alreadyKnown, true); const after = await assertComplete(job, recovered);
      assert.deepEqual(after.birth.private_result, before.private_result);
    });
    await group('actual B2 rollback retains true contract-2/native4 receipt; retry applies no second link delta', async () => {
      const job = await seed(); let fired = false;
      const interrupted = await h.withProbe(async event => {
        if (!fired && /^\s*INSERT\s+INTO\s+(?:"?\w+"?\.)?"?workspace_file_metadata\b/iu.test(event.text)
          && event.values[0] === h.destination.workspaceId && Array.isArray(event.values[1]) && event.values[1].includes(job.targetPath)) {
          fired = true; throw new Error('Owned B2 title INSERT acknowledgement failure.');
        }
      }, () => apply(job));
      assert(fired); assert.equal(interrupted.execution.status, 'needs_recovery'); assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_PUBLICATION_UNCONFIRMED');
      const before = (await h.admin.query(`SELECT r.operation_id,r.authorized_prepared_proof,r.after_sequence,r.after_state_snapshot,r.xmin::text AS xmin
        FROM collaboration_native_link_mutation_receipts r WHERE r.document_id IN
        (SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2)`, [h.destination.workspaceId, job.targetPath])).rows;
      assert.equal(before.length, 1); assert.match(before[0].authorized_prepared_proof, /^[a-f0-9]{64}$/u); assert.equal(Number(before[0].after_sequence), 1);
      assert.equal((await ledger(job.operationId)).publication_status, 'native_committed');
      const result = await apply(job); await assertComplete(job, result);
      assert.deepEqual((await h.admin.query(`SELECT r.operation_id,r.authorized_prepared_proof,r.after_sequence,r.after_state_snapshot,r.xmin::text AS xmin
        FROM collaboration_native_link_mutation_receipts r WHERE r.document_id IN
        (SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2)`, [h.destination.workspaceId, job.targetPath])).rows, before);
      const rows = (await h.admin.query("SELECT receipt_json FROM workspace_file_operation_steps WHERE operation_id=$1 AND phase='link' AND step_key<>'copy-completion'", [job.operationId])).rows;
      assert.equal(rows.length, 1); const confirmation = JSON.parse(rows[0].receipt_json);
      assert.equal(confirmation.version, 2); assert.equal(confirmation.htmlEvidence.resultEvidenceVersion, 4); assert.equal(confirmation.htmlEvidence.parserVersion, 4);
    });
    await group('completed history preserves a later central target edit and ignores changed D1/raw HTML without writes', async () => {
      const job = await seed(), complete = await assertComplete(job, await apply(job)); const before = await ledger(job.operationId);
      const original = await load(h.connection, complete.target.id, true); assert(original);
      const linksBefore = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_link_mutation_receipts WHERE document_id=$1 ORDER BY operation_id', [complete.target.id])).rows;
      const completionBefore = (await h.admin.query("SELECT *,xmin::text AS xmin FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='copy-completion'", [job.operationId])).rows;
      const journalBefore = await journal.get(job.operationId), document = new Y.Doc();
      try {
        Y.applyUpdate(document, original.yjsState);
        const content = document.getText('content'); content.insert(content.length, '\nLater central target edit.\n');
        const saved = await persistCollaborationYDoc(original.documentId, original.lifecycleGeneration, document, {
          workspaceId: original.workspaceId, organizationId: original.organizationId, path: original.path,
          representation: original.representation, schemaVersion: original.schemaVersion });
        assert.equal(saved.persistenceDisposition, 'advanced'); assert.equal(saved.documentId, original.documentId);
        assert.equal(saved.lifecycleGeneration, original.lifecycleGeneration); assert.equal(saved.documentSequence, original.documentSequence + 1);
        assert.notEqual(snapshot(saved).version.stateProof, snapshot(original).version.stateProof);
      } finally { document.destroy(); }
      await writeFile(path.join(h.source.rootPath, htmlPath), '<iframe src="unknown.md"></iframe>');
      const targetBefore = (await h.admin.query('SELECT s.*,s.xmin::text AS xmin FROM collaboration_yjs_states s JOIN collaboration_documents d ON d.id=s.document_id WHERE d.workspace_id=$1 AND d.path=$2', [h.destination.workspaceId, job.targetPath])).rows;
      const writes: string[] = [];
      try {
        const result = await h.withProbe(async event => { if (/^\s*(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP)\b/iu.test(event.text)) writes.push(event.text); }, () => apply(job));
        assert.equal(result.execution.status, 'complete'); assert.equal(result.alreadyKnown, true); assert.equal(result.plan, null); assert.deepEqual(writes, []);
        assert.deepEqual(await ledger(job.operationId), before);
        assert.deepEqual(await journal.get(job.operationId), journalBefore);
        assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_link_mutation_receipts WHERE document_id=$1 ORDER BY operation_id', [complete.target.id])).rows, linksBefore);
        assert.deepEqual((await h.admin.query("SELECT *,xmin::text AS xmin FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='copy-completion'", [job.operationId])).rows, completionBefore);
        assert.deepEqual((await h.admin.query('SELECT s.*,s.xmin::text AS xmin FROM collaboration_yjs_states s JOIN collaboration_documents d ON d.id=s.document_id WHERE d.workspace_id=$1 AND d.path=$2', [h.destination.workspaceId, job.targetPath])).rows, targetBefore);
      } finally { await writeFile(path.join(h.source.rootPath, htmlPath), htmlBytes); }
    });
    await group('all-user false/null target annotation blocks before Stage7 or native birth', async () => {
      const job = await seed(); await h.admin.query('INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at) VALUES($1,$2,$3,0,NULL,100,100)',
        [h.destination.workspaceId, 'owner', job.targetPath]);
      try { await assert.rejects(apply(job), error => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_METADATA_CHANGED');
        assert.equal(await store.loadOwnedCopyByOperationId(job.operationId), null); assert.equal(await ledger(job.operationId), undefined); assert.equal(await journal.get(job.operationId), null);
      } finally { await h.admin.query('DELETE FROM workspace_file_user_states WHERE workspace_id=$1 AND user_id=$2 AND path=$3', [h.destination.workspaceId, 'owner', job.targetPath]); }
    });
    await group('new opaque HTML is an explicit pre-effect block, with no operation/clone/target birth', async () => {
      const job = await seed(), name = `opaque-${crypto.randomUUID()}.html`, full = path.join(h.source.rootPath, name);
      await writeFile(full, '<unknown value="hidden.md">opaque</unknown>', { flag: 'wx', mode: 0o600 });
      const pin = await lstat(full);
      try {
        await assert.rejects(apply(job), error => error instanceof Error && Reflect.get(error, 'code') === 'MANAGED_COPY_PLAN_UNSUPPORTED');
        assert.equal(await store.loadOwnedCopyByOperationId(job.operationId), null); assert.equal(await journal.get(job.operationId), null);
        assert.equal(await ledger(job.operationId), undefined);
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=ANY($2::text[])',
          [h.destination.workspaceId, [job.targetPath, job.keepTarget]])).rows[0].n, 0);
        await assert.rejects(lstat(path.join(h.destination.rootPath, job.targetPath)), { code: 'ENOENT' });
      } finally {
        const actual = await lstat(full); assert.equal(actual.dev, pin.dev); assert.equal(actual.ino, pin.ino); assert.equal(actual.uid, pin.uid);
        await unlink(full);
      }
    });
    await group('genuine MCP principal uses the same Plan6/Owner/Preview5 and historical status', async () => {
      Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
        CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source' });
      const { auth } = await import('../app/lib/auth');
      const { runDirectMcpWorkspaceCopyService: mcp } = await import('../app/lib/files/workspace-file-operation-service');
      const { decodeDirectMcpWorkspaceCopyRequestV1: decode, formatDirectMcpWorkspaceCopyResult: format } = await import('../app/lib/mcp/server/workspace-copy-tool-contract');
      const job = await seed(), client = `html-copy-mcp-${crypto.randomUUID()}`;
      await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at) VALUES($1,$1,'member','Actual HTML Copy fixture',0,'[]',100,100)`, [client]);
      await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at) VALUES($1,$2,'member','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), client]);
      for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId]) {
        await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at) VALUES($1,'owner',100,100) ON CONFLICT(workspace_id) DO NOTHING`, [workspaceId]);
        await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'member',$2,100,100)`, [client, workspaceId]);
      }
      const seconds = Math.floor(Date.now() / 1000), signed = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: client, sid: 'session-member',
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600, scope: 'knowledge:write knowledge:read' } } }); assert(signed.token);
      const authInfo: AuthInfo = { token: signed.token, clientId: 'untrusted-wrong-client', scopes: [], extra: { userId: 'owner' } };
      const slots = { api_version: 1, source_workspace_id: h.source.workspaceId, destination_workspace_id: h.destination.workspaceId };
      const selected = { selections: job.selections.map(row => ({ source_path: row.sourcePath, destination_path: row.destinationPath })), rename_on_collision: false };
      const observed = await mcp(decode({ ...slots, action: 'preview', ...selected }), authInfo); assert.equal(observed.action, 'preview'); assert(observed.action === 'preview');
      assert.equal(observed.preview.planId, job.plan.planId);
      assert.equal(observed.preview.version, 5); assert.equal(observed.preview.coverage.complete, false); assert(format(observed).structuredContent);
      const result = await mcp(decode({ ...slots, action: 'apply', ...selected, operation_id: job.operationId, plan_id: observed.preview.planId }), authInfo);
      assert.equal(result.action, 'apply'); assert(result.action === 'apply'); assert.equal(result.execution.status, 'complete');
      assert.equal((await ledger(job.operationId)).publication_status, 'published');
      assert.equal((await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [h.destination.workspaceId, job.targetPath])).rows[0].title, 'Original plain_text');
      const status = await mcp(decode({ ...slots, action: 'status', operation_id: job.operationId }), authInfo);
      assert.equal(status.action, 'status'); assert(status.action === 'status'); assert.equal(status.operation.completion.status, 'confirmed');
      const replay = await mcp(decode({ ...slots, action: 'recover', ...selected, operation_id: job.operationId, plan_id: observed.preview.planId }), authInfo);
      assert.equal(replay.action, 'recover'); assert(replay.action === 'recover'); assert.equal(replay.alreadyKnown, true); assert.equal(replay.execution.status, 'complete');
      for (const value of [observed, result, status, replay]) {
        const json = JSON.stringify(format(value)); for (const name of ['nativeBindings', 'nativeComponent', 'yjsState', 'private_result', 'htmlAssessmentProof']) assert(!json.includes(`"${name}"`));
      }
    });
    assert.equal(groups, 10);
  }); completed = true;
  console.log(JSON.stringify({ suite: 'native-copy-html-owner', groups, passed: true, scope: 'actual owner/PG18/FD/Web Request/MCP principal and public envelope; no registered HTTP/TCP/browser or deployment claim' }));
  } finally {
    try { for (const file of files) assert.equal(sha(await readFile(file)), pins[file], `Source changed: ${file}`); }
    finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
  }
}
nativeCopyHtmlOwnerPostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'native-copy-html-owner', failed: true, currentCase, groups,
    code: error && typeof error === 'object' && typeof Object.getOwnPropertyDescriptor(error, 'code')?.value === 'string' ? Object.getOwnPropertyDescriptor(error, 'code')!.value : null,
    name: error instanceof Error ? error.name : 'Unknown',
    message: error instanceof Error ? error.message.slice(0, 3000) : null,
    frames: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 8) : [] })); process.exitCode = 1;
});
