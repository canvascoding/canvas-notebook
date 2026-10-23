import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { JSONContent } from '@tiptap/core';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { NativeCollaborationContent } from '../app/lib/collaboration/document-snapshot';
import type { DirectMcpWorkspacePathOperationV1, DirectMcpWorkspacePathResultV1 } from '../app/lib/mcp/server/workspace-path-tool-contract';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Structurally matching retained counterexample, not the original production
// binary: genuine public MCP service/current JWT -> actual native Move/Delete
// Owner. A legal rich table remains unexportable throughout. No Markdown
// serialization is used as the native content oracle. No HTTP/TCP/browser claim.
function unexportableNativePathFailureFrames(error: unknown): unknown {
  const seen = new Set<unknown>(); let remaining = 12;
  const redact = (value: string) => value.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[jwt-redacted]')
    .replace(/\b(password|secret|token|authorization)\s*[=:]\s*\S+/giu, '$1=[redacted]').slice(0, 600);
  const visit = (value: unknown, depth: number): unknown => {
    if (!(value instanceof Error)) return { type: typeof value };
    if (seen.has(value) || depth > 4 || remaining-- <= 0) return { name: 'DiagnosticBound' };
    seen.add(value); const code: unknown = Object.getOwnPropertyDescriptor(value, 'code')?.value;
    return { name: redact(value.name), message: redact(value.message),
      code: typeof code === 'string' && /^[A-Za-z0-9_]{1,96}$/u.test(code) ? code : null,
      frames: value.stack?.split('\n').slice(1, 7).map(redact),
      ...(Object.hasOwn(value, 'cause') ? { cause: visit(Object.getOwnPropertyDescriptor(value, 'cause')?.value, depth + 1) } : {}),
      ...(value instanceof AggregateError ? { errors: [...value.errors].slice(0, 8).map(item => visit(item, depth + 1)) } : {}) };
  };
  return visit(error, 0);
}

export async function workspaceOperationUnexportableNativePathPublicPostgresTest(): Promise<void> {
  let currentCase = 'setup', groups = 0, noWriteScopes = 0;
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { decodeDirectMcpWorkspaceMoveRequestV1: decodeMove, decodeDirectMcpWorkspaceDeleteRequestV1: decodeDelete } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { runDirectMcpWorkspaceMoveService: move, runDirectMcpWorkspaceDeleteService: remove } = await import('../app/lib/files/workspace-file-operation-service');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { authoritativeNativeCollaborationSnapshot: snapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { inspectArchivedNativeSnapshot } = await import('../app/lib/collaboration/archived-native-snapshot');
    const { authoritativeCollaborationSnapshot: strictExport, materializeCollaborationCheckpoint } = await import('../app/lib/collaboration/checkpoint');
    const { CollaborationCheckpointValidationError } = await import('../app/lib/collaboration/checkpoint-errors');
    const { classifyCollaborationProjectionError } = await import('../app/lib/collaboration/projection-errors');
    const { loadCollaborationProjectionWorkspace, recordCollaborationProjectionFailure } = await import('../app/lib/collaboration/projection-repository');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { getSchema } = await import('@tiptap/core');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { createRichMarkdownYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const { DocumentReadError } = await import('../app/lib/documents/contracts');
    const { inspectPersistedDocumentLinksV3: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
    // Public native reads carry JSON values, not ProseMirror's internal
    // null-prototype attribute objects. Keep all JSON fields and array order.
    const jsonContent = (content: NativeCollaborationContent): NativeCollaborationContent => JSON.parse(JSON.stringify(content));
    // Seed an actually importable rich representation through the real upload
    // service before adding the retained, legal but unexportable cell widths.
    const richUploadBytes = (markdown: string): Buffer => {
      const doc = createRichMarkdownYDoc(markdown, 'tiptap_blocks');
      try {
        assert.equal(validateRichMarkdownYDoc(doc).valid, true);
        return Buffer.from(richMarkdownFromYDoc(doc));
      } finally { doc.destroy(); }
    };
    const group = async (name: string, action: () => Promise<void>) => {
      currentCase = name; await action(); groups++; console.log(`PASS unexportable-native-path-public ${groups}: ${name}`);
    };

    // Real mutable authorization setup, outside every NoWrite scope. The stale
    // fixture WorkspaceContext stays READ-only and never acts as an ACL grant.
    await upsertPostgresWorkspaceMemberForActor(resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }),
      h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1
      WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    assert.equal(h.source.permissions.canWrite, false);
    const clientId = `unexportable-path-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','Retained native rich public path fixture',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
      VALUES($1,'owner',100,100)`, [h.source.workspaceId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
      VALUES($1,'member',$2,100,100)`, [clientId, h.source.workspaceId]);
    const seconds = Math.floor(Date.now() / 1000), signed = await auth.api.signJWT({ body: { payload: {
      sub: 'member', azp: clientId, sid: 'session-member', iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp',
      iat: seconds - 1, exp: seconds + 1800, scope: 'knowledge:read knowledge:write' } } }); assert(signed.token);
    const authInfo: AuthInfo = { token: signed.token, clientId: 'untrusted-ignored-client', scopes: [], extra: { userId: 'owner' } };
    const slots = { api_version: 1, workspace_id: h.source.workspaceId };

    const domain = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 11 && tables.length <= 512); const rows: Record<string, unknown> = {};
      for (const table of tables) {
        const tableName = `"${String(table.relname).replaceAll('"', '""')}"`;
        const actual = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${tableName} t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert(actual.length <= 10000); rows[String(table.relname)] = actual;
      }
      return { tables, rows };
    };
    const filesystem = async () => {
      const rows: unknown[] = [];
      const visit = async (relative: string): Promise<void> => {
        assert(rows.length < 10000); const full = path.join(h.dataRoot, relative), st = await fs.lstat(full, { bigint: true });
        assert(!st.isSymbolicLink()); const entry = { path: relative, dev: String(st.dev), ino: String(st.ino), mode: String(st.mode),
          size: String(st.size), mtime: String(st.mtimeNs), ctime: String(st.ctimeNs) };
        rows.push(st.isFile() ? { ...entry, sha256: sha(await fs.readFile(full)) } : entry);
        if (st.isDirectory()) for (const child of (await fs.readdir(full)).sort()) await visit(path.join(relative, child));
      };
      await visit(''); return rows;
    };
    const noWrites = async <T>(action: () => Promise<T>): Promise<T> => {
      const beforeDomain = await domain(), beforeFiles = await filesystem(), writes: string[] = [], failures: unknown[] = [];
      let value!: T;
      try { value = await h.withProbe(async event => {
        if (['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'NOTIFY'].includes(event.result.command)
          || /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|NOTIFY)\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes.push(event.text);
      }, action); } catch (error) { failures.push(error); }
      // All actual oracles run even if the service or a preceding oracle fails.
      try { assert.deepEqual(writes, []); } catch (error) { failures.push(error); }
      try { assert.deepEqual(await domain(), beforeDomain); } catch (error) { failures.push(error); }
      try { assert.deepEqual(await filesystem(), beforeFiles); } catch (error) { failures.push(error); }
      noWriteScopes++;
      if (failures.length) throw new AggregateError(failures, 'Public path NoWrite scope failed.');
      return value;
    };
    const persisted = async (documentId: string, archived = false): Promise<PersistedCollaborationState> => {
      const value = await load(h.connection, documentId, archived); assert(value); return value;
    };
    const registry = async (documentId: string) => {
      const rows = (await h.admin.query('SELECT id,path,status,lineage_id FROM collaboration_documents WHERE id=$1', [documentId])).rows;
      assert.equal(rows.length, 1); return rows[0];
    };
    const strictStillFails = (state: PersistedCollaborationState) => assert.throws(() => strictExport(state), error =>
      error instanceof CollaborationCheckpointValidationError && error.code === 'COLLABORATION_ROUNDTRIP_UNSTABLE'
        && error.validationCode === 'roundtrip_unstable');
    const nativeRead = async (state: PersistedCollaborationState, lineageId: string) => {
      const page = await readDocumentForRequest(await h.request(), { apiVersion: 1, workspaceId: h.source.workspaceId,
        documentId: state.documentId, format: 'native', maxBytes: 262144 });
      assert.equal(page.complete, true); assert.equal(page.nextCursor, null); assert.equal(page.byteOffset, 0);
      assert.equal(page.mediaType, 'application/vnd.canvas.native-document+json');
      assert.equal(page.document.documentId, state.documentId); assert.equal(page.document.lineageId, lineageId);
      assert.equal(page.document.path, state.path); assert.equal(page.document.lifecycleGeneration, state.lifecycleGeneration);
      assert.equal(page.currency.source, 'persisted_yjs'); assert.equal(page.currency.observedDurable, true);
      assert.equal(page.currency.durableSequence, state.documentSequence); assert.notEqual(page.projection.status, 'current');
      const body: { bodyVersion: number; representation: string; content: NativeCollaborationContent } = JSON.parse(page.fragment);
      assert.equal(body.bodyVersion, 1); assert.equal(body.representation, state.representation);
      assert.deepEqual(body.content, jsonContent(snapshot(state).content)); return body.content;
    };
    const markdownReadFails = async (documentId: string) => assert.rejects(async () =>
      readDocumentForRequest(await h.request(), { apiVersion: 1, workspaceId: h.source.workspaceId, documentId, format: 'markdown' }),
    error => error instanceof DocumentReadError && error.code === 'DOCUMENT_FORMAT_UNAVAILABLE');
    const confirmed = (result: DirectMcpWorkspacePathResultV1, operationId: string, planId: string): DirectMcpWorkspacePathOperationV1 => {
      assert.notEqual(result.action, 'preview'); if (result.action === 'preview') assert.fail('Expected confirmed operation.');
      assert.equal(result.operation.operationId, operationId); assert.equal(result.operation.planId, planId);
      assert.equal(result.operation.workspaceId, h.source.workspaceId);
      assert.equal(result.operation.completion.status, 'confirmed'); assert.equal(result.operation.execution.finalization, 'complete');
      assert.equal(result.operation.execution.receiptStatus, 'available'); return result.operation;
    };
    const changedLinkContent = (original: NativeCollaborationContent, before: string, after: string | null): NativeCollaborationContent => {
      assert.equal(original.kind, 'rich_text'); if (original.kind !== 'rich_text') assert.fail('Rich fixture required.');
      const copied: NativeCollaborationContent = JSON.parse(JSON.stringify(original)); assert.equal(copied.kind, 'rich_text');
      if (copied.kind !== 'rich_text') assert.fail('Rich fixture required.');
      let changed = 0;
      const visit = (node: JSONContent): void => {
        if (node.marks) node.marks = node.marks.filter(mark => {
          if (mark.type !== 'link' || mark.attrs?.href !== before) return true;
          changed++; if (after === null) return false;
          mark.attrs = { ...mark.attrs, href: after }; return true;
        });
        // Native JSON represents no marks by omission, as the original schema
        // serializer does. Preserve every other attr, ID, node and mark exactly.
        if (node.marks?.length === 0) delete node.marks;
        for (const child of node.content ?? []) visit(child);
      };
      visit(copied.document); assert.equal(changed, 1);
      // Removing a link mark joins adjacent text with identical markup in the
      // actual native ProseMirror reader. Canonicalize only this expected tree;
      // complete actual JSON, attrs, IDs and unrelated marks stay untouched.
      const expected = getSchema(richMarkdownSchemaExtensions()).nodeFromJSON(copied.document);
      expected.check(); copied.document = expected.toJSON(); return jsonContent(copied);
    };
    const colwidths = (content: NativeCollaborationContent) => {
      assert.equal(content.kind, 'rich_text'); if (content.kind !== 'rich_text') assert.fail('Rich fixture required.');
      const values: unknown[] = [];
      const visit = (node: JSONContent) => { if (['tableCell', 'tableHeader'].includes(node.type ?? '')) values.push(node.attrs?.colwidth);
        for (const child of node.content ?? []) visit(child); };
      visit(content.document); assert(values.length >= 2); assert(values.every(value => JSON.stringify(value) === '[120]')); return values;
    };

    for (const projection of ['absent', 'empty'] as const) {
      currentCase = `${projection}: actual native fixture preparation`;
      const prefix = `retained-${projection}-${crypto.randomUUID()}`, sourcePath = `${prefix}.md`, keepPath = `${prefix}-keep.md`, incomingPath = `${prefix}-incoming.md`;
      const renamedKeepPath = `${prefix}-renamed-keep.md`;
      const directory = `${prefix}-moved`, destinationPath = `${directory}/target.md`, movedKeepHref = `../${renamedKeepPath}`;
      await fs.mkdir(path.join(h.source.rootPath, directory), { mode: 0o700 });
      const keep = await h.upload(keepPath, Buffer.from('# Unchanged keep note\n'));
      const target = await h.upload(sourcePath, richUploadBytes(`| Retained rich table | Other |\n| --- | --- |\n| [Keep](${keepPath}) | Still here Ω |\n`));
      const incoming = await h.upload(incomingPath, richUploadBytes(`[Original](${sourcePath}) and [Keep](${keepPath}).\n`));
      const initial = await persisted(target.documentId); assert.equal(initial.representation, 'tiptap_blocks');
      const initialRegistry = await registry(target.documentId), incomingRegistry = await registry(incoming.documentId), keepRegistry = await registry(keep.documentId);
      const doc = new Y.Doc({ gc: true }); let richBytes: Buffer, richVector: Buffer;
      try {
        Y.applyUpdate(doc, initial.yjsState);
        const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions())); let cells = 0;
        for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
          (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [120]); cells++;
        }
        assert(cells >= 2); assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
        richBytes = Buffer.from(Y.encodeStateAsUpdate(doc)); richVector = Buffer.from(Y.encodeStateVector(doc));
      } finally { doc.destroy(); }
      // Genuine private fixture seeding only, before all tested Owner actions.
      // Existing upload-born identity/lineage remain real. Old projection hashes
      // cannot certify this changed native state and are deliberately cleared.
      const nextSequence = initial.documentSequence + 1, persistedAt = Date.now();
      assert.equal((await h.admin.query(`UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,
        document_sequence=$4,persisted_at=$5,checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL,
        degraded=0,projection_error_code=NULL,projection_error_phase=NULL,projection_error_cause=NULL,
        projection_error_sequence=NULL,projection_error_generation=NULL,projection_error_permanent=0
        WHERE document_id=$1 AND document_sequence=$6 RETURNING document_id`,
      [target.documentId, richBytes, richVector, nextSequence, persistedAt, initial.documentSequence])).rowCount, 1);
      assert.equal((await h.admin.query('UPDATE collaboration_documents SET state_version=$2,updated_at=$3 WHERE id=$1 RETURNING id',
        [target.documentId, nextSequence, persistedAt])).rowCount, 1);
      await h.admin.query(`UPDATE collaboration_file_projections SET projected_sequence=0,canonical_hash=NULL,serialized_hash=NULL,
        revision_id=NULL,finalized=0,updated_at=$2 WHERE document_id=$1`, [target.documentId, persistedAt]);
      const originalFile = path.join(h.source.rootPath, sourcePath), movedFile = path.join(h.source.rootPath, destinationPath);
      if (projection === 'absent') await fs.unlink(originalFile);
      else await fs.truncate(originalFile, 0);
      const absent = async (file: string) => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
      const emptyIdentity = projection === 'empty' ? await fs.lstat(originalFile, { bigint: true }) : null;
      if (emptyIdentity) { assert(emptyIdentity.isFile() && !emptyIdentity.isSymbolicLink()); assert.equal(emptyIdentity.size, BigInt(0));
        assert.equal(sha(await fs.readFile(originalFile)), sha(Buffer.alloc(0))); }
      else await absent(originalFile);
      let originalRich = await persisted(target.documentId), originalContent = jsonContent(snapshot(originalRich).content);
      colwidths(originalContent); strictStillFails(originalRich);
      let incomingBefore = await persisted(incoming.documentId), incomingContent = jsonContent(snapshot(incomingBefore).content);
      let keepBefore = await persisted(keep.documentId), expectedKeepRegistry = keepRegistry;
      const keepBytes = await fs.readFile(path.join(h.source.rootPath, keepPath));

      await group(`${projection}: actual projector retains snapshot_validate error and native ID read succeeds`, async () => {
        const workspace = await loadCollaborationProjectionWorkspace(originalRich); assert(workspace);
        let failure: ReturnType<typeof classifyCollaborationProjectionError> | undefined;
        await assert.rejects(() => materializeCollaborationCheckpoint({ state: originalRich, workspace, actorType: 'system' }), error => {
          failure = classifyCollaborationProjectionError(error);
          return failure.code === 'COLLABORATION_ROUNDTRIP_UNSTABLE' && failure.phase === 'snapshot_validate'
            && failure.causeCode === 'roundtrip_unstable' && !failure.permanent && !failure.blocksEditing;
        });
        assert(failure); await recordCollaborationProjectionFailure(originalRich, failure);
        const diagnosed = await persisted(target.documentId);
        assert.equal(diagnosed.projectionError?.code, 'COLLABORATION_ROUNDTRIP_UNSTABLE');
        assert.equal(diagnosed.projectionError?.phase, 'snapshot_validate'); assert.equal(diagnosed.projectionError?.permanent, false);
        assert.deepEqual(Buffer.from(diagnosed.yjsState), richBytes); assert.deepEqual(Buffer.from(diagnosed.stateVector), richVector);
        assert.deepEqual(jsonContent(snapshot(diagnosed).content), originalContent);
        await noWrites(async () => { assert.deepEqual(await nativeRead(diagnosed, initialRegistry.lineage_id), originalContent);
          await markdownReadFails(target.documentId); });
        if (projection === 'absent') await absent(originalFile);
        else { assert.equal((await fs.lstat(originalFile, { bigint: true })).ino, emptyIdentity!.ino);
          assert.equal((await fs.lstat(originalFile, { bigint: true })).size, BigInt(0)); assert.equal(sha(await fs.readFile(originalFile)), sha(Buffer.alloc(0))); }
      });

      await group(`${projection}: public Move of a normal note rewrites its unselected unexportable rich incoming source`, async () => {
        const keepSelections = [{ source_path: keepPath, destination_path: renamedKeepPath }];
        const preview = await noWrites(() => move(decodeMove({ ...slots, action: 'preview', selections: keepSelections }), authInfo));
        assert.equal(preview.action, 'preview'); if (preview.action !== 'preview') assert.fail('Expected preview.');
        assert.equal(preview.preview.readiness, 'ready'); assert.equal(preview.preview.coverage.complete, true);
        assert.deepEqual(preview.preview.linkChanges, { rewrites: 2, unlinks: 0, affectedDocuments: 2 });
        const operationId = crypto.randomUUID(), planId = preview.preview.planId;
        confirmed(await move(decodeMove({ ...slots, action: 'apply', operation_id: operationId,
          plan_id: planId, selections: keepSelections }), authInfo), operationId, planId);
        const richAfter = await persisted(target.documentId), incomingAfter = await persisted(incoming.documentId), keepAfter = await persisted(keep.documentId);
        const expectedRich = changedLinkContent(originalContent, keepPath, renamedKeepPath);
        assert.deepEqual(jsonContent(snapshot(richAfter).content), expectedRich); colwidths(expectedRich); strictStillFails(richAfter);
        assert.equal(richAfter.documentSequence, originalRich.documentSequence + 1);
        assert.equal(richAfter.path, sourcePath); assert.equal(richAfter.lifecycleGeneration, originalRich.lifecycleGeneration);
        assert.deepEqual(await registry(target.documentId), initialRegistry);
        assert.deepEqual(jsonContent(snapshot(incomingAfter).content), changedLinkContent(incomingContent, keepPath, renamedKeepPath));
        assert.equal(incomingAfter.documentSequence, incomingBefore.documentSequence + 1);
        assert.deepEqual(await registry(incoming.documentId), incomingRegistry);
        assert.equal(keepAfter.documentSequence, keepBefore.documentSequence);
        assert.deepEqual(Buffer.from(keepAfter.yjsState), Buffer.from(keepBefore.yjsState));
        assert.deepEqual(Buffer.from(keepAfter.stateVector), Buffer.from(keepBefore.stateVector));
        expectedKeepRegistry = { ...keepRegistry, path: renamedKeepPath };
        assert.deepEqual(await registry(keep.documentId), expectedKeepRegistry);
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, renamedKeepPath)), keepBytes);
        await absent(path.join(h.source.rootPath, keepPath));
        // The failing document was NOT selected. Its physical projection stays
        // missing or the very same empty FD while its native table href changes.
        if (projection === 'absent') await absent(originalFile);
        else { const retained = await fs.lstat(originalFile, { bigint: true });
          assert.equal(retained.dev, emptyIdentity!.dev); assert.equal(retained.ino, emptyIdentity!.ino);
          assert.equal(retained.size, BigInt(0)); assert.equal(sha(await fs.readFile(originalFile)), sha(Buffer.alloc(0))); }
        await noWrites(async () => { assert.deepEqual(await nativeRead(richAfter, initialRegistry.lineage_id), expectedRich);
          await markdownReadFails(target.documentId);
          confirmed(await move(decodeMove({ ...slots, action: 'status', operation_id: operationId }), authInfo), operationId, planId); });
        originalRich = richAfter; originalContent = expectedRich; incomingBefore = incomingAfter;
        incomingContent = jsonContent(snapshot(incomingAfter).content); keepBefore = keepAfter;
      });

      const selections = [{ source_path: sourcePath, destination_path: destinationPath }];
      let movePlanId = ''; const moveOperationId = crypto.randomUUID();
      await group(`${projection}: public Move preview is ready without data or FD mutation`, async () => {
        const result = await noWrites(() => move(decodeMove({ ...slots, action: 'preview', selections }), authInfo));
        assert.equal(result.action, 'preview'); if (result.action !== 'preview') assert.fail('Expected preview.');
        assert.equal(result.preview.readiness, 'ready'); assert.equal(result.preview.coverage.complete, true);
        assert.deepEqual(result.preview.linkChanges, { rewrites: 2, unlinks: 0, affectedDocuments: 2 });
        movePlanId = result.preview.planId; assert.match(movePlanId, /^[a-f0-9]{64}$/u);
      });
      let movedState!: PersistedCollaborationState;
      await group(`${projection}: public Move preserves rich JSON/IDs and centrally rewrites outgoing table plus incoming links`, async () => {
        confirmed(await move(decodeMove({ ...slots, action: 'apply', operation_id: moveOperationId, plan_id: movePlanId, selections }), authInfo), moveOperationId, movePlanId);
        const movedRegistry = await registry(target.documentId); assert.deepEqual(movedRegistry,
          { ...initialRegistry, path: destinationPath });
        movedState = await persisted(target.documentId);
        assert.equal(movedState.path, destinationPath); assert.equal(movedState.lifecycleGeneration, originalRich.lifecycleGeneration);
        assert.equal(movedState.documentSequence, originalRich.documentSequence + 1);
        const expected = changedLinkContent(originalContent, renamedKeepPath, movedKeepHref);
        assert.deepEqual(jsonContent(snapshot(movedState).content), expected); assert.deepEqual(colwidths(expected), colwidths(originalContent)); strictStillFails(movedState);
        const incomingAfter = await persisted(incoming.documentId);
        assert.equal(incomingAfter.documentSequence, incomingBefore.documentSequence + 1);
        assert.deepEqual(jsonContent(snapshot(incomingAfter).content), changedLinkContent(incomingContent, sourcePath, destinationPath));
        assert.deepEqual(await registry(incoming.documentId), incomingRegistry); assert.deepEqual(await registry(keep.documentId), expectedKeepRegistry);
        assert.deepEqual(links(movedState).links.map(link => link.targetPathText), [movedKeepHref]);
        assert.deepEqual(links(incomingAfter).links.map(link => link.targetPathText).sort(), [destinationPath, renamedKeepPath].sort());
        assert.deepEqual(Buffer.from((await persisted(keep.documentId)).yjsState), Buffer.from(keepBefore.yjsState));
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, renamedKeepPath)), keepBytes);
        await absent(originalFile);
        if (projection === 'absent') await absent(movedFile);
        else { const moved = await fs.lstat(movedFile, { bigint: true }); assert.equal(moved.dev, emptyIdentity!.dev);
          assert.equal(moved.ino, emptyIdentity!.ino); assert.equal(moved.size, BigInt(0)); assert.equal(sha(await fs.readFile(movedFile)), sha(Buffer.alloc(0))); }
        await noWrites(async () => { assert.deepEqual(await nativeRead(movedState, initialRegistry.lineage_id), expected);
          await markdownReadFails(target.documentId);
          confirmed(await move(decodeMove({ ...slots, action: 'status', operation_id: moveOperationId }), authInfo), moveOperationId, movePlanId); });
      });

      let deletePlanId = ''; const deleteOperationId = crypto.randomUUID();
      await group(`${projection}: public Delete preview is ready without data or FD mutation`, async () => {
        const result = await noWrites(() => remove(decodeDelete({ ...slots, action: 'preview', path: destinationPath }), authInfo));
        assert.equal(result.action, 'preview'); if (result.action !== 'preview') assert.fail('Expected preview.');
        assert.equal(result.preview.readiness, 'ready'); assert.equal(result.preview.coverage.complete, true);
        assert.deepEqual(result.preview.linkChanges, { rewrites: 0, unlinks: 1, affectedDocuments: 1 });
        deletePlanId = result.preview.planId;
      });
      await group(`${projection}: public Delete archives identical Yjs under the same IDs and centrally unlinks the incoming note`, async () => {
        const incomingMoved = await persisted(incoming.documentId), beforeContent = jsonContent(snapshot(incomingMoved).content);
        const operation = confirmed(await remove(decodeDelete({ ...slots, action: 'apply', path: destinationPath,
          operation_id: deleteOperationId, plan_id: deletePlanId }), authInfo), deleteOperationId, deletePlanId);
        const archived = await persisted(target.documentId, true);
        assert.equal(archived.status, 'archived'); assert.equal(archived.path, destinationPath);
        assert.equal(archived.lifecycleGeneration, movedState.lifecycleGeneration + 1);
        assert.equal(archived.documentSequence, movedState.documentSequence);
        assert.deepEqual(await registry(target.documentId), { ...initialRegistry, path: destinationPath, status: 'archived' });
        assert.deepEqual(Buffer.from(archived.yjsState), Buffer.from(movedState.yjsState));
        assert.deepEqual(Buffer.from(archived.stateVector), Buffer.from(movedState.stateVector));
        assert.deepEqual(jsonContent(inspectArchivedNativeSnapshot(archived).content), jsonContent(snapshot(movedState).content)); strictStillFails(archived);
        const incomingAfter = await persisted(incoming.documentId);
        assert.equal(incomingAfter.documentSequence, incomingMoved.documentSequence + 1);
        assert.deepEqual(jsonContent(snapshot(incomingAfter).content), changedLinkContent(beforeContent, destinationPath, null));
        assert.deepEqual(links(incomingAfter).links.map(link => link.targetPathText), [renamedKeepPath]);
        assert.deepEqual(await registry(incoming.documentId), incomingRegistry); assert.deepEqual(await registry(keep.documentId), expectedKeepRegistry);
        assert.deepEqual(Buffer.from((await persisted(keep.documentId)).yjsState), Buffer.from(keepBefore.yjsState));
        assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, renamedKeepPath)), keepBytes);
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_delete_receipts WHERE batch_id=$1', [operation.batchId])).rows[0].n, 1);
        await absent(originalFile); await absent(movedFile);
        await noWrites(async () => {
          await assert.rejects(async () => readDocumentForRequest(await h.request(), { apiVersion: 1,
            workspaceId: h.source.workspaceId, documentId: target.documentId, format: 'native' }),
          error => error instanceof DocumentReadError && error.code === 'DOCUMENT_NOT_FOUND');
          confirmed(await remove(decodeDelete({ ...slots, action: 'status', operation_id: deleteOperationId }), authInfo), deleteOperationId, deletePlanId);
        });
        console.log(JSON.stringify({ retainedCounterexample: projection, documentId: target.documentId, lineageId: initialRegistry.lineage_id,
          representation: archived.representation, nativeBytesAtStart: richBytes.length, nativeSequenceBeforeMove: originalRich.documentSequence,
          nativeSequenceAfterMove: movedState.documentSequence, lifecycleGenerationAfterDelete: archived.lifecycleGeneration,
          strictExportStillFails: 'COLLABORATION_ROUNDTRIP_UNSTABLE', originalBinaryClaim: false,
          normalSelectedMoveWithUnselectedStrictFailureConfirmed: true, moveConfirmed: true, deleteConfirmed: true, exactNativeJsonAndColwidthPreserved: true,
          ...(emptyIdentity ? { emptyFdOriginalDevice: String(emptyIdentity.dev), emptyFdOriginalInode: String(emptyIdentity.ino), emptyFdSha256: sha(Buffer.alloc(0)) } : {}) }));
      });
    }
  });
  assert.equal(groups, 12); assert.equal(noWriteScopes, 14);
  console.log(JSON.stringify({ suite: 'unexportable-native-path-public', groups, noWriteScopes, mode: 3, complete: true,
    publicMcpService: true, actualOwnerAndPg: true, runtimeHttpOrBrowser: false, originalProductionBinaryAvailable: false }));
  } catch (error) {
    console.error(JSON.stringify({ suite: 'unexportable-native-path-public', currentCase, groups, noWriteScopes,
      error: unexportableNativePathFailureFrames(error) })); throw error;
  } finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}
