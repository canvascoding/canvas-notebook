import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { JSONContent } from '@tiptap/core';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { DirectMcpWorkspacePathResultV1 } from '../app/lib/mcp/server/workspace-path-tool-contract';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Actual JWT/session/consent -> public Delete service -> existing claimed
// Owner/FD trash/archive/link receipts. No transport/authority/SQL substitutes.
let phase = 'fixture', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const mixedDeleteCode = (error: unknown): string | null => error instanceof Error
  && typeof Object.getOwnPropertyDescriptor(error, 'code')?.value === 'string'
  ? Object.getOwnPropertyDescriptor(error, 'code')!.value : null;
// Actual public-service boundaries confirmed from the fixed production paths.
const selectedRawCode = 'PATH_NATIVE_REQUIRED', requiredRawRewriteCode = 'NATIVE_DELETE_PLAN_UNSUPPORTED';

export async function workspaceOperationMixedDeletePostgresTest(): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'delete_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { decodeDirectMcpWorkspaceDeleteRequestV1: decode } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { runDirectMcpWorkspaceDeleteService: service } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: inspect } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { authoritativeNativeCollaborationSnapshot: snapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { getNativeInspectionSchema } = await import('../app/lib/collaboration/native-inspection-schema');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { stageWorkspaceLinkSourceAuthorityObservation } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { captureWorkspaceOperationNativeSourceEvidenceV3 } = await import('../app/lib/files/workspace-operation-native-source-evidence-v3');
    const { workspaceOperationMixedSourceSnapshot } = await import('../app/lib/files/workspace-operation-mixed-source-evidence');
    const { buildWorkspaceMixedReadLinkGraphV3 } = await import('../app/lib/markdown/workspace-native-link-graph');
    const { workspaceOperationMcpBatchId } = await import('../app/lib/files/workspace-operation-mcp-authorization');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    // Real current rights, without editing the fixture's stale read-only DTO.
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId,
      { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1
      WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    assert.equal(h.source.permissions.canWrite, false);
    const clientId = `mixed-delete-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','Actual mixed Delete fixture',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
      VALUES($1,'owner',100,100) ON CONFLICT(workspace_id) DO NOTHING`, [h.source.workspaceId]);
    await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
      VALUES($1,'member',$2,100,100)`, [clientId, h.source.workspaceId]);
    const mixedDeleteIssueToken = async (sessionId: string, scope = 'knowledge:write knowledge:read') => {
      const seconds = Math.floor(Date.now() / 1000);
      const signed = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: clientId, sid: sessionId,
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600, scope } } });
      assert(signed.token); return signed.token;
    };
    let currentSession = 'session-member', currentToken = await mixedDeleteIssueToken(currentSession);
    const mixedDeleteRun = (input: Record<string, unknown>, token = currentToken) => {
      const info: AuthInfo = { token, clientId: 'ignored-caller-client', scopes: [], extra: { userId: 'owner' } };
      return service(decode({ api_version: 1, workspace_id: h.source.workspaceId, ...input }), info);
    };
    const mixedDeleteRotate = async () => {
      const oldToken = currentToken, oldSession = currentSession, next = `mixed-delete-session-${crypto.randomUUID()}`, now = Date.now();
      await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)',
        [next, crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
      const token = await mixedDeleteIssueToken(next);
      assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [oldSession])).rowCount, 1);
      currentSession = next; currentToken = token; assert.notEqual(next, oldSession); return { oldToken, oldSession };
    };
    const mixedDeleteFilesystem = async () => {
      const rows: unknown[] = [], pending = ['.'];
      while (pending.length) {
        assert(rows.length < 10000); const relative = pending.shift()!, file = path.join(h.dataRoot, relative);
        const value = await fs.lstat(file, { bigint: true }); assert(!value.isSymbolicLink());
        const identity = { path: relative, dev: String(value.dev), ino: String(value.ino), mode: String(value.mode),
          uid: String(value.uid), gid: String(value.gid), size: String(value.size), nlink: String(value.nlink),
          mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
        rows.push(value.isFile() ? { ...identity, sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') } : identity);
        if (value.isDirectory()) pending.push(...(await fs.readdir(file)).sort().map(name => path.join(relative, name)));
      }
      return rows;
    };
    const mixedDeleteDomainSnapshot = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
          OR c.relname IN ('file_revisions','file_revision_contents','file_version_blobs','workspace_trash_entries'))
        ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 15 && tables.length <= 512); const rows: Record<string, unknown> = {};
      for (const table of tables) {
        assert.equal(typeof table.relname, 'string'); assert.equal(typeof table.oid, 'string');
        const name = `"${String(table.relname).replaceAll('"', '""')}"`;
        rows[table.relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert((rows[table.relname] as unknown[]).length <= 10000);
      }
      return { tables, rows };
    };
    const mixedDeleteNoWrites = async <T>(operation: () => Promise<T>, requireStatements = true): Promise<T> => {
      const before = await mixedDeleteDomainSnapshot(), files = await mixedDeleteFilesystem(); let statements = 0, writes = 0;
      try { return await h.withProbe(async event => {
        assert(++statements <= 5000);
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
      }, operation); }
      finally { if (requireStatements) assert(statements > 0); assert.equal(writes, 0);
        assert.deepEqual(await mixedDeleteDomainSnapshot(), before); assert.deepEqual(await mixedDeleteFilesystem(), files); }
    };
    const mixedDeleteRow = async (table: 'workspace_file_operation_batches' | 'workspace_file_operation_delete_intents'
      | 'workspace_file_operation_delete_receipts' | 'workspace_file_operation_delete_trash_receipts', batchId: string) => {
      const rows = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${table} t WHERE batch_id=$1 LIMIT 2`, [batchId])).rows;
      assert(rows.length <= 1); return rows as Array<{ body: string; xmin: string }>;
    };
    const sourcePath = 'a-mixed-delete-target.md', keepPath = 'z-mixed-delete-keep.md', incomingPath = 'c-mixed-delete-incoming.md';
    const targetBytes = Buffer.from('# Actual Delete target\n\nNative body retained in the archive.\n');
    const keepBytes = Buffer.from('# Second actual Delete target\n\nIndependent archived identity.\n');
    const target = await h.upload(sourcePath, targetBytes), keep = await h.upload(keepPath, keepBytes);
    const incoming = await h.upload(incomingPath, Buffer.from(`Before [Target](${sourcePath}) and [Keep](${keepPath}) **bold** [[Raw Delete M1]]\n`));
    await h.metadata(h.source, sourcePath, { title: 'Delete source title' });
    const originalTarget = await load(h.connection, target.documentId), originalKeep = await load(h.connection, keep.documentId);
    assert(originalTarget && originalKeep);
    const targetIdentity = await fs.lstat(path.join(h.source.rootPath, sourcePath)), keepIdentity = await fs.lstat(path.join(h.source.rootPath, keepPath));
    const incomingBefore = await load(h.connection, incoming.documentId); assert(incomingBefore);
    const incomingContentBefore = snapshot(incomingBefore).content; assert(incomingContentBefore.kind === 'rich_text');
    const rawPath = 'b-mixed-delete-raw.md', rawFile = path.join(h.source.rootPath, rawPath);
    let expectedRawBytes = Buffer.from(`---\naliases: [Raw Delete M1]\n---\n# Raw original\n\n[Self](${rawPath}) äöü 😀\n`);
    await fs.writeFile(rawFile, expectedRawBytes, { mode: 0o600, flag: 'wx' });
    const mixedDeleteRawSnapshot = async () => {
      const info = await fs.lstat(rawFile, { bigint: true }); assert(info.isFile() && !info.isSymbolicLink());
      assert.deepEqual(await fs.readFile(rawFile), expectedRawBytes);
      const rows = (await h.admin.query(`SELECT 'registry' AS kind,to_jsonb(d)::text AS body,d.xmin::text AS xmin FROM collaboration_documents d WHERE workspace_id=$1 AND path=$2
        UNION ALL SELECT 'state',to_jsonb(s)::text,s.xmin::text FROM collaboration_yjs_states s WHERE workspace_id=$1 AND path=$2
        UNION ALL SELECT 'lineage',to_jsonb(l)::text,l.xmin::text FROM file_collaboration_lineages l WHERE workspace_id=$1 AND path=$2
        UNION ALL SELECT 'metadata',to_jsonb(m)::text,m.xmin::text FROM workspace_file_metadata m WHERE workspace_id=$1 AND path=$2
        UNION ALL SELECT 'revision',to_jsonb(r)::text,r.xmin::text FROM file_revisions r WHERE workspace_id=$1 AND path=$2 ORDER BY kind,body,xmin`,
      [h.source.workspaceId, rawPath])).rows;
      assert.deepEqual(rows, [], 'The unchanged raw source must never acquire native registry/state/history rows.');
      return { version: filesystemFileVersion(await fs.lstat(rawFile)), dev: String(info.dev), ino: String(info.ino), mode: String(info.mode),
        nlink: String(info.nlink), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), rows,
        bytes: await fs.readFile(rawFile) };
    };
    const mixedDeleteGraph = async () => buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedSourceSnapshot(
      captureWorkspaceOperationNativeSourceEvidenceV3(captureWorkspaceOperationJobScope(h.source),
        await stageWorkspaceLinkSourceAuthorityObservation(h.source))));
    const mixedDeleteAssertCompletion = async (result: DirectMcpWorkspacePathResultV1,
      source: typeof target, sourcePath: string, original: typeof originalTarget, originalBytes: Buffer,
      originalIdentity: typeof targetIdentity, originalSession: string) => {
      assert(result.action !== 'preview'); assert(original);
      assert.equal(result.operation.completion.status, 'confirmed'); assert.equal(result.operation.execution.receiptStatus, 'available');
      assert.equal(result.operation.execution.finalization, 'complete'); assert(result.operation.execution.steps.length >= 2);
      assert(result.operation.execution.steps.every(step => step.state === 'applied'));
      const batchId = result.operation.batchId;
      const rows = await mixedDeleteRow('workspace_file_operation_batches', batchId); assert.equal(rows.length, 1);
      const batch = JSON.parse(rows[0].body), plan = JSON.parse(batch.plan_json), authorization = JSON.parse(batch.authorization_json);
      assert.equal(plan.version, 2); assert.equal(plan.kind, 'native-original-delete'); assert.equal(plan.planIdentityVersion, 3);
      assert.equal(plan.sourceEvidence.evidenceVersion, 3); assert.equal(plan.nativeGraphPlan.contractVersion, 3);
      assert.equal(plan.nativeGraphPlan.compilerVersion, 1);
      assert.equal(authorization.mode, 'direct-mcp'); assert.equal(authorization.tool, 'delete_knowledge_source');
      assert.equal(authorization.clientId, clientId); assert.equal(authorization.actorUserId, 'member'); assert.equal(authorization.actorSessionId, originalSession);
      assert.equal(plan.nativeTarget.documentId, source.documentId); assert.equal(plan.nativeTarget.path, sourcePath);
      const intentRows = await mixedDeleteRow('workspace_file_operation_delete_intents', batchId), receiptRows = await mixedDeleteRow('workspace_file_operation_delete_receipts', batchId);
      assert.equal(intentRows.length, 1); assert.equal(receiptRows.length, 1);
      const intentRow = JSON.parse(intentRows[0].body), receiptRow = JSON.parse(receiptRows[0].body);
      const intent = JSON.parse(intentRow.intent_text), receipt = JSON.parse(receiptRow.receipt_text);
      assert.equal(intent.version, 5); assert.equal(intent.currentWitness.evidenceVersion, 3); assert.equal(receipt.version, 5);
      assert.equal(intent.nativeLinks.length, 1); assert.equal(receipt.nativeLinks.length, 1);
      assert.equal(intent.actor.actorSessionId, originalSession); assert.equal(intent.native.documentId, source.documentId);
      assert.equal(receipt.intentDigest, intentRow.intent_digest); assert.equal(receiptRow.intent_digest, intentRow.intent_digest);
      assert.equal(crypto.createHash('sha256').update(receiptRow.receipt_text).digest('hex'), receiptRow.receipt_digest);
      assert.equal(intent.physical.source.kind, 'regular_file'); assert.equal(receipt.physical.observation.kind, 'moved');
      assert.equal(receipt.physical.observation.method, 'rename'); assert.deepEqual(receipt.physical.original, intent.physical);
      assert.equal(receipt.physical.observation.identity.device, originalIdentity.dev); assert.equal(receipt.physical.observation.identity.inode, originalIdentity.ino);
      assert.equal(receipt.physical.observation.sha256, crypto.createHash('sha256').update(originalBytes).digest('hex'));
      const trashFile = path.resolve(h.dataRoot, intent.physical.trashRelativePath); assert(trashFile.startsWith(`${path.resolve(h.dataRoot)}${path.sep}`));
      assert.deepEqual(await fs.readFile(trashFile), originalBytes); assert.equal((await fs.lstat(trashFile)).ino, originalIdentity.ino);
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, sourcePath)), { code: 'ENOENT' });
      const archived = (await h.admin.query(`SELECT d.lineage_id,d.status AS registry_status,l.status AS lineage_status,s.status,s.lifecycle_generation,s.yjs_state,s.state_vector
        FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1`, [source.documentId])).rows[0]; assert(archived);
      assert.equal(archived.registry_status, 'archived'); assert.equal(archived.lineage_status, 'archived'); assert.equal(archived.status, 'archived');
      assert.equal(Number(archived.lifecycle_generation), source.lifecycleGeneration + 1);
      assert.deepEqual(archived.yjs_state, Buffer.from(original.yjsState)); assert.deepEqual(archived.state_vector, Buffer.from(original.stateVector));
      assert.equal(receipt.native.before.identity.documentId, source.documentId); assert.equal(receipt.native.before.identity.lineageId, archived.lineage_id);
      assert.equal(receipt.native.after.identity.documentId, source.documentId);
      const trash = (await h.admin.query('SELECT original_path,status,deleted_by_user_id FROM workspace_trash_entries WHERE id=$1', [intent.physical.trashEntryId])).rows;
      assert.deepEqual(trash, [{ original_path: sourcePath, status: 'trashed', deleted_by_user_id: 'member' }]);
      return { batchId, plan, authorization, intentRows, receiptRows };
    };
    let rawBefore = await mixedDeleteRawSnapshot();
    phase = 'genuine mixed Delete preview preserves full graph and all domain/FS bytes';
    const preview = await mixedDeleteNoWrites(() => mixedDeleteRun({ action: 'preview', path: sourcePath })); assert(preview.action === 'preview');
    assert.equal(preview.preview.kind, 'delete'); assert.equal(preview.preview.coverage.complete, true);
    assert.equal(preview.preview.linkChanges.unlinks, 1); assert.equal(preview.preview.linkChanges.rewrites, 0);
    const graph = await mixedDeleteGraph(); assert.equal(graph.coverage.complete, true);
    assert(graph.edges.some(edge => edge.sourceKind === 'native' && edge.source.documentId === incoming.documentId
      && edge.literal === 'Raw Delete M1' && edge.resolution.status === 'resolved' && edge.resolution.target?.path === rawPath));
    assert(graph.edges.some(edge => edge.sourceKind === 'physical-read' && edge.source.path === rawPath
      && edge.resolution.status === 'resolved' && edge.resolution.target?.path === rawPath));
    assert.deepEqual(await mixedDeleteRawSnapshot(), rawBefore); groups++;

    phase = 'actual FD trash, native archive and exact incoming unlink complete centrally';
    const command = { path: sourcePath, operation_id: crypto.randomUUID(), plan_id: preview.preview.planId }, originalSession = currentSession;
    const applied = await mixedDeleteRun({ action: 'apply', ...command }); assert(applied.action === 'apply'); assert.equal(applied.alreadyKnown, false);
    const original = await mixedDeleteAssertCompletion(applied, target, sourcePath, originalTarget, targetBytes, targetIdentity, originalSession);
    const afterIncoming = await load(h.connection, incoming.documentId); assert(afterIncoming);
    const afterContent = snapshot(afterIncoming).content; assert(afterContent.kind === 'rich_text');
    const expected = structuredClone(incomingContentBefore.document), pending: JSONContent[] = [expected]; let changed = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (node.marks) { const marks = node.marks.filter(mark => {
        if (mark.type !== 'link' || mark.attrs?.href !== sourcePath) return true; changed++; return false;
      }); if (marks.length) node.marks = marks; else delete node.marks; }
      pending.push(...(node.content ?? []));
    }
    assert.equal(changed, 1); const canonical = getNativeInspectionSchema().nodeFromJSON(expected); canonical.check();
    assert.deepEqual(JSON.parse(JSON.stringify(afterContent.document)), JSON.parse(JSON.stringify(canonical.toJSON())));
    assert.equal(afterContent.frontmatter, incomingContentBefore.frontmatter); assert.equal(afterContent.bodyFinalLineEnding, incomingContentBefore.bodyFinalLineEnding);
    const actualLinks = inspect(afterIncoming); assert(actualLinks.coverage.complete);
    assert.equal(actualLinks.links.some(link => link.targetPathText === sourcePath), false);
    assert(actualLinks.links.some(link => link.targetPathText === keepPath)); assert(actualLinks.links.some(link => link.literal === 'Raw Delete M1'));
    const finalGraph = await mixedDeleteGraph(); assert.equal(finalGraph.coverage.complete, true);
    assert.equal(finalGraph.namespace.some(entry => entry.documentId === target.documentId), false);
    assert(finalGraph.edges.some(edge => edge.sourceKind === 'native' && edge.source.documentId === incoming.documentId
      && edge.literal === 'Raw Delete M1' && edge.resolution.status === 'resolved' && edge.resolution.target?.path === rawPath));
    assert(finalGraph.edges.some(edge => edge.sourceKind === 'physical-read' && edge.source.path === rawPath
      && edge.resolution.status === 'resolved' && edge.resolution.target?.path === rawPath));
    assert.deepEqual(await mixedDeleteRawSnapshot(), rawBefore); groups++;

    phase = 'historical completed status, apply retry and explicit recovery perform no writes';
    await mixedDeleteNoWrites(async () => {
      const status = await mixedDeleteRun({ action: 'status', operation_id: command.operation_id }); assert(status.action === 'status');
      assert.equal(status.operation.completion.status, 'confirmed'); assert.equal(status.operation.batchId, original.batchId);
      for (const action of ['apply', 'recover']) {
        const known = await mixedDeleteRun({ action, ...command }); assert(known.action !== 'preview' && known.action !== 'status');
        assert.equal(known.alreadyKnown, true); assert.equal(known.operation.completion.status, 'confirmed'); assert.equal(known.operation.batchId, original.batchId);
      }
    });
    assert.deepEqual(await mixedDeleteRow('workspace_file_operation_delete_intents', original.batchId), original.intentRows);
    assert.deepEqual(await mixedDeleteRow('workspace_file_operation_delete_receipts', original.batchId), original.receiptRows);
    assert.deepEqual(await mixedDeleteRawSnapshot(), rawBefore); groups++;

    phase = 'selected raw Markdown requires explicit import before every write';
    await mixedDeleteNoWrites(() => assert.rejects(mixedDeleteRun({ action: 'preview', path: rawPath }), error => mixedDeleteCode(error) === selectedRawCode));
    assert.deepEqual(await mixedDeleteRawSnapshot(), rawBefore); groups++;

    phase = 'necessary raw incoming unlink is rejected without importing or changing the source';
    const rawIncoming = path.join(h.source.rootPath, 'required-raw-unlink.md');
    const requiredBytes = Buffer.from(`[Must import before unlink](${keepPath})\n`); await fs.writeFile(rawIncoming, requiredBytes, { mode: 0o600, flag: 'wx' });
    const requiredVersion = filesystemFileVersion(await fs.lstat(rawIncoming));
    await mixedDeleteNoWrites(() => assert.rejects(mixedDeleteRun({ action: 'preview', path: keepPath }), error => mixedDeleteCode(error) === requiredRawRewriteCode));
    assert.deepEqual(await fs.readFile(rawIncoming), requiredBytes); assert.equal(filesystemFileVersion(await fs.lstat(rawIncoming)), requiredVersion);
    await fs.unlink(rawIncoming); assert.deepEqual(await mixedDeleteRawSnapshot(), rawBefore); groups++;

    phase = 'changed unselected physical bytes invalidate an earlier Delete plan without writes';
    const stale = await mixedDeleteRun({ action: 'preview', path: keepPath }); assert(stale.action === 'preview');
    expectedRawBytes = Buffer.concat([expectedRawBytes, Buffer.from('\nChanged by the fixture after Preview.\n')]);
    await fs.appendFile(rawFile, '\nChanged by the fixture after Preview.\n'); rawBefore = await mixedDeleteRawSnapshot();
    await mixedDeleteNoWrites(() => assert.rejects(mixedDeleteRun({ action: 'apply', path: keepPath,
      operation_id: crypto.randomUUID(), plan_id: stale.preview.planId }), error => mixedDeleteCode(error) === 'PATH_PLAN_CHANGED'));
    assert.equal((await load(h.connection, keep.documentId))?.path, keepPath); assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, keepPath)), keepBytes);
    assert.deepEqual(await mixedDeleteRawSnapshot(), rawBefore); groups++;

    phase = 'current Write, Delete and real token scope are independently required';
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
    try { await mixedDeleteNoWrites(() => assert.rejects(mixedDeleteRun({ action: 'preview', path: keepPath }),
      error => mixedDeleteCode(error) === 'MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
    finally { await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false }); }
    assert.equal((await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE organization_id='principal-org' AND user_id='member' RETURNING user_id`)).rowCount, 1);
    try { await mixedDeleteNoWrites(() => assert.rejects(mixedDeleteRun({ action: 'status', operation_id: command.operation_id }),
      error => mixedDeleteCode(error) === 'MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
    finally { await h.admin.query(`UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'`); }
    const readOnlyToken = await mixedDeleteIssueToken(currentSession, 'knowledge:read');
    await mixedDeleteNoWrites(() => assert.rejects(mixedDeleteRun({ action: 'preview', path: keepPath }, readOnlyToken), error => mixedDeleteCode(error) === 'insufficient_scope'), false);
    assert.deepEqual(await mixedDeleteRawSnapshot(), rawBefore); groups++;

    phase = 'actual Completion COMMIT ACK loss and renewed SID-B recovery preserve Original-A';
    const ackPreview = await mixedDeleteRun({ action: 'preview', path: keepPath }); assert(ackPreview.action === 'preview');
    const ackCommand = { path: keepPath, operation_id: crypto.randomUUID(), plan_id: ackPreview.preview.planId }, sessionA = currentSession;
    const ackBatchId = workspaceOperationMcpBatchId({ userId: 'member', clientId, workspaceId: h.source.workspaceId,
      tool: 'delete_knowledge_source', operationId: ackCommand.operation_id });
    let proof: { client: MetadataSqlEvent['client']; pid: number; start: string; xid: string;
      row: Awaited<ReturnType<typeof mixedDeleteRow>> } | undefined, lost = false;
    await h.withProbe(async event => {
      if (/\bINSERT\s+INTO\b/iu.test(event.text) && event.text.includes('workspace_file_operation_delete_receipts') && event.values[0] === ackBatchId) {
        assert(!proof); assert.equal(event.result.rowCount, 1);
        const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
          pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
        assert.equal(actual.schema, h.schema); assert.equal(typeof actual.xid, 'string');
        const ownRows = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM workspace_file_operation_delete_receipts t WHERE batch_id=$1`, [ackBatchId])).rows;
        assert.equal(ownRows.length, 1); assert.equal((await mixedDeleteRow('workspace_file_operation_delete_receipts', ackBatchId)).length, 0);
        proof = { client: event.client, pid: Number(actual.pid), start: actual.start, xid: actual.xid, row: ownRows };
      }
      if (proof && event.client === proof.client && /^COMMIT\s*;?$/iu.test(event.text.trim()) && !lost) {
        assert.equal(event.result.command, 'COMMIT');
        const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
          pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
        assert.equal(Number(actual.pid), proof.pid); assert.equal(actual.start, proof.start); assert.equal(actual.xid, null);
        const visible = await mixedDeleteRow('workspace_file_operation_delete_receipts', ackBatchId);
        assert.deepEqual(visible, proof.row); assert.equal(visible[0].xmin, String(BigInt(proof.xid) % (BigInt(1) << BigInt(32))));
        lost = true; throw Object.assign(new Error('Actual mixed Delete completion COMMIT acknowledgement lost.'), { code: 'M1_DELETE_ACK_LOST' });
      }
    }, () => assert.rejects(mixedDeleteRun({ action: 'apply', ...ackCommand }), error => mixedDeleteCode(error) === 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED'));
    assert(proof && lost); const beforeIntent = await mixedDeleteRow('workspace_file_operation_delete_intents', ackBatchId);
    const beforeReceipt = await mixedDeleteRow('workspace_file_operation_delete_receipts', ackBatchId);
    const beforeBatch = JSON.parse((await mixedDeleteRow('workspace_file_operation_batches', ackBatchId))[0].body);
    const beforeIncoming = await load(h.connection, incoming.documentId); assert(beforeIncoming);
    const rotation = await mixedDeleteRotate(); assert.equal(rotation.oldSession, sessionA); assert.notEqual(currentSession, sessionA);
    await mixedDeleteNoWrites(() => assert.rejects(mixedDeleteRun({ action: 'status', operation_id: ackCommand.operation_id }, rotation.oldToken),
      error => mixedDeleteCode(error) === 'invalid_token'), false);
    const recovered = await mixedDeleteRun({ action: 'recover', ...ackCommand }); assert(recovered.action === 'recover'); assert.equal(recovered.alreadyKnown, true);
    await mixedDeleteAssertCompletion(recovered, keep, keepPath, originalKeep, keepBytes, keepIdentity, sessionA);
    const afterBatch = JSON.parse((await mixedDeleteRow('workspace_file_operation_batches', ackBatchId))[0].body);
    assert.equal(afterBatch.plan_json, beforeBatch.plan_json); assert.equal(afterBatch.authorization_json, beforeBatch.authorization_json);
    assert.deepEqual(await mixedDeleteRow('workspace_file_operation_delete_intents', ackBatchId), beforeIntent);
    assert.deepEqual(await mixedDeleteRow('workspace_file_operation_delete_receipts', ackBatchId), beforeReceipt);
    const afterRecoveryIncoming = await load(h.connection, incoming.documentId); assert(afterRecoveryIncoming);
    assert.deepEqual(Buffer.from(afterRecoveryIncoming.yjsState), Buffer.from(beforeIncoming.yjsState));
    assert.equal(afterRecoveryIncoming.documentSequence, beforeIncoming.documentSequence);
    await mixedDeleteNoWrites(async () => {
      const historical = await mixedDeleteRun({ action: 'status', operation_id: ackCommand.operation_id }); assert(historical.action === 'status');
      assert.equal(historical.operation.completion.status, 'confirmed');
      for (const action of ['apply', 'recover']) {
        const retry = await mixedDeleteRun({ action, ...ackCommand }); assert(retry.action !== 'preview' && retry.action !== 'status');
        assert.equal(retry.alreadyKnown, true); assert.equal(retry.operation.completion.status, 'confirmed'); assert.equal(retry.operation.batchId, ackBatchId);
      }
    });
    assert.deepEqual(await mixedDeleteRawSnapshot(), rawBefore); groups++;
    assert.equal(groups, 8);
    console.log(JSON.stringify({ suite: 'mixed-delete', groups, actualPublicMcpService: true, fullMixedGraph: true,
      originalRawUnchanged: true, actualFdTrash: true, exactNativeUnlink: true, currentRights: true,
      staleEvidenceRejectedWithoutWrites: true, actualCommitAckLoss: true, originalSessionRetained: true, renewedSessionRecovery: true }));
  }); }
  finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
  complete = true;
}

workspaceOperationMixedDeletePostgresTest().catch((error: unknown) => {
  console.error(JSON.stringify({ suite: 'mixed-delete', phase, groups,
    name: error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/gu, '').slice(0, 80) : 'Unknown', code: mixedDeleteCode(error),
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 1500) : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').filter(line => /(?:app|scripts)\//u.test(line)).slice(0, 5) : undefined }));
  complete = true; process.exitCode = 1;
});
