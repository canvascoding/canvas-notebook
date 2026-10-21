import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { JSONContent } from '@tiptap/core';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { NativeCopyReceipt } from '../app/lib/collaboration/native-copy-persistence';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Real fixture JWT/current policy -> public MCP service -> existing Copy owner,
// FD publication and PG receipts. This is neither OAuth issuance nor browser or
// selected physical-Markdown import acceptance. No product result is replaced.
let phase = 'fixture', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const mixedCopyCode = (error: unknown): string | null => error instanceof Error
  && typeof Object.getOwnPropertyDescriptor(error, 'code')?.value === 'string'
  ? Object.getOwnPropertyDescriptor(error, 'code')!.value : null;

export async function workspaceOperationMixedCopyPostgresTest(): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source,read_knowledge_source' });
    const { auth } = await import('../app/lib/auth');
    const { DirectMcpAuthorizationError } = await import('../app/lib/mcp/server/access-token-verifier');
    const { decodeDirectMcpWorkspaceCopyRequestV1: decode } = await import('../app/lib/mcp/server/workspace-copy-tool-contract');
    const { runDirectMcpWorkspaceCopyService: service } = await import('../app/lib/files/workspace-file-operation-service');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: inspect } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { authoritativeNativeCollaborationSnapshot: snapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { importExcalidrawDocumentFile } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { captureExcalidrawCopyIntent, captureExcalidrawCopyBirthReceipt } = await import('../app/lib/excalidraw-collaboration/copy-data');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { readWorkspaceCopySourceObservationOnConnection } = await import('../app/lib/files/workspace-operation-copy-source-observation');
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId); assert(sourceOwner);
    assert(h.source.permissions.canRead && !h.source.permissions.canWrite);
    assert(h.destination.permissions.canWrite);
    const clients = new Map<'member' | 'owner', string>();
    for (const userId of ['member', 'owner'] as const) {
      const clientId = `mixed-copy-${crypto.randomUUID()}`; clients.set(userId, clientId);
      await h.admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
        VALUES($1,$1,$2,'Actual mixed Copy fixture',0,'[]',100,100)`, [clientId, userId]);
      await h.admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
        VALUES($1,$2,$3,'["knowledge:write","knowledge:read"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), clientId, userId]);
      for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId]) {
        await h.admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
          VALUES($1,'owner',100,100) ON CONFLICT(workspace_id) DO NOTHING`, [workspaceId]);
        await h.admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
          VALUES($1,$2,$3,100,100)`, [clientId, userId, workspaceId]);
      }
    }
    const mixedCopyIssueToken = async (userId: 'owner' | 'member', sessionId = `session-${userId}`) => {
      const seconds = Math.floor(Date.now() / 1000);
      const signed = await auth.api.signJWT({ body: { payload: { sub: userId, azp: clients.get(userId), sid: sessionId,
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: seconds - 1, exp: seconds + 600,
        scope: 'knowledge:write knowledge:read' } } }); assert(signed.token); return signed.token;
    };
    const memberToken = await mixedCopyIssueToken('member'), ownerToken = await mixedCopyIssueToken('owner');
    const mixedCopyCall = (input: Record<string, unknown>, token = memberToken, sameWorkspace = false) => {
      const info: AuthInfo = { token, clientId: 'untrusted-caller-client', scopes: [], extra: { userId: 'owner' } };
      return service(decode({ api_version: 1, source_workspace_id: h.source.workspaceId,
        destination_workspace_id: sameWorkspace ? h.source.workspaceId : h.destination.workspaceId, ...input }), info);
    };
    const mixedCopyFilesystem = async (root: string) => {
      const rows: unknown[] = [], pending = ['.'];
      while (pending.length) {
        assert(rows.length < 10000); const relative = pending.shift()!, file = path.join(root, relative);
        const value = await fs.lstat(file, { bigint: true }); assert(!value.isSymbolicLink());
        const identity = { path: relative, dev: String(value.dev), ino: String(value.ino), mode: String(value.mode),
          uid: String(value.uid), gid: String(value.gid), size: String(value.size), nlink: String(value.nlink),
          mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
        rows.push(value.isFile() ? { ...identity, sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') } : identity);
        if (value.isDirectory()) pending.push(...(await fs.readdir(file)).sort().map(name => path.join(relative, name)));
      }
      return rows;
    };
    const mixedCopySourceSnapshot = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages',
        'collaboration_excalidraw_states', 'collaboration_excalidraw_assets', 'collaboration_file_projections',
        'workspace_file_metadata', 'workspace_file_user_states', 'file_revisions']) {
        const predicate = table === 'collaboration_file_projections'
          ? 'document_id IN (SELECT id FROM collaboration_documents WHERE workspace_id=$1)' : 'workspace_id=$1';
        rows[table] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${table} t
          WHERE ${predicate} ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`, [h.source.workspaceId])).rows;
        assert((rows[table] as unknown[]).length <= 10000);
      }
      return { rows, files: await mixedCopyFilesystem(h.source.rootPath) };
    };
    const mixedCopyDomainSnapshot = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
        AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)' OR c.relname='file_revisions')
        ORDER BY c.relname LIMIT 513`, [h.schema])).rows; assert(tables.length > 11 && tables.length <= 512);
      const rows: Record<string, unknown> = {};
      for (const table of tables) {
        assert.equal(typeof table.relname, 'string'); assert.equal(typeof table.oid, 'string');
        const name = `"${String(table.relname).replaceAll('"', '""')}"`;
        rows[table.relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert((rows[table.relname] as unknown[]).length <= 10000);
      }
      return { tables, rows };
    };
    const mixedCopyNoWrites = async <T>(operation: () => Promise<T>): Promise<T> => {
      const before = await mixedCopyDomainSnapshot(), files = await mixedCopyFilesystem(h.dataRoot);
      let statements = 0, writes = 0;
      try { return await h.withProbe(async event => {
        assert(++statements <= 5000);
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
      }, operation); }
      finally {
        assert(statements > 0); assert.equal(writes, 0);
        assert.deepEqual(await mixedCopyDomainSnapshot(), before); assert.deepEqual(await mixedCopyFilesystem(h.dataRoot), files);
      }
    };
    const mixedCopyNativeReceipt = async (operationId: string) => {
      const rows = (await h.admin.query(`SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1`, [operationId])).rows;
      assert.equal(rows.length, 1); return rows[0] as { actor_user_id: string; actor_session_id: string; publication_status: string;
        request_fingerprint: string; private_result: Omit<NativeCopyReceipt, 'publicationStatus'>; xmin: string };
    };
    const mixedCopyNormalizeContent = (input: JSONContent, reverse: Map<string, string>, used: Set<string>): JSONContent => {
      const node = structuredClone(input);
      if (node.attrs?.id) { const id = String(node.attrs.id), originalId = reverse.get(id); assert(originalId);
        assert(!used.has(id)); used.add(id); node.attrs.id = originalId; }
      for (const mark of node.marks ?? []) if (mark.type === 'link' && mark.attrs) mark.attrs.href = '[separately-checked-target]';
      if (node.content) node.content = node.content.map(child => mixedCopyNormalizeContent(child, reverse, used)); return node;
    };
    const mixedCopyAssertClones = async (operationId: string, destinationRoot: string, destinationWorkspaceId: string) => {
      const ledger = await mixedCopyNativeReceipt(operationId), receipt = ledger.private_result;
      assert.equal(ledger.publication_status, 'published'); assert.equal(receipt.documents.length, 2);
      assert.equal(receipt.operationId, operationId); assert.equal(receipt.workspaceId, destinationWorkspaceId);
      const freshIds = new Set<string>(), freshLineages = new Set<string>(); let checkedRichNodes = 0, checkedLinks = 0;
      for (const clone of receipt.documents) {
        const before = await load(h.connection, clone.source.documentId), after = await load(h.connection, clone.clone.documentId); assert(before && after);
        assert.notEqual(after.documentId, before.documentId); assert.equal(after.documentId, clone.clone.documentId);
        assert.equal(after.workspaceId, destinationWorkspaceId); assert.equal(after.lifecycleGeneration, 1); assert.equal(after.path, clone.clone.path);
        assert(!freshIds.has(after.documentId)); freshIds.add(after.documentId);
        const originalLineage = (await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [before.documentId])).rows[0].lineage_id;
        assert.notEqual(clone.clone.lineageId, originalLineage); assert(!freshLineages.has(clone.clone.lineageId)); freshLineages.add(clone.clone.lineageId);
        assert.equal((await h.admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [after.documentId])).rows[0].lineage_id, clone.clone.lineageId);
        const beforeClients = Y.decodeStateVector(before.stateVector), afterClients = Y.decodeStateVector(after.stateVector);
        assert(beforeClients.size > 0 && afterClients.size > 0);
        assert([...afterClients.keys()].every(client => !beforeClients.has(client)));
        const oldInventory = inspect(before), newInventory = inspect(after); assert(oldInventory.coverage.complete && newInventory.coverage.complete);
        assert.equal(newInventory.links.length, oldInventory.links.length);
        for (const link of newInventory.links) {
          const resolved: string = link.targetPathText.startsWith('/') ? link.targetPathText.slice(1)
            : path.posix.normalize(path.posix.join(path.posix.dirname(after.path), link.targetPathText));
          const target: NativeCopyReceipt['documents'][number] | undefined = receipt.documents.find(item => item.clone.path === resolved); assert(target, 'Every actual copied outgoing link resolves to a receipt-bound copied target.');
          assert.equal(resolved, `${destinationRoot}/target.md`); checkedLinks++;
        }
        const oldContent = snapshot(before).content, newContent = snapshot(after).content;
        assert(oldContent.kind === 'rich_text' && newContent.kind === 'rich_text', 'This real upload must exercise rich block-ID rebinding.');
        assert.equal(newContent.frontmatter, oldContent.frontmatter); assert.equal(newContent.bodyFinalLineEnding, oldContent.bodyFinalLineEnding);
        const entries = Object.entries(clone.blockIdMapping); assert(entries.length > 0);
        assert.equal(new Set(entries.map(([, fresh]) => fresh)).size, entries.length);
        assert(entries.every(([old, fresh]) => old !== fresh)); checkedRichNodes += entries.length;
        const reverse = new Map(entries.map(([old, fresh]) => [fresh, old]));
        const identity = new Map(entries.map(([old]) => [old, old]));
        const freshUsed = new Set<string>(), originalUsed = new Set<string>();
        assert.deepEqual(mixedCopyNormalizeContent(newContent.document, reverse, freshUsed), mixedCopyNormalizeContent(oldContent.document, identity, originalUsed));
        assert.equal(freshUsed.size, reverse.size); assert.equal(originalUsed.size, identity.size);
      }
      assert(checkedRichNodes > 0); assert.equal(checkedLinks, 1);
      assert.equal((await h.admin.query('SELECT title FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2',
        [destinationWorkspaceId, `${destinationRoot}/note.md`])).rows[0].title, 'Actual shared title');
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM workspace_file_user_states WHERE workspace_id=$1 AND path=$2',
        [destinationWorkspaceId, `${destinationRoot}/note.md`])).rows[0].n, 0);
      const sceneLedgers = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [operationId])).rows;
      assert.equal(sceneLedgers.length, 1); const sceneLedger = sceneLedgers[0]; assert(sceneLedger.birth_json);
      const intent = captureExcalidrawCopyIntent(sceneLedger.intent_json), birth = captureExcalidrawCopyBirthReceipt(sceneLedger.birth_json);
      assert.equal(intent.operationId, operationId); assert.deepEqual(birth.intent, intent); assert.equal(intent.documents.length, 1); assert.equal(birth.documents.length, 1);
      assert.equal(intent.origin.actor.userId, ledger.actor_user_id); assert.equal(intent.origin.actor.sessionId, ledger.actor_session_id);
      const sceneIntent = intent.documents[0], sceneBirth = birth.documents[0];
      assert.equal(sceneIntent.sourceDocumentId, originalScene.documentId); assert.equal(sceneIntent.sourceLineageId, originalSceneState.lineage_id);
      assert.equal(sceneIntent.sourceCanonicalHash, originalSceneState.canonical_hash);
      assert.equal(sceneIntent.sourceContentProof, originalSceneSnapshot.contentProof);
      assert.equal(sceneIntent.sourceGeneration, originalSceneSnapshot.header.lifecycle_generation);
      assert.equal(sceneIntent.sourceSceneSequence, originalSceneSnapshot.header.scene_sequence);
      assert.equal(sceneIntent.sourceWorkspaceId, h.source.workspaceId); assert.equal(sceneIntent.destinationWorkspaceId, destinationWorkspaceId);
      assert.equal(sceneIntent.destinationPath, `${destinationRoot}/diagram.excalidraw`);
      assert.notEqual(sceneIntent.documentId, originalScene.documentId); assert.notEqual(sceneIntent.lineageId, originalSceneState.lineage_id);
      assert(!freshIds.has(sceneIntent.documentId) && !freshLineages.has(sceneIntent.lineageId));
      assert.equal(sceneBirth.documentId, sceneIntent.documentId); assert.equal(sceneBirth.lineageId, sceneIntent.lineageId);
      const sceneRow = (await h.admin.query(`SELECT d.provider,d.lineage_id,d.xmin::text AS registry_xmin,l.xmin::text AS lineage_xmin,
        s.*,s.xmin::text AS scene_xmin FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
        JOIN collaboration_excalidraw_states s ON s.document_id=d.id WHERE d.id=$1`, [sceneIntent.documentId])).rows[0]; assert(sceneRow);
      assert.equal(sceneRow.provider, 'excalidraw'); assert.equal(sceneRow.lineage_id, sceneIntent.lineageId);
      assert.equal(sceneRow.workspace_id, destinationWorkspaceId); assert.equal(sceneRow.path, sceneIntent.destinationPath);
      assert.equal(Number(sceneRow.lifecycle_generation), 1); assert.equal(Number(sceneRow.scene_sequence), 0);
      assert.equal(sceneRow.canonical_hash, originalSceneState.canonical_hash);
      assert.deepEqual(sceneRow.elements_json, originalSceneState.elements_json);
      assert.deepEqual(sceneRow.shared_app_state_json, originalSceneState.shared_app_state_json); assert.deepEqual(sceneRow.assets_json, []);
      const b2 = String(BigInt(birth.b2TransactionId) % (BigInt(1) << BigInt(32)));
      assert.equal(sceneLedger.xmin, b2); assert.equal(sceneRow.registry_xmin, b2); assert.equal(sceneRow.lineage_xmin, b2); assert.equal(sceneRow.scene_xmin, b2);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_yjs_states WHERE document_id=$1', [sceneIntent.documentId])).rows[0].n, 0);
      const destinationWorkspace = destinationWorkspaceId === h.source.workspaceId ? h.source : h.destination;
      const portable = JSON.parse(await fs.readFile(path.join(destinationWorkspace.rootPath, sceneIntent.destinationPath), 'utf8'));
      assert.equal(portable.type, 'excalidraw'); assert.deepEqual(portable.elements, originalSceneState.elements_json);
      assert.equal(Object.keys(portable.files).length, 0); return ledger;
    };
    const root = `native-copy-${crypto.randomUUID()}`, destination = `copied-${crypto.randomUUID()}`;
    await h.upload(`${root}/note.md`, Buffer.from(`# Native note\n\n[Target](/${root}/target.md)\n\n**Preserved bold text** 😀\n`));
    await h.upload(`${root}/target.md`, Buffer.from('# Native target\n\nOriginal body.\n'));
    const originalScene = await importExcalidrawDocumentFile({ workspace: sourceOwner,
      actor: { userId: 'owner', actorId: 'owner', actorType: 'user', sessionId: 'session-owner' },
      path: `${root}/diagram.excalidraw`, content: JSON.stringify({ type: 'excalidraw', version: 2,
        elements: [{ id: 'actual-source-rectangle', type: 'rectangle', version: 1, versionNonce: 7,
          isDeleted: false, x: 10, y: 20, width: 50, height: 60 }], appState: { viewBackgroundColor: '#ffffff' }, files: {} }) });
    const originalSceneState = (await h.admin.query(`SELECT d.lineage_id,s.* FROM collaboration_documents d
      JOIN collaboration_excalidraw_states s ON s.document_id=d.id WHERE d.id=$1`, [originalScene.documentId])).rows[0]; assert(originalSceneState);
    const originalSceneSnapshot = (await readWorkspaceCopySourceObservationOnConnection(h.connection, h.source))
      .privateSceneSnapshots.find(value => value.header.id === originalScene.documentId) ?? assert.fail('The actual imported Scene snapshot is required.');
    assert.equal(originalSceneSnapshot.header.lineage_id, originalSceneState.lineage_id);
    await h.metadata(h.source, `${root}/note.md`, { title: 'Actual shared title', isFavorite: true, pinned: true });
    const rawPath = 'unselected-raw.md', rawFile = path.join(h.source.rootPath, rawPath);
    const rawBytes = Buffer.from(`---\naliases: [Raw Mixed]\n---\n# Raw original\n\n[Self](${rawPath}) äöü 😀\n`);
    await fs.writeFile(rawFile, rawBytes, { flag: 'wx', mode: 0o600 });
    const rawVersion = filesystemFileVersion(await fs.lstat(rawFile));
    // This unselected native source makes the raw alias part of the complete
    // graph without inventing support for uncopied cross-workspace targets.
    await h.upload('unselected-native-incoming.md', Buffer.from('[[Raw Mixed]]\n'));
    const sourceBefore = await mixedCopySourceSnapshot(), selections = [{ source_path: root, destination_path: destination }];
    phase = 'cross-workspace preview preserves the entire source and creates nothing';
    const preview = await mixedCopyNoWrites(() => mixedCopyCall({ action: 'preview', selections })); assert(preview.action === 'preview');
    assert.equal(preview.preview.coverage.complete, true); assert.equal(preview.preview.pathMappings.filter(row => row.sourceKind === 'file').length, 3);
    assert.deepEqual(await mixedCopySourceSnapshot(), sourceBefore); groups++;
    phase = 'READ-only source cross-workspace native copy and actual clone rebinding';
    const operationId = crypto.randomUUID(), command = { selections, operation_id: operationId, plan_id: preview.preview.planId };
    const applied = await mixedCopyCall({ action: 'apply', ...command }); assert(applied.action === 'apply');
    assert.equal(applied.execution.status, 'complete'); assert.equal(applied.alreadyKnown, false); assert.deepEqual(applied.copied, [destination]);
    const originalReceipt = await mixedCopyAssertClones(operationId, destination, h.destination.workspaceId);
    assert.equal(originalReceipt.actor_user_id, 'member'); assert.equal(originalReceipt.actor_session_id, 'session-member');
    assert.deepEqual(await mixedCopySourceSnapshot(), sourceBefore); assert.deepEqual(await fs.readFile(rawFile), rawBytes);
    assert.equal(filesystemFileVersion(await fs.lstat(rawFile)), rawVersion);
    assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, rawPath])).rows[0].n, 0); groups++;
    phase = 'historical status and explicit completed recovery do not replay';
    await mixedCopyNoWrites(async () => {
      const status = await mixedCopyCall({ action: 'status', operation_id: operationId }); assert(status.action === 'status');
      assert.equal(status.operation.completion.status, 'confirmed');
      const historical = await mixedCopyCall({ action: 'recover', ...command }); assert(historical.action === 'recover');
      assert.equal(historical.alreadyKnown, true); assert.equal(historical.execution.status, 'complete');
    });
    assert.deepEqual(await mixedCopyNativeReceipt(operationId), originalReceipt); assert.deepEqual(await mixedCopySourceSnapshot(), sourceBefore); groups++;
    phase = 'same-workspace full graph retains raw alias and self edge';
    const sameDestination = `same-${crypto.randomUUID()}`, sameSelections = [{ source_path: root, destination_path: sameDestination }];
    const samePreview = await mixedCopyNoWrites(() => mixedCopyCall({ action: 'preview', selections: sameSelections }, ownerToken, true)); assert(samePreview.action === 'preview');
    assert.equal(samePreview.preview.coverage.complete, true);
    const sameOperation = crypto.randomUUID();
    const same = await mixedCopyCall({ action: 'apply', selections: sameSelections, operation_id: sameOperation, plan_id: samePreview.preview.planId }, ownerToken, true);
    assert(same.action === 'apply'); assert.equal(same.execution.status, 'complete'); await mixedCopyAssertClones(sameOperation, sameDestination, h.source.workspaceId);
    assert.deepEqual(await fs.readFile(rawFile), rawBytes); assert.equal(filesystemFileVersion(await fs.lstat(rawFile)), rawVersion);
    assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, rawPath])).rows[0].n, 0); groups++;
    phase = 'a changed unselected physical resolution cannot be ignored';
    const resolutionFile = path.join(h.source.rootPath, 'unselected-resolution.md');
    await fs.writeFile(resolutionFile, '[Unresolved before Copy](copy-would-resolve.md)\n', { flag: 'wx', mode: 0o600 });
    await mixedCopyNoWrites(() => assert.rejects(mixedCopyCall({ action: 'preview', selections: [
      { source_path: `${root}/target.md`, destination_path: 'copy-would-resolve.md' }] }, ownerToken, true),
    error => mixedCopyCode(error) === 'MANAGED_COPY_PLAN_UNSUPPORTED'));
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, 'copy-would-resolve.md')), { code: 'ENOENT' });
    await fs.unlink(resolutionFile); groups++;
    phase = 'selected raw copy cannot make an unselected native alias ambiguous';
    await mixedCopyNoWrites(() => assert.rejects(mixedCopyCall({ action: 'preview', selections: [
      { source_path: rawPath, destination_path: 'selected-raw-copy.md' }] }, ownerToken, true),
    error => mixedCopyCode(error) === 'MANAGED_COPY_PLAN_UNSUPPORTED'));
    assert.deepEqual(await fs.readFile(rawFile), rawBytes); groups++;
    phase = 'stale raw source evidence rejects before Copy stage or domain writes';
    const ackDestination = `ack-${crypto.randomUUID()}`, ackSelections = [{ source_path: root, destination_path: ackDestination }];
    const stale = await mixedCopyCall({ action: 'preview', selections: ackSelections }); assert(stale.action === 'preview');
    await fs.appendFile(rawFile, '\nChanged after preview.\n');
    await mixedCopyNoWrites(() => assert.rejects(mixedCopyCall({ action: 'apply', selections: ackSelections,
      operation_id: crypto.randomUUID(), plan_id: stale.preview.planId }), error => mixedCopyCode(error) === 'NATIVE_COPY_PLAN_CHANGED'));
    await assert.rejects(fs.lstat(path.join(h.destination.rootPath, ackDestination)), { code: 'ENOENT' }); groups++;
    phase = 'real same-B C3 COMMIT acknowledgement loss with independent visibility';
    const ackPreview = await mixedCopyCall({ action: 'preview', selections: ackSelections }); assert(ackPreview.action === 'preview');
    const ackId = crypto.randomUUID(), ackCommand = { selections: ackSelections, operation_id: ackId, plan_id: ackPreview.preview.planId };
    let proof: { client: MetadataSqlEvent['client']; pid: number; xid: string; receipt: unknown; fingerprint: string; sceneIntent: unknown } | undefined, lost = false;
    const beforeAckSource = await mixedCopySourceSnapshot();
    const interrupted = await h.withProbe(async event => {
      if (/^\s*INSERT\s+INTO\s+collaboration_native_copy_receipts\b/iu.test(event.text) && event.values[1] === ackId) {
        assert(!proof); assert.equal(event.result.rowCount, 1);
        const actual = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        assert.equal(typeof actual.xid, 'string'); proof = { client: event.client, pid: Number(actual.pid), xid: actual.xid,
          receipt: JSON.parse(String(event.values[8])), fingerprint: String(event.values[6]), sceneIntent: undefined };
      }
      if (proof && event.client === proof.client && /^COMMIT\s*;?$/iu.test(event.text.trim()) && !lost) {
        const actual = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        assert.equal(Number(actual.pid), proof.pid); assert.equal(actual.xid, null);
        const durable = await mixedCopyNativeReceipt(ackId);
        assert.equal(durable.xmin, String(BigInt(proof.xid) % (BigInt(1) << BigInt(32))));
        assert.equal(durable.request_fingerprint, proof.fingerprint); assert.deepEqual(durable.private_result, proof.receipt);
        const scene = (await h.admin.query('SELECT intent_json,birth_json,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [ackId])).rows;
        assert.equal(scene.length, 1); assert.equal(scene[0].birth_json, null); assert.equal(scene[0].xmin, durable.xmin);
        const sceneIntent = captureExcalidrawCopyIntent(scene[0].intent_json);
        assert.equal(sceneIntent.b1TransactionId, proof.xid); assert.equal(sceneIntent.documents.length, 1);
        assert.equal(sceneIntent.documents[0].sourceContentProof, originalSceneSnapshot.contentProof); proof.sceneIntent = sceneIntent;
        assert.equal(durable.publication_status, 'native_committed'); lost = true;
        throw Object.assign(new Error('Actual mixed Copy C3 COMMIT ACK lost after independent receipt visibility.'), { code: 'M1_COPY_ACK_LOST' });
      }
    }, () => mixedCopyCall({ action: 'apply', ...ackCommand }));
    assert(proof && lost); assert(interrupted.action === 'apply'); assert.equal(interrupted.execution.status, 'needs_recovery');
    assert.equal(interrupted.execution.errorCode, 'COPY_OUTCOME_UNCONFIRMED'); assert.deepEqual(interrupted.copied, []);
    const staging = new WorkspaceOperationStaging(), retained = await staging.loadOwnedCopyByOperationId(ackId); assert(retained);
    assert.equal(retained.version, 5); assert.equal(retained.plan.version, 4); assert.equal(retained.plan.sourceEvidence.evidenceVersion, 4);
    assert(retained.version === 5);
    // A valid new-format preparation through the historical API must reject
    // before publishing any recovery directory or binary sidecar.
    const { prepareManagedCopyStage } = await import('../app/lib/files/workspace-operation-managed-copy-stage');
    const wrongFormatInput = { operationId: crypto.randomUUID(), request: retained.request, plan: retained.plan,
      physical: retained.physical, nativeRecords: retained.nativeRecords, sceneRecords: retained.sceneRecords,
      sceneAssets: retained.sceneAssets, metadata: retained.metadata };
    assert.equal(prepareManagedCopyStage(wrongFormatInput).manifest.version, 5);
    const wrongFormatDomain = await mixedCopyDomainSnapshot(), wrongFormatFiles = await mixedCopyFilesystem(h.dataRoot);
    await assert.rejects(staging.stageManagedCopy(wrongFormatInput as unknown as Parameters<typeof staging.stageManagedCopy>[0]),
      error => mixedCopyCode(error) === 'STAGE_CONFLICT');
    assert.deepEqual(await mixedCopyDomainSnapshot(), wrongFormatDomain);
    assert.deepEqual(await mixedCopyFilesystem(h.dataRoot), wrongFormatFiles);
    const retainedHash = retained.payloadSha256, born = await mixedCopyNativeReceipt(ackId);
    assert.deepEqual(await mixedCopySourceSnapshot(), beforeAckSource); groups++;
    phase = 'fresh same-client session recovers original A C3 receipt and clone IDs';
    const sessionB = `mixed-copy-session-${crypto.randomUUID()}`, timestamp = Date.now();
    const sessionA = (await h.admin.query('SELECT expires_at FROM "session" WHERE id=$1', ['session-member'])).rows[0]; assert(sessionA);
    await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
      [sessionB, crypto.randomBytes(32).toString('hex'), 'member', timestamp + 3600000, timestamp]);
    try {
      await h.admin.query('UPDATE "session" SET expires_at=$2 WHERE id=$1', ['session-member', timestamp - 1]);
      await mixedCopyNoWrites(() => assert.rejects(mixedCopyCall({ action: 'status', operation_id: ackId }),
        error => error instanceof DirectMcpAuthorizationError && error.status === 401));
      const tokenB = await mixedCopyIssueToken('member', sessionB);
      const recovered = await mixedCopyCall({ action: 'recover', ...ackCommand }, tokenB); assert(recovered.action === 'recover');
      assert.equal(recovered.execution.status, 'complete'); assert.equal(recovered.alreadyKnown, true);
      const published = await mixedCopyAssertClones(ackId, ackDestination, h.destination.workspaceId);
      assert.deepEqual(published.private_result, born.private_result); assert.equal(published.request_fingerprint, born.request_fingerprint);
      assert.deepEqual(captureExcalidrawCopyIntent((await h.admin.query('SELECT intent_json FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [ackId])).rows[0].intent_json), proof.sceneIntent);
      assert.equal(published.actor_session_id, 'session-member'); assert.notEqual(published.actor_session_id, sessionB);
      assert.equal(published.private_result.requestFingerprint, (proof.receipt as NativeCopyReceipt).requestFingerprint);
      assert.equal(await staging.loadOwnedCopyByOperationId(ackId), null); assert.match(retainedHash, /^[a-f0-9]{64}$/u);
      assert.deepEqual(await mixedCopySourceSnapshot(), beforeAckSource); groups++;
      phase = 'fresh B completed status and retry preserve receipt and whole domain';
      await mixedCopyNoWrites(async () => {
        const status = await mixedCopyCall({ action: 'status', operation_id: ackId }, tokenB); assert(status.action === 'status');
        assert.equal(status.operation.completion.status, 'confirmed');
        const retry = await mixedCopyCall({ action: 'apply', ...ackCommand }, tokenB); assert(retry.action === 'apply');
        assert.equal(retry.alreadyKnown, true); assert.equal(retry.execution.status, 'complete');
        const history = await mixedCopyCall({ action: 'recover', ...ackCommand }, tokenB); assert(history.action === 'recover');
        assert.equal(history.alreadyKnown, true); assert.equal(history.execution.status, 'complete');
      });
      assert.deepEqual(await mixedCopyNativeReceipt(ackId), published); assert.deepEqual(await mixedCopySourceSnapshot(), beforeAckSource); groups++;
    } finally {
      await h.admin.query('UPDATE "session" SET expires_at=$2 WHERE id=$1', ['session-member', sessionA.expires_at]);
      await h.admin.query('DELETE FROM "session" WHERE id=$1 AND user_id=$2', [sessionB, 'member']);
    }
    assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [h.source.workspaceId, rawPath])).rows[0].n, 0);
    assert.equal(groups, 10);
    console.log(JSON.stringify({ fixture: 'm1-actual-mixed-copy', groups, actualPublicMcpService: true,
      readOnlySourceUnchanged: true, originalPhysicalEvidence: true, cloneAndBlockIdRebinding: true,
      fullGraphResolutionGuard: true, staleSourceNoWrites: true, actualC3CommitAckLossRecovered: true }));
  }); complete = true; }
  finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
}

workspaceOperationMixedCopyPostgresTest().catch(error => {
  console.error(JSON.stringify({ fixture: 'm1-actual-mixed-copy', phase, groups,
    name: error instanceof Error ? error.name : typeof error, code: mixedCopyCode(error),
    source: error instanceof Error ? error.stack?.split('\n').filter(line => /(?:app|scripts)\//u.test(line)).slice(0, 4) : [] }));
  process.exitCode = 1;
});
