import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { MarkdownFileImportReceipt } from '../app/lib/collaboration/markdown-file-import-persistence';
import type { WorkspaceOperationManagedCopyStageV6 } from '../app/lib/files/workspace-operation-managed-copy-stage';
import type { NativeCopyMarkdownBirthV1 } from '../app/lib/collaboration/native-copy-markdown-birth-contract';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Genuine JWT/current MCP policy -> public service -> actual Raw Copy Owner.
// Actual Source READ, FD, target import/binding/cohort/B1/B2 and history only;
// this does not claim OAuth issuance, HTTP/browser or projection.current.
let phase = 'fixture', groups = 0, complete = false, projectionPendingTargets = 0, projectionReleasedTargets = 0;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

export async function workspaceOperationSelectedRawCopyPostgresTest(): Promise<void> {
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { DirectMcpAuthorizationError } = await import('../app/lib/mcp/server/access-token-verifier');
    const { decodeDirectMcpWorkspaceCopyRequestV1: decode } = await import('../app/lib/mcp/server/workspace-copy-tool-contract');
    const { runDirectMcpWorkspaceCopyService: service } = await import('../app/lib/files/workspace-file-operation-service');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { materializeCollaborationCheckpoint } = await import('../app/lib/collaboration/checkpoint');
    const { hasPendingCollaborationProjection, loadCollaborationProjectionWorkspace } = await import('../app/lib/collaboration/projection-repository');
    const { assertCurrentCollaborationProjectionIdentity } = await import('../app/lib/collaboration/projection-identity');
    const { withCollaborationProjectionPublicationGuard } = await import('../app/lib/collaboration/projection-publication-guard');
    const { CollaborationCopyPublicationPendingError, CollaborationFileOperationProjectionPendingError } = await import('../app/lib/collaboration/checkpoint-errors');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const { inspectPersistedDocumentLinksV3: inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { formatNativeLinkTargetForPathChange } = await import('../app/lib/markdown/workspace-native-mixed-batch-compiler');
    const { parseObsidianWikiTarget } = await import('../app/lib/markdown/obsidian-flavored-markdown');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { decodeNativeCopyMarkdownBirthV1 } = await import('../app/lib/collaboration/native-copy-markdown-birth-contract');
    const { nativeCopyMarkdownBirthsProof } = await import('../app/lib/collaboration/native-copy-markdown-birth-persistence');
    const { readWorkspaceCopySourceObservationOnConnection } = await import('../app/lib/files/workspace-operation-copy-source-observation');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { captureWorkspaceOperationCopySourceEvidenceV4, workspaceOperationMixedCopySourceSnapshot } = await import('../app/lib/files/workspace-operation-copy-source-evidence-v4');
    const { buildWorkspaceMixedReadLinkGraphV3 } = await import('../app/lib/markdown/workspace-native-link-graph');
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canWrite);
    const birthStorage = (await h.admin.query(`SELECT c.oid::text AS oid,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid=to_regclass('collaboration_native_copy_markdown_births')`)).rows[0];
    assert.equal(birthStorage?.nspname, h.schema);
    assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid=$1::oid AND contype='f'
      AND convalidated AND NOT condeferrable AND NOT condeferred`, [birthStorage.oid])).rows[0].n, 2);
    assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid=$1::oid
      AND tgname='native_copy_markdown_birth_guard' AND NOT tgisinternal AND tgenabled='O'`, [birthStorage.oid])).rows[0].n, 1);
    const clientId = `selected-raw-copy-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES($1,$1,'member','Actual selected raw Copy fixture',0,'[]',100,100)`, [clientId]);
    await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES($1,$2,'member','["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId]);
    for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId]) {
      await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
        VALUES($1,'owner',100,100) ON CONFLICT(workspace_id) DO NOTHING`, [workspaceId]);
      await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,'member',$2,100,100)`, [clientId, workspaceId]);
    }
    let sessionId = 'session-member', sessionToken: string | undefined = undefined;
    const rawCopyIssueToken = async (sid: string) => {
      const seconds = Math.floor(Date.now() / 1000);
      const result = await auth.api.signJWT({ body: { payload: { sub: 'member', azp: clientId, sid,
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600,
        scope: 'knowledge:write knowledge:read' } } }); assert(result.token); return result.token;
    };
    let currentToken = await rawCopyIssueToken(sessionId);
    const rawCopyCall = (input: Record<string, unknown>, token = currentToken) => {
      const info: AuthInfo = { token, clientId: 'untrusted-caller-client', scopes: [], extra: { userId: 'owner' } };
      return service(decode({ api_version: 1, source_workspace_id: h.source.workspaceId,
        destination_workspace_id: h.destination.workspaceId, ...input }), info);
    };
    const rawCopyFilesystem = async (root: string) => {
      const rows: unknown[] = [], pending = ['.'];
      while (pending.length) {
        assert(rows.length < 10000); const relative = pending.shift()!, file = path.join(root, relative);
        const stat = await fs.lstat(file, { bigint: true }); assert(!stat.isSymbolicLink());
        const identity = { path: relative, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
          uid: String(stat.uid), gid: String(stat.gid), size: String(stat.size), nlink: String(stat.nlink),
          mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
        rows.push(stat.isFile() ? { ...identity, sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') } : identity);
        if (stat.isDirectory()) pending.push(...(await fs.readdir(file)).sort().map(name => path.join(relative, name)));
      }
      return rows;
    };
    const rawCopyDomain = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
        AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
          OR c.relname IN ('file_revisions','file_revision_contents','file_version_blobs','workspace_trash_entries'))
        ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 15 && tables.length <= 512); const rows: Record<string, unknown> = {};
      for (const table of tables) {
        assert.equal(typeof table.relname, 'string'); const name = `"${String(table.relname).replaceAll('"', '""')}"`;
        rows[table.relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert((rows[table.relname] as unknown[]).length <= 10000);
      }
      return { tables, rows };
    };
    const rawCopyNoWrites = async <T>(operation: () => Promise<T>): Promise<T> => {
      const before = await rawCopyDomain(), files = await rawCopyFilesystem(h.dataRoot); let statements = 0, writes = 0;
      try { return await h.withProbe(async event => {
        assert(++statements <= 5000);
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
      }, operation); }
      finally { assert(statements > 0); assert.equal(writes, 0);
        assert.deepEqual(await rawCopyDomain(), before); assert.deepEqual(await rawCopyFilesystem(h.dataRoot), files); }
    };
    const rawCopySourceSnapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages',
        'collaboration_excalidraw_states', 'collaboration_excalidraw_assets', 'collaboration_file_projections',
        'collaboration_markdown_file_import_receipts', 'collaboration_original_markdown_imports', 'collaboration_native_copy_receipts',
        'workspace_file_metadata', 'workspace_file_user_states', 'file_revisions']) {
        const predicate = table === 'collaboration_file_projections'
          ? 'document_id IN (SELECT id FROM collaboration_documents WHERE workspace_id=$1)' : 'workspace_id=$1';
        rows[table] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${table} t
          WHERE ${predicate} ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`, [h.source.workspaceId])).rows;
        assert((rows[table] as unknown[]).length <= 10000);
      }
      const catalogue = await readWorkspaceCopySourceObservationOnConnection(h.connection, h.source, { physicalParserVersion: 3 });
      assert(catalogue.stage.coverage.complete, JSON.stringify(catalogue.stage.coverage.gaps));
      assert(!catalogue.nativeBindings.some(binding => ['selected-raw-a.md', 'selected-raw-b.markdown', 'stable-raw.md'].includes(binding.expected.path)));
      assert.deepEqual(catalogue.stage.sources.filter(source => source.kind === 'physical')
        .map(source => source.inventory.path).sort(), ['selected-raw-a.md', 'selected-raw-b.markdown', 'stable-raw.md']);
      return { rows, catalogue, files: await rawCopyFilesystem(h.source.rootPath) };
    };
    const sources = ['selected-raw-a.md', 'selected-raw-b.markdown'] as const;
    const sourceBytes = [Buffer.from('\uFEFF---\r\naliases: [Raw A]\r\n---\r\n# Raw A\r\n\r\n😀 [Self](selected-raw-a.md) [Other](selected-raw-b.markdown) [[Raw B]] **bold** Ω.\r\n'),
      Buffer.from('---\naliases: [Raw B]\n---\n# Raw B\n\n[Self](selected-raw-b.markdown) [Other](selected-raw-a.md) [[Raw A]] 🙂.\n')];
    for (const [index, source] of sources.entries()) await fs.writeFile(path.join(h.source.rootPath, source), sourceBytes[index], { flag: 'wx', mode: 0o600 });
    const stableBytes = Buffer.from('\uFEFF# Stable Ω\r\n\r\n😀 [Self](stable-raw.md)\r\n');
    await fs.writeFile(path.join(h.source.rootPath, 'stable-raw.md'), stableBytes, { flag: 'wx', mode: 0o600 });
    for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) assert.equal((await h.admin.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1 AND path=ANY($2::text[])`, [h.source.workspaceId, sources])).rows[0].n, 0);
    let sourceBefore = await rawCopySourceSnapshot();
    const staging = new WorkspaceOperationStaging();
    // Materialize only the existing private Store root during fixture setup;
    // later NoWrite scopes still forbid every per-operation Stage/effect.
    assert.equal(await staging.loadRawCopyByOperationId(crypto.randomUUID()), null);
    const stages = new Map<string, WorkspaceOperationManagedCopyStageV6>();
    const rawCopyCaptureStage = async (event: MetadataSqlEvent, operationId: string) => {
      if (stages.has(operationId) || !/^\s*INSERT\s+INTO\s+workspace_file_operations\b/iu.test(event.text) || event.values[0] !== operationId) return;
      const stage = await staging.loadRawCopyByOperationId(operationId); assert(stage);
      assert.equal(stage.version, 6); assert.equal(stage.plan.version, 5); assert.equal(stage.identity.operationId, operationId);
      assert.equal(stage.origin.sourceScope.workspaceId, h.source.workspaceId);
      assert.equal(stage.origin.destinationScope.workspaceId, h.destination.workspaceId); stages.set(operationId, stage);
    };
    const rawCopyCohort = async (operationId: string, query?: MetadataSqlEvent['raw'], freshXid?: string) => {
      const stage = stages.get(operationId); assert(stage);
      const sql = `SELECT b.*,b.xmin::text AS birth_xmin,r.xmin::text AS import_xmin,r.actor_session_id,
        d.xmin::text AS registry_xmin,l.xmin::text AS lineage_xmin,s.xmin::text AS state_xmin,s.document_sequence
        FROM collaboration_native_copy_markdown_births b JOIN collaboration_markdown_file_import_receipts r
          ON r.workspace_id=b.workspace_id AND r.operation_id=b.import_operation_id
        JOIN collaboration_documents d ON d.id=b.document_id AND d.workspace_id=b.workspace_id AND d.lineage_id=b.lineage_id
        JOIN file_collaboration_lineages l ON l.id=b.lineage_id JOIN collaboration_yjs_states s ON s.document_id=b.document_id
        WHERE b.workspace_id=$1 AND b.parent_operation_id=$2 AND octet_length(b.birth_text)<=16777216
        ORDER BY b.requirement_index LIMIT 10001`;
      const params = [h.destination.workspaceId, operationId], rows = (query ? await query(sql, params) : await h.admin.query(sql, params)).rows;
      assert.equal(rows.length, stage.plan.rawImportRequirements.length); assert(rows.length <= 2);
      const births = rows.map((row, index) => {
        const birth = decodeNativeCopyMarkdownBirthV1(JSON.parse(row.birth_text)), requirement = stage.plan.rawImportRequirements[index];
        assert.equal(Number(row.requirement_index), index); assert.equal(birth.parent.requirementIndex, index);
        assert.equal(birth.parent.operationId, operationId); assert.equal(birth.parent.planId, stage.plan.planId);
        assert.equal(birth.parent.stageDigest, stage.payloadSha256); assert.equal(birth.parent.requestHash, stage.identity.canonicalRequestHash);
        assert.equal(birth.parent.entityKey, requirement.entityKey); assert.deepEqual(birth.origin, stage.origin);
        assert.equal(row.birth_digest, crypto.createHash('sha256').update(row.birth_text).digest('hex'));
        assert.equal(row.actor_session_id, stage.origin.actor.sessionId); assert.equal(row.b1_transaction_id, birth.b1TransactionId);
        assert.equal(row.birth_xmin, String(BigInt(birth.b1TransactionId) % (BigInt(1) << BigInt(32))));
        assert.equal(row.import_xmin, row.birth_xmin); assert.equal(row.registry_xmin, row.birth_xmin); assert.equal(row.lineage_xmin, row.birth_xmin);
        assert.equal(birth.binding.receipt.target.documentId, row.document_id); assert.equal(birth.binding.receipt.target.lineageId, row.lineage_id);
        assert.equal(birth.binding.receipt.target.path, requirement.destinationPath); assert.equal(birth.binding.nativeInventory.parserVersion, 3);
        assert.equal(birth.binding.source.physicalSourceProof, stage.rawOriginals[index].physicalSourceProof);
        assert.equal(birth.binding.source.filesystemIdentity, stage.rawOriginals[index].physical.filesystemIdentity);
        assert.equal(birth.binding.source.sourceHash, crypto.createHash('sha256').update(stage.rawOriginals[index].originalBytes).digest('hex'));
        assert.equal(birth.binding.links.length, stage.rawOriginals[index].links.length);
        if (freshXid !== undefined) {
          assert.equal(birth.b1TransactionId, freshXid); assert.equal(row.state_xmin, row.birth_xmin); assert.equal(Number(row.document_sequence), 0);
        }
        return birth;
      });
      assert.equal(new Set(births.map(birth => birth.b1TransactionId)).size, births.length ? 1 : 0);
      assert.equal(new Set(births.map(birth => birth.binding.receipt.target.documentId)).size, births.length);
      assert.equal(new Set(births.map(birth => birth.binding.receipt.target.lineageId)).size, births.length);
      return births;
    };
    const rawCopyExpectedMarkdown = (stage: WorkspaceOperationManagedCopyStageV6, birth: NativeCopyMarkdownBirthV1) => {
      const original = stage.rawOriginals[birth.parent.requirementIndex]; assert(original);
      const graph = buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedCopySourceSnapshot(stage.plan.sourceEvidence));
      let expected = Buffer.from(original.originalBytes).toString('utf8');
      for (const physical of [...original.links].sort((left, right) => right.targetRange.startUtf16 - left.targetRange.startUtf16)) {
        const edge = graph.edges.find(edge => edge.sourceKind === 'physical-read' && edge.id === physical.physicalLinkId);
        assert(edge?.resolution.status === 'resolved'); assert(edge.resolution.target);
        const target = stage.plan.nativePathPlan.pathMappings.find(mapping => mapping.source.path === edge.resolution.target!.path); assert(target);
        const bound = birth.binding.links.find(link => link.physicalLinkId === physical.physicalLinkId); assert(bound);
        const native = birth.binding.nativeInventory.links.find(link => link.id === bound.nativeLinkId); assert(native);
        const formatted = formatNativeLinkTargetForPathChange(native, target.destinationPath, birth.binding.receipt.target.path); assert(formatted !== null);
        const literal = native.kind === 'wiki' ? parseObsidianWikiTarget(formatted)?.target : formatted; assert.equal(typeof literal, 'string');
        assert.equal(expected.slice(physical.targetRange.startUtf16, physical.targetRange.endUtf16), physical.targetLiteral);
        expected = expected.slice(0, physical.targetRange.startUtf16) + literal + expected.slice(physical.targetRange.endUtf16);
      }
      return expected.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n');
    };
    const rawCopyImportRows = async (targets: readonly string[], query?: MetadataSqlEvent['raw']) => {
      const sql = `SELECT operation_id,actor_user_id,actor_session_id,request_fingerprint,private_result,xmin::text AS xmin
        FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1
        AND private_result->'target'->>'path'=ANY($2::text[]) ORDER BY private_result->'target'->>'path',operation_id LIMIT 3`;
      const values = [h.destination.workspaceId, [...targets]];
      const rows = (query ? await query(sql, values) : await h.admin.query(sql, values)).rows as Array<{ operation_id: string; actor_user_id: string; actor_session_id: string;
        request_fingerprint: string; private_result: MarkdownFileImportReceipt; xmin: string }>;
      assert(rows.length <= 2); return rows;
    };
    // Run only after the interrupted Owner/ACK-loss probe has fully returned.
    // The new NoWrite observer is read-only instrumentation: projector calls
    // execute outside every Owner and SQL-hook callback, without its TX/lease.
    const rawCopyAssertProjectionPublication = async (operationId: string, births: readonly NativeCopyMarkdownBirthV1[],
      publication: 'pending' | 'released') => rawCopyNoWrites(async () => {
      assert.equal(births.length, 2); const stage = stages.get(operationId); assert(stage);
      const rows = (await h.admin.query(`SELECT b.document_id,b.stage_digest,b.import_operation_id,b.parent_operation_id,
        p.publication_status,p.publication_fingerprint,p.private_result FROM collaboration_native_copy_markdown_births b
        JOIN collaboration_native_copy_receipts p ON p.workspace_id=b.workspace_id AND p.operation_id=b.parent_operation_id
        WHERE b.workspace_id=$1 AND b.parent_operation_id=$2 ORDER BY b.requirement_index LIMIT 3`,
      [h.destination.workspaceId, operationId])).rows;
      assert.equal(rows.length, births.length);
      for (const [index, birth] of births.entries()) {
        const target = birth.binding.receipt.target, row = rows[index];
        assert.equal(row.document_id, target.documentId); assert.equal(row.import_operation_id, birth.binding.receipt.operationId);
        assert.equal(row.parent_operation_id, operationId); assert.equal(row.stage_digest, stage.payloadSha256);
        assert.equal(row.publication_fingerprint, birth.parent.stageDigest); assert.equal(birth.parent.stageDigest, stage.payloadSha256);
        assert.equal(row.publication_status, publication === 'pending' ? 'native_committed' : 'published');
        assert.deepEqual(row.private_result.documents, [], 'Raw targets never enter the native CloneReceipt documents array');
        const state = await load(h.connection, target.documentId); assert(state);
        assert.equal(state.workspaceId, h.destination.workspaceId); assert.equal(state.path, target.path);
        const workspace = await loadCollaborationProjectionWorkspace(state); assert(workspace);
        assert.equal(workspace.workspaceId, h.destination.workspaceId); assert.equal(workspace.rootPath, h.destination.rootPath);
        assert.equal(await hasPendingCollaborationProjection(state), true, 'Derived export remains pending until a real projector completes');
        if (publication === 'pending') {
          await assert.rejects(fs.lstat(path.join(workspace.rootPath, target.path)), { code: 'ENOENT' });
          // Exact CopyPending here cannot come from a fabricated clone birth:
          // the real parent above has no clone document entry at all.
          await assert.rejects(assertCurrentCollaborationProjectionIdentity(state), error => error instanceof CollaborationCopyPublicationPendingError);
          await assert.rejects(materializeCollaborationCheckpoint({ state, workspace, actorType: 'system' }),
            error => error instanceof CollaborationCopyPublicationPendingError || error instanceof CollaborationFileOperationProjectionPendingError);
          projectionPendingTargets++;
        } else {
          await assertCurrentCollaborationProjectionIdentity(state);
          let entered = false;
          await withCollaborationProjectionPublicationGuard(state, async assertCurrent => { entered = true; await assertCurrent(); });
          assert(entered); projectionReleasedTargets++;
          // This is a publication-guard read, not a formatted export. B2's FD
          // copy still contains the exact source bytes independently of Yjs.
          assert.deepEqual(await fs.readFile(path.join(workspace.rootPath, target.path)), Buffer.from(stage.rawOriginals[index].originalBytes));
        }
      }
    });
    const rawCopyTargets = async (operationId: string, targets: readonly string[]) => {
      assert.equal(targets.length, 2);
      const stage = stages.get(operationId); assert(stage); const births = await rawCopyCohort(operationId);
      const rows = (await h.admin.query(`SELECT d.id,d.lineage_id,d.path,d.yjs_state_lifecycle,l.workspace_id,l.status,
        s.lifecycle_generation FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
        JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.workspace_id=$1 AND d.path=ANY($2::text[])
        AND d.status='active' AND d.provider='yjs' ORDER BY d.path LIMIT 3`, [h.destination.workspaceId, [...targets]])).rows;
      assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.id)).size, 2); assert.equal(new Set(rows.map(row => row.lineage_id)).size, 2);
      const byPath = new Map(rows.map(row => [String(row.path), row]));
      const imports = await rawCopyImportRows(targets); assert.equal(imports.length, 2);
      assert.equal(new Set(imports.map(row => row.operation_id)).size, 2);
      const observation = await readWorkspaceCopySourceObservationOnConnection(h.connection, h.destination, { physicalParserVersion: 3 });
      const snapshot = workspaceOperationMixedCopySourceSnapshot(captureWorkspaceOperationCopySourceEvidenceV4(
        captureWorkspaceOperationJobScope(h.destination), observation));
      const graph = buildWorkspaceMixedReadLinkGraphV3(snapshot); assert(graph.coverage.complete);
      for (const [index, targetPath] of targets.entries()) {
        const row = byPath.get(targetPath); assert(row); assert.equal(row.yjs_state_lifecycle, 'initialized');
        assert.equal(row.workspace_id, h.destination.workspaceId); assert.equal(row.status, 'active'); assert.equal(Number(row.lifecycle_generation), 1);
        assert(!sourceBefore.catalogue.nativeBindings.some(binding => binding.expected.documentId === row.id || binding.expected.lineageId === row.lineage_id));
        const state = await load(h.connection, row.id); assert(state); const inventory = inspectPersistedDocumentLinks(state);
        assert(inventory.coverage.complete); assert.equal(inventory.document.documentId, row.id); assert.equal(inventory.links.length, 3);
        const receipt = imports.find(value => value.private_result.target.path === targetPath); assert(receipt);
        assert.equal(receipt.actor_user_id, 'member'); assert.equal(receipt.private_result.target.documentId, row.id);
        assert.equal(receipt.private_result.target.lineageId, row.lineage_id);
        assert.equal(receipt.private_result.sourceHash, crypto.createHash('sha256').update(sourceBytes[index]).digest('hex'));
        assert.equal(receipt.private_result.sourceBytes, sourceBytes[index].length);
        // Path publication retains genuine Raw originals; the public native
        // version below already exposes the authoritative rebound Yjs state.
        assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, targetPath)), sourceBytes[index]);
        const request = await h.request(h.destination, 'member', false, sessionToken);
        const native = await readDocumentForRequest(request, { apiVersion: 1, workspaceId: h.destination.workspaceId,
          documentId: row.id, format: 'native', maxBytes: 262144 });
        assert(native.complete); assert.equal(native.nextCursor, null); assert.equal(native.document.documentId, row.id);
        assert.equal(native.document.lineageId, row.lineage_id); assert.equal(native.document.path, targetPath); JSON.parse(native.fragment);
        const markdown = await readDocumentForRequest(request, { apiVersion: 1, workspaceId: h.destination.workspaceId,
          documentId: row.id, expectedVersion: native.document.version, format: 'markdown', maxBytes: 262144 });
        assert(markdown.complete); assert.deepEqual(markdown.document, native.document);
        const birth = births.find(value => value.binding.receipt.target.documentId === row.id); assert(birth);
        assert.equal(markdown.fragment, rawCopyExpectedMarkdown(stage, birth));
        assert.equal(state.documentSequence, 1, 'Changed real target names require exactly one native link delta after the original import.');
        assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM collaboration_native_link_mutation_receipts
          WHERE document_id=$1 AND before_sequence=0 AND after_sequence=1 AND actor_session_id=$2`, [row.id, stage.origin.actor.sessionId])).rows[0].n, 1);
        const edges = graph.edges.filter(edge => edge.sourceKind === 'native' && edge.source.documentId === row.id);
        assert.equal(edges.length, 3); assert(edges.every(edge => edge.resolution.status === 'resolved' && edge.resolution.target?.documentId));
        assert.deepEqual(edges.map(edge => edge.resolution.target!.documentId).sort(),
          [byPath.get(targets[index])!.id, byPath.get(targets[1 - index])!.id, byPath.get(targets[1 - index])!.id].sort());
      }
      const completion = (await h.admin.query(`SELECT receipt_json FROM workspace_file_operation_steps WHERE operation_id=$1
        AND step_key='copy-completion' AND status='applied'`, [operationId])).rows; assert.equal(completion.length, 1);
      const body = JSON.parse(completion[0].receipt_json); assert.equal(body.version, 5);
      assert.equal(body.rawBirthCount, births.length); assert.equal(body.rawBirthsProof, nativeCopyMarkdownBirthsProof(births));
      assert.equal(await staging.loadRawCopyByOperationId(operationId), null);
      return { rows, imports, births };
    };

    phase = 'fresh source bytes reject a stale public plan before Stage or target effects';
    const staleSelections = sources.map((source_path, index) => ({ source_path, destination_path: `stale-source-${index}.md` }));
    const stalePreview = await rawCopyNoWrites(() => rawCopyCall({ action: 'preview', selections: staleSelections })); assert(stalePreview.action === 'preview');
    await fs.appendFile(path.join(h.source.rootPath, sources[0]), '\r\nActual source changed after preview.\r\n');
    const staleOperation = crypto.randomUUID();
    try {
      await rawCopyNoWrites(() => assert.rejects(rawCopyCall({ action: 'apply', selections: staleSelections,
        operation_id: staleOperation, plan_id: stalePreview.preview.planId }),
      error => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'NATIVE_COPY_PLAN_CHANGED'));
      assert.equal(await staging.loadRawCopyByOperationId(staleOperation), null);
      for (const selected of staleSelections) await assert.rejects(fs.lstat(path.join(h.destination.rootPath, selected.destination_path)), { code: 'ENOENT' });
    } finally { await fs.writeFile(path.join(h.source.rootPath, sources[0]), sourceBytes[0], { flag: 'w' }); }
    sourceBefore = await rawCopySourceSnapshot(); groups++;

    phase = 'fresh full catalogue rejects a namespace change before Stage or target effects';
    const cataloguePreview = await rawCopyNoWrites(() => rawCopyCall({ action: 'preview', selections: staleSelections })); assert(cataloguePreview.action === 'preview');
    const catalogueFile = path.join(h.source.rootPath, 'added-after-preview.md');
    await fs.writeFile(catalogueFile, '# Real additional unselected ordinary file\n', { flag: 'wx', mode: 0o600 });
    const catalogueOperation = crypto.randomUUID();
    try {
      await rawCopyNoWrites(() => assert.rejects(rawCopyCall({ action: 'apply', selections: staleSelections,
        operation_id: catalogueOperation, plan_id: cataloguePreview.preview.planId }),
      error => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'NATIVE_COPY_PLAN_CHANGED'));
      assert.equal(await staging.loadRawCopyByOperationId(catalogueOperation), null);
      for (const selected of staleSelections) await assert.rejects(fs.lstat(path.join(h.destination.rootPath, selected.destination_path)), { code: 'ENOENT' });
    } finally { await fs.unlink(catalogueFile); }
    sourceBefore = await rawCopySourceSnapshot(); groups++;

    phase = 'public selected raw Preview is ready and wholly non-mutating';
    const targets = ['copied-renamed-a.md', 'copied-renamed-b.markdown'];
    const selections = sources.map((source_path, index) => ({ source_path, destination_path: targets[index] }));
    const preview = await rawCopyNoWrites(() => rawCopyCall({ action: 'preview', selections }));
    assert(preview.action === 'preview'); assert.equal(preview.preview.readiness, 'ready'); assert(preview.preview.coverage.complete);
    assert.deepEqual(preview.preview.pathMappings.map(mapping => [mapping.sourcePath, mapping.destinationPath]).sort(),
      sources.map((source, index) => [source, targets[index]]).sort());
    const importBindings = preview.preview.importLinkBindings; assert(importBindings);
    assert.equal(importBindings.status, 'requires-native-import-rebinding'); assert.equal(importBindings.targets.length, 6);
    assert(importBindings.targets.every(target => !Object.hasOwn(target, 'nextTargetLiteral')));
    assert.deepEqual(await rawCopySourceSnapshot(), sourceBefore); groups++;

    phase = 'public Apply imports two independent native targets on the same B and correctly rebinds every link';
    const command = { selections, operation_id: crypto.randomUUID(), plan_id: preview.preview.planId };
    const writes: Array<{ client: MetadataSqlEvent['client']; xid: string; pid: number }> = [];
    let b1Births: readonly NativeCopyMarkdownBirthV1[] | undefined;
    const applied = await h.withProbe(async event => {
      await rawCopyCaptureStage(event, command.operation_id);
      if (/^\s*INSERT\s+INTO\s+(?:"?[^".\s]+"?\.)?"?collaboration_markdown_file_import_receipts"?\b/iu.test(event.text)) {
        const actual = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        assert(actual.xid); assert.equal(event.result.rowCount, 1); writes.push({ client: event.client, pid: Number(actual.pid), xid: actual.xid });
      }
      if (/^\s*INSERT\s+INTO\s+collaboration_native_copy_markdown_births\b/iu.test(event.text)
        && event.values[1] === command.operation_id && event.values[2] === 1) {
        assert.equal(writes.length, 2); const actual = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        assert.equal(event.client, writes[0].client); assert.equal(Number(actual.pid), writes[0].pid); assert.equal(actual.xid, writes[0].xid);
        b1Births = await rawCopyCohort(command.operation_id, event.raw, actual.xid);
        assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM collaboration_native_copy_markdown_births
          WHERE workspace_id=$1 AND parent_operation_id=$2`, [h.destination.workspaceId, command.operation_id])).rows[0].n, 0);
      }
    }, () => rawCopyCall({ action: 'apply', ...command }));
    assert(applied.action === 'apply'); assert.equal(applied.execution.status, 'complete'); assert.equal(applied.alreadyKnown, false);
    assert.equal(applied.execution.operationId, command.operation_id);
    assert.deepEqual([...applied.copied].sort(), [...targets].sort()); assert.equal(writes.length, 2);
    assert.equal(new Set(writes.map(value => value.client)).size, 1); assert.equal(new Set(writes.map(value => value.pid)).size, 1);
    assert.equal(new Set(writes.map(value => value.xid)).size, 1);
    assert(b1Births); assert.equal(b1Births.length, 2);
    const first = await rawCopyTargets(command.operation_id, targets); assert.deepEqual(first.births, b1Births);
    assert(first.imports.every(row => row.xmin === String(BigInt(writes[0].xid) % (BigInt(1) << BigInt(32)))));
    await assert.rejects(h.admin.query(`UPDATE collaboration_native_copy_markdown_births SET created_at=created_at+1
      WHERE workspace_id=$1 AND parent_operation_id=$2`, [h.destination.workspaceId, command.operation_id]), { code: '55000' });
    await assert.rejects(h.admin.query(`DELETE FROM collaboration_native_copy_markdown_births
      WHERE workspace_id=$1 AND parent_operation_id=$2`, [h.destination.workspaceId, command.operation_id]), { code: '55000' });
    assert.deepEqual(await rawCopyCohort(command.operation_id), first.births);
    assert.deepEqual(await rawCopySourceSnapshot(), sourceBefore); groups++;

    phase = 'completed public Status, Apply retry and Recover are historical and wholly non-mutating';
    await rawCopyNoWrites(async () => {
      const status = await rawCopyCall({ action: 'status', operation_id: command.operation_id }); assert(status.action === 'status');
      assert.equal(status.operation.operationId, command.operation_id);
      assert.equal(status.operation.completion.status, 'confirmed');
      if (status.operation.completion.status === 'confirmed') assert.equal(status.operation.completion.historical, true);
      for (const action of ['apply', 'recover'] as const) {
        const repeated = await rawCopyCall({ action, ...command }); assert(repeated.action === action);
        assert.equal(repeated.execution.status, 'complete'); assert.equal(repeated.alreadyKnown, true);
        assert.deepEqual([...repeated.copied].sort(), [...targets].sort());
      }
    });
    assert.deepEqual(await rawCopyImportRows(targets), first.imports); assert.deepEqual(await rawCopySourceSnapshot(), sourceBefore); groups++;

    phase = 'same-basename Raw self-link imports natively without a fabricated link delta';
    const stableSelections = [{ source_path: 'stable-raw.md', destination_path: 'stable-raw.md' }];
    const stablePreview = await rawCopyNoWrites(() => rawCopyCall({ action: 'preview', selections: stableSelections })); assert(stablePreview.action === 'preview');
    const stableCommand = { selections: stableSelections, operation_id: crypto.randomUUID(), plan_id: stablePreview.preview.planId };
    const stableApplied = await h.withProbe(async event => rawCopyCaptureStage(event, stableCommand.operation_id),
      () => rawCopyCall({ action: 'apply', ...stableCommand }));
    assert(stableApplied.action === 'apply'); assert.equal(stableApplied.execution.status, 'complete');
    assert.deepEqual(stableApplied.copied, ['stable-raw.md']); assert.equal(stableApplied.alreadyKnown, false);
    const stableCohort = await rawCopyCohort(stableCommand.operation_id); assert.equal(stableCohort.length, 1);
    const stableBirth = stableCohort[0], stableState = await load(h.connection, stableBirth.binding.receipt.target.documentId); assert(stableState);
    assert.equal(stableState.documentSequence, 0); assert.equal(inspectPersistedDocumentLinks(stableState).version.stateProof, stableBirth.binding.receipt.target.initialStateProof);
    assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_native_link_mutation_receipts WHERE document_id=$1', [stableState.documentId])).rows[0].n, 0);
    const stableStage = stages.get(stableCommand.operation_id); assert(stableStage);
    const stableRead = await readDocumentForRequest(await h.request(h.destination, 'member'), { apiVersion: 1, workspaceId: h.destination.workspaceId,
      documentId: stableState.documentId, format: 'markdown', maxBytes: 262144 });
    assert(stableRead.complete); assert.equal(stableRead.document.path, 'stable-raw.md'); assert.equal(stableRead.document.lineageId, stableBirth.binding.receipt.target.lineageId);
    assert.equal(stableRead.fragment, rawCopyExpectedMarkdown(stableStage, stableBirth));
    assert.equal(stableRead.fragment, stableBytes.toString('utf8').replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n'));
    assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, 'stable-raw.md')), stableBytes);
    const stableObserved = await readWorkspaceCopySourceObservationOnConnection(h.connection, h.destination, { physicalParserVersion: 3 });
    const stableGraph = buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedCopySourceSnapshot(
      captureWorkspaceOperationCopySourceEvidenceV4(captureWorkspaceOperationJobScope(h.destination), stableObserved)));
    const stableEdges = stableGraph.edges.filter(edge => edge.sourceKind === 'native' && edge.source.documentId === stableState.documentId);
    assert.equal(stableEdges.length, 1); assert.equal(stableEdges[0].resolution.status, 'resolved');
    assert.equal(stableEdges[0].resolution.target?.documentId, stableState.documentId);
    await rawCopyNoWrites(async () => {
      const status = await rawCopyCall({ action: 'status', operation_id: stableCommand.operation_id }); assert(status.action === 'status');
      assert.equal(status.operation.completion.status, 'confirmed');
      const retry = await rawCopyCall({ action: 'recover', ...stableCommand }); assert(retry.action === 'recover');
      assert.equal(retry.execution.status, 'complete'); assert.equal(retry.alreadyKnown, true);
    });
    assert.deepEqual(await rawCopyCohort(stableCommand.operation_id), stableCohort);
    assert.deepEqual(await rawCopySourceSnapshot(), sourceBefore); groups++;

    phase = 'actual B1 import COMMIT acknowledgement loss is independently visible before fault';
    const recoveryTargets = ['recovery-renamed-a.md', 'recovery-renamed-b.markdown'];
    const recoverySelections = sources.map((source_path, index) => ({ source_path, destination_path: recoveryTargets[index] }));
    const recoveryPreview = await rawCopyNoWrites(() => rawCopyCall({ action: 'preview', selections: recoverySelections }));
    assert(recoveryPreview.action === 'preview');
    const recoveryCommand = { selections: recoverySelections, operation_id: crypto.randomUUID(), plan_id: recoveryPreview.preview.planId };
    let proof: { client: MetadataSqlEvent['client']; pid: number; start: string; xid: string; rows: Awaited<ReturnType<typeof rawCopyImportRows>>;
      births: readonly NativeCopyMarkdownBirthV1[] } | undefined;
    let lost = false;
    const interrupted = await h.withProbe(async event => {
      await rawCopyCaptureStage(event, recoveryCommand.operation_id);
      if (/^\s*INSERT\s+INTO\s+collaboration_native_copy_markdown_births\b/iu.test(event.text)
        && event.values[1] === recoveryCommand.operation_id && event.values[2] === 1) {
        const rows = await rawCopyImportRows(recoveryTargets, event.raw);
        if (rows.length === 2) {
          assert(!proof); const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert(actual.xid); assert.equal(actual.schema, h.schema); assert.equal((await rawCopyImportRows(recoveryTargets)).length, 0);
          const births = await rawCopyCohort(recoveryCommand.operation_id, event.raw, actual.xid);
          proof = { client: event.client, pid: Number(actual.pid), start: actual.start, xid: actual.xid, rows, births };
          assert(rows.every(row => row.xmin === String(BigInt(actual.xid) % (BigInt(1) << BigInt(32)))));
        }
      }
      if (proof && event.client === proof.client && /^COMMIT\s*;?$/iu.test(event.text.trim()) && !lost) {
        assert.equal(event.result.command, 'COMMIT');
        const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
          pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
        assert.equal(Number(actual.pid), proof.pid); assert.equal(actual.start, proof.start); assert.equal(actual.xid, null);
        assert.notEqual((await h.admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, proof.pid);
        assert.deepEqual(await rawCopyImportRows(recoveryTargets), proof.rows);
        assert.deepEqual(await rawCopyCohort(recoveryCommand.operation_id), proof.births); lost = true;
        throw Object.assign(new Error('Actual selected raw Copy B1 COMMIT acknowledgement lost.'), { code: 'RAW_COPY_ACK_LOST' });
      }
    }, () => rawCopyCall({ action: 'apply', ...recoveryCommand }));
    assert(proof && lost); assert(interrupted.action === 'apply'); assert.equal(interrupted.execution.status, 'needs_recovery');
    assert.equal(interrupted.execution.errorCode, 'COPY_OUTCOME_UNCONFIRMED'); assert.deepEqual(interrupted.copied, []);
    const born = await rawCopyImportRows(recoveryTargets); assert.equal(born.length, 2);
    const bornCohort = await rawCopyCohort(recoveryCommand.operation_id); assert.deepEqual(bornCohort, proof.births);
    phase = 'actual Raw-Birth projector is pending after committed B1 and before B2, with all source/target facts unchanged';
    await rawCopyAssertProjectionPublication(recoveryCommand.operation_id, bornCohort, 'pending');
    assert(born.every(row => row.actor_session_id === 'session-member')); assert.deepEqual(await rawCopySourceSnapshot(), sourceBefore); groups++;

    phase = 'fresh genuine same-client SID-B recovers the original imports and completed history without replay';
    const oldToken = currentToken, oldId = sessionId, nextId = `raw-copy-session-${crypto.randomUUID()}`, now = Date.now();
    sessionToken = crypto.randomBytes(32).toString('hex');
    await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)',
      [nextId, sessionToken, now + 3600000, now]);
    assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [oldId])).rowCount, 1);
    sessionId = nextId; currentToken = await rawCopyIssueToken(nextId);
    const actualSession = await auth.api.getSession({ headers: (await h.request(h.destination, 'member', false, sessionToken)).headers });
    assert.equal(actualSession?.user.id, 'member'); assert.equal(actualSession?.session.id, nextId); assert.notEqual(nextId, oldId);
    await assert.rejects(rawCopyCall({ action: 'status', operation_id: recoveryCommand.operation_id }, oldToken),
      error => error instanceof DirectMcpAuthorizationError && error.status === 401);
    const recovered = await rawCopyCall({ action: 'recover', ...recoveryCommand }); assert(recovered.action === 'recover');
    assert.equal(recovered.execution.status, 'complete'); assert.equal(recovered.alreadyKnown, true);
    assert.equal(recovered.execution.operationId, recoveryCommand.operation_id);
    const recoveredTargets = await rawCopyTargets(recoveryCommand.operation_id, recoveryTargets);
    assert.deepEqual(recoveredTargets.imports, born);
    assert.deepEqual(recoveredTargets.births, bornCohort);
    assert(recoveredTargets.rows.every(row => !first.rows.some(original => original.id === row.id || original.lineage_id === row.lineage_id)));
    phase = 'actual B2 publication releases the same Raw-Birth identity and publication guards without exporting or mutating OriginalBytes';
    await rawCopyAssertProjectionPublication(recoveryCommand.operation_id, bornCohort, 'released');
    phase = 'fresh genuine same-client SID-B historical retries remain wholly non-mutating after projector guard checks';
    await rawCopyNoWrites(async () => {
      const status = await rawCopyCall({ action: 'status', operation_id: recoveryCommand.operation_id }); assert(status.action === 'status');
      assert.equal(status.operation.completion.status, 'confirmed');
      for (const action of ['apply', 'recover'] as const) {
        const historical = await rawCopyCall({ action, ...recoveryCommand }); assert(historical.action === action);
        assert.equal(historical.execution.status, 'complete'); assert.equal(historical.alreadyKnown, true);
      }
    });
    assert.deepEqual(await rawCopyImportRows(recoveryTargets), born); assert.deepEqual(await rawCopyCohort(recoveryCommand.operation_id), bornCohort);
    assert.deepEqual(await rawCopySourceSnapshot(), sourceBefore); groups++;
    assert.equal(groups, 8);
    assert.equal(projectionPendingTargets, 2); assert.equal(projectionReleasedTargets, 2);
  }); complete = true; console.log(JSON.stringify({ test: 'workspace-operation-selected-raw-copy-postgres', groups, originalExit: 0,
    projectionPendingTargets, projectionReleasedTargets, releasedProjectionGuardReadOnly: true })); }
  finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}

workspaceOperationSelectedRawCopyPostgresTest().catch((error: unknown) => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error(JSON.stringify({ test: 'workspace-operation-selected-raw-copy-postgres', phase, groups,
    name: error instanceof Error ? error.name : 'UnknownError', code: typeof code === 'string' && /^[A-Z0-9_]{1,120}$/u.test(code) ? code : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 8) : undefined,
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 1500) : undefined })); process.exitCode = 1;
});
