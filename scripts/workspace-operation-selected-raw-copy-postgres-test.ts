import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { MarkdownFileImportReceipt } from '../app/lib/collaboration/markdown-file-import-persistence';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Forward-looking acceptance, intentionally RED until selected-raw target
// import is connected. No private future Stage/plan/receipt shape is invented.
let phase = 'fixture', groups = 0, complete = false;
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
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { readWorkspaceCopySourceObservationOnConnection } = await import('../app/lib/files/workspace-operation-copy-source-observation');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { captureWorkspaceOperationCopySourceEvidenceV4, workspaceOperationMixedCopySourceSnapshot } = await import('../app/lib/files/workspace-operation-copy-source-evidence-v4');
    const { buildWorkspaceMixedReadLinkGraphV3 } = await import('../app/lib/markdown/workspace-native-link-graph');
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canWrite);
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
      const catalogue = await readWorkspaceCopySourceObservationOnConnection(h.connection, h.source);
      assert(catalogue.stage.coverage.complete);
      assert(!catalogue.nativeBindings.some(binding => ['selected-raw-a.md', 'selected-raw-b.markdown'].includes(binding.expected.path)));
      assert.deepEqual(catalogue.stage.sources.filter(source => source.kind === 'physical')
        .map(source => source.inventory.path).sort(), ['selected-raw-a.md', 'selected-raw-b.markdown']);
      return { rows, catalogue, files: await rawCopyFilesystem(h.source.rootPath) };
    };
    const sources = ['selected-raw-a.md', 'selected-raw-b.markdown'] as const;
    const sourceBytes = [Buffer.from('\uFEFF---\r\naliases: [Raw A]\r\n---\r\n# Raw A\r\n\r\n[Self](selected-raw-a.md) [Other](selected-raw-b.markdown) [[Raw B]] **bold** Ω.\r\n'),
      Buffer.from('---\naliases: [Raw B]\n---\n# Raw B\n\n[Self](selected-raw-b.markdown) [Other](selected-raw-a.md) [[Raw A]] 🙂.\n')];
    for (const [index, source] of sources.entries()) await fs.writeFile(path.join(h.source.rootPath, source), sourceBytes[index], { flag: 'wx', mode: 0o600 });
    for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) assert.equal((await h.admin.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1 AND path=ANY($2::text[])`, [h.source.workspaceId, sources])).rows[0].n, 0);
    const sourceBefore = await rawCopySourceSnapshot();
    const rawCopyImportRows = async (targets: readonly string[], query?: MetadataSqlEvent['raw']) => {
      const sql = `SELECT operation_id,actor_user_id,actor_session_id,request_fingerprint,private_result,xmin::text AS xmin
        FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1
        AND private_result->'target'->>'path'=ANY($2::text[]) ORDER BY private_result->'target'->>'path',operation_id LIMIT 3`;
      const values = [h.destination.workspaceId, [...targets]];
      const rows = (query ? await query(sql, values) : await h.admin.query(sql, values)).rows as Array<{ operation_id: string; actor_user_id: string; actor_session_id: string;
        request_fingerprint: string; private_result: MarkdownFileImportReceipt; xmin: string }>;
      assert(rows.length <= 2); return rows;
    };
    const rawCopyTargets = async (targets: readonly string[]) => {
      assert.equal(targets.length, 2);
      const rows = (await h.admin.query(`SELECT d.id,d.lineage_id,d.path,d.yjs_state_lifecycle,l.workspace_id,l.status,
        s.lifecycle_generation FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
        JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.workspace_id=$1 AND d.path=ANY($2::text[])
        AND d.status='active' AND d.provider='yjs' ORDER BY d.path LIMIT 3`, [h.destination.workspaceId, [...targets]])).rows;
      assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.id)).size, 2); assert.equal(new Set(rows.map(row => row.lineage_id)).size, 2);
      const byPath = new Map(rows.map(row => [String(row.path), row]));
      const imports = await rawCopyImportRows(targets); assert.equal(imports.length, 2);
      assert.equal(new Set(imports.map(row => row.operation_id)).size, 2);
      const observation = await readWorkspaceCopySourceObservationOnConnection(h.connection, h.destination);
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
        const request = await h.request(h.destination, 'member', false, sessionToken);
        const native = await readDocumentForRequest(request, { apiVersion: 1, workspaceId: h.destination.workspaceId,
          documentId: row.id, format: 'native', maxBytes: 262144 });
        assert(native.complete); assert.equal(native.nextCursor, null); assert.equal(native.document.documentId, row.id);
        assert.equal(native.document.lineageId, row.lineage_id); assert.equal(native.document.path, targetPath); JSON.parse(native.fragment);
        const markdown = await readDocumentForRequest(request, { apiVersion: 1, workspaceId: h.destination.workspaceId,
          documentId: row.id, expectedVersion: native.document.version, format: 'markdown', maxBytes: 262144 });
        assert(markdown.complete); assert.deepEqual(markdown.document, native.document);
        let expected = sourceBytes[index].toString('utf8').replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n');
        for (const [sourceIndex, originalPath] of sources.entries()) expected = expected.replaceAll(originalPath, targets[sourceIndex]);
        assert.equal(markdown.fragment, expected);
        const edges = graph.edges.filter(edge => edge.sourceKind === 'native' && edge.source.documentId === row.id);
        assert.equal(edges.length, 3); assert(edges.every(edge => edge.resolution.status === 'resolved' && edge.resolution.target?.documentId));
        assert.deepEqual(edges.map(edge => edge.resolution.target!.documentId).sort(),
          [byPath.get(targets[index])!.id, byPath.get(targets[1 - index])!.id, byPath.get(targets[1 - index])!.id].sort());
      }
      return { rows, imports };
    };

    phase = 'public selected raw Preview is ready and wholly non-mutating';
    const targets = ['copied-renamed-a.md', 'copied-renamed-b.markdown'];
    const selections = sources.map((source_path, index) => ({ source_path, destination_path: targets[index] }));
    const preview = await rawCopyNoWrites(() => rawCopyCall({ action: 'preview', selections }));
    assert(preview.action === 'preview'); assert.equal(preview.preview.readiness, 'ready'); assert(preview.preview.coverage.complete);
    assert.deepEqual(preview.preview.pathMappings.map(mapping => [mapping.sourcePath, mapping.destinationPath]).sort(),
      sources.map((source, index) => [source, targets[index]]).sort());
    assert.deepEqual(await rawCopySourceSnapshot(), sourceBefore); groups++;

    phase = 'public Apply imports two independent native targets on the same B and correctly rebinds every link';
    const command = { selections, operation_id: crypto.randomUUID(), plan_id: preview.preview.planId };
    const writes: Array<{ client: MetadataSqlEvent['client']; xid: string; pid: number }> = [];
    const applied = await h.withProbe(async event => {
      if (/^\s*INSERT\s+INTO\s+(?:"?[^".\s]+"?\.)?"?collaboration_markdown_file_import_receipts"?\b/iu.test(event.text)) {
        const actual = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        assert(actual.xid); assert.equal(event.result.rowCount, 1); writes.push({ client: event.client, pid: Number(actual.pid), xid: actual.xid });
      }
    }, () => rawCopyCall({ action: 'apply', ...command }));
    assert(applied.action === 'apply'); assert.equal(applied.execution.status, 'complete'); assert.equal(applied.alreadyKnown, false);
    assert.equal(applied.execution.operationId, command.operation_id);
    assert.deepEqual([...applied.copied].sort(), [...targets].sort()); assert.equal(writes.length, 2);
    assert.equal(new Set(writes.map(value => value.client)).size, 1); assert.equal(new Set(writes.map(value => value.pid)).size, 1);
    assert.equal(new Set(writes.map(value => value.xid)).size, 1);
    const first = await rawCopyTargets(targets);
    assert(first.imports.every(row => row.xmin === String(BigInt(writes[0].xid) % (BigInt(1) << BigInt(32)))));
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

    phase = 'actual B1 import COMMIT acknowledgement loss is independently visible before fault';
    const recoveryTargets = ['recovery-renamed-a.md', 'recovery-renamed-b.markdown'];
    const recoverySelections = sources.map((source_path, index) => ({ source_path, destination_path: recoveryTargets[index] }));
    const recoveryPreview = await rawCopyNoWrites(() => rawCopyCall({ action: 'preview', selections: recoverySelections }));
    assert(recoveryPreview.action === 'preview');
    const recoveryCommand = { selections: recoverySelections, operation_id: crypto.randomUUID(), plan_id: recoveryPreview.preview.planId };
    let proof: { client: MetadataSqlEvent['client']; pid: number; start: string; xid: string; rows: Awaited<ReturnType<typeof rawCopyImportRows>> } | undefined;
    let lost = false;
    const interrupted = await h.withProbe(async event => {
      if (/^\s*INSERT\s+INTO\s+(?:"?[^".\s]+"?\.)?"?collaboration_markdown_file_import_receipts"?\b/iu.test(event.text)) {
        const rows = await rawCopyImportRows(recoveryTargets, event.raw);
        if (rows.length === 2) {
          assert(!proof); const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert(actual.xid); assert.equal(actual.schema, h.schema); assert.equal((await rawCopyImportRows(recoveryTargets)).length, 0);
          proof = { client: event.client, pid: Number(actual.pid), start: actual.start, xid: actual.xid, rows };
          assert(rows.every(row => row.xmin === String(BigInt(actual.xid) % (BigInt(1) << BigInt(32)))));
        }
      }
      if (proof && event.client === proof.client && /^COMMIT\s*;?$/iu.test(event.text.trim()) && !lost) {
        assert.equal(event.result.command, 'COMMIT');
        const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
          pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
        assert.equal(Number(actual.pid), proof.pid); assert.equal(actual.start, proof.start); assert.equal(actual.xid, null);
        assert.notEqual((await h.admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, proof.pid);
        assert.deepEqual(await rawCopyImportRows(recoveryTargets), proof.rows); lost = true;
        throw Object.assign(new Error('Actual selected raw Copy B1 COMMIT acknowledgement lost.'), { code: 'RAW_COPY_ACK_LOST' });
      }
    }, () => rawCopyCall({ action: 'apply', ...recoveryCommand }));
    assert(proof && lost); assert(interrupted.action === 'apply'); assert.equal(interrupted.execution.status, 'needs_recovery');
    assert.equal(interrupted.execution.errorCode, 'COPY_OUTCOME_UNCONFIRMED'); assert.deepEqual(interrupted.copied, []);
    const born = await rawCopyImportRows(recoveryTargets); assert.equal(born.length, 2);
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
    const recoveredTargets = await rawCopyTargets(recoveryTargets);
    assert.deepEqual(recoveredTargets.imports, born);
    assert(recoveredTargets.rows.every(row => !first.rows.some(original => original.id === row.id || original.lineage_id === row.lineage_id)));
    await rawCopyNoWrites(async () => {
      const status = await rawCopyCall({ action: 'status', operation_id: recoveryCommand.operation_id }); assert(status.action === 'status');
      assert.equal(status.operation.completion.status, 'confirmed');
      for (const action of ['apply', 'recover'] as const) {
        const historical = await rawCopyCall({ action, ...recoveryCommand }); assert(historical.action === action);
        assert.equal(historical.execution.status, 'complete'); assert.equal(historical.alreadyKnown, true);
      }
    });
    assert.deepEqual(await rawCopyImportRows(recoveryTargets), born); assert.deepEqual(await rawCopySourceSnapshot(), sourceBefore); groups++;
    assert.equal(groups, 5);
  }); complete = true; console.log(JSON.stringify({ test: 'workspace-operation-selected-raw-copy-postgres', groups, originalExit: 0 })); }
  finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}

workspaceOperationSelectedRawCopyPostgresTest().catch((error: unknown) => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error(JSON.stringify({ test: 'workspace-operation-selected-raw-copy-postgres', phase, groups,
    name: error instanceof Error ? error.name : 'UnknownError', code: typeof code === 'string' && /^[A-Z0-9_]{1,120}$/u.test(code) ? code : undefined,
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 1500) : undefined })); process.exitCode = 1;
});
