import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { JSONContent } from '@tiptap/core';
import type { NativeCopyReceipt } from '../app/lib/collaboration/native-copy-persistence';
import type { AgentPathOperationResult } from '../app/lib/pi/agent-file-operations';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual stored PI session -> real invocation -> copyAgentPaths -> central
// Copy service/owner. No actor DTO, fs.cp stub, owner call or result substitute.
let phase = 'fixture', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const piRenameCode = (error: unknown): string | null => error instanceof Error
  && typeof Object.getOwnPropertyDescriptor(error, 'code')?.value === 'string'
  ? Object.getOwnPropertyDescriptor(error, 'code')!.value : null;

export async function piCopyRenamePostgresTest(): Promise<void> {
  const originalBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { copyAgentPaths } = await import('../app/lib/pi/agent-file-operations');
    const { formatPathOperationResult } = await import('../app/lib/pi/tool-file-formatters');
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
    const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
    const { readPiRuntimeConfig } = await import('../app/lib/agents/storage');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    const { authenticatedNativeTextSessionEnabled } = await import('../app/lib/collaboration/native-text-session-activation');
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
    assert.equal(authenticatedNativeTextSessionEnabled(), true);
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection,
      resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' }), h.source.workspaceId); assert(sourceOwner);
    assert(sourceOwner.permissions.canWrite); assert(h.source.permissions.canRead && !h.source.permissions.canWrite);
    const agentId = `pi-copy-${crypto.randomUUID()}`;
    await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'System','main','legacy','organization','principal-org','["copy_path"]',100,100),
      ($2,'PI Copy fixture','special','restricted','organization','principal-org','["copy_path"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [MAIN_AGENT_ID, agentId]);
    await h.admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES($1,'principal-org','owner','active',0,100,100),($1,'principal-org','member','active',0,100,100)`, [agentId]);
    await h.admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
      VALUES($1,$2,'principal-org','workspace',$3,1,100,100)`, [crypto.randomUUID(), agentId, h.source.workspaceId]);
    const sessions = new Map<'owner' | 'member', string>();
    for (const userId of ['owner', 'member'] as const) {
      const sessionId = `pi-copy-${userId}-${crypto.randomUUID()}`; sessions.set(userId, sessionId);
      await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
        workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
        VALUES($1,$2,$3,'fixture','fixture','principal-org',$4,'team','PI Copy source',$5,100,100)`,
      [sessionId, userId, agentId, h.source.workspaceId, h.source.rootRelativePath]);
    }
    const piRenameInvoke = async <T>(userId: 'owner' | 'member', operation: () => Promise<T>, noWrites = false): Promise<T> => {
      const actual = await resolveAgentExecutionContextForStoredSession({ sessionId: sessions.get(userId)!, userId, agentId,
        permissions: ['canRead', 'canRunAgent'] });
      assert.equal(actual.workspaceId, h.source.workspaceId); assert.equal(actual.agentId, agentId);
      assert.equal(actual.canWrite, userId === 'owner'); assert.equal(actual.legacy, false);
      const invoke = () => runWithAgentExecutionContext(actual, () => withAgentToolInvocation(actual,
        { toolName: 'copy_path', toolCallId: `pi-copy-rename-${crypto.randomUUID()}` }, operation));
      // Session resolution prepares runtime/skill directories. Bind the
      // unchanged-DATA oracle after that real setup and around the entire
      // genuine invocation, including its error propagation and finalization.
      return noWrites ? piRenameNoWrites(invoke) : invoke();
    };
    // Prepare the normal config/skill readers before the unchanged-domain
    // oracles. These are genuine existing readers, never policy replacements.
    await readPiRuntimeConfig();
    await piRenameInvoke('owner', async () => undefined); await piRenameInvoke('member', async () => undefined);

    const piRenameFilesystem = async (root: string) => {
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
    const piRenameDomain = async () => {
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
    const piRenameNoWrites = async <T>(operation: () => Promise<T>): Promise<T> => {
      const before = await piRenameDomain(), files = await piRenameFilesystem(h.dataRoot); let statements = 0, writes = 0;
      try { return await h.withProbe(async event => {
        assert(++statements <= 5000);
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
      }, operation); }
      finally { assert(statements > 0); assert.equal(writes, 0);
        assert.deepEqual(await piRenameDomain(), before); assert.deepEqual(await piRenameFilesystem(h.dataRoot), files); }
    };
    const root = `pi-source-${crypto.randomUUID()}`, originalPath = `${root}/original.md`, targetPath = `${root}/target.md`;
    const absentPath = `${root}/projection-absent.md`, rawPath = 'unselected-raw.md', incomingPath = 'unselected-native-incoming.md';
    const original = await h.upload(originalPath, Buffer.from(`# Native original\n\n[Self](original.md) [Target](target.md)\n\n**Preserved text** 😀\n`));
    const target = await h.upload(targetPath, Buffer.from('# Native target\n\nUnchanged original target.\n'));
    const absent = await h.upload(absentPath, Buffer.from('# Projection absent\n\n[Self](projection-absent.md) [Target](target.md)\n'));
    await fs.unlink(path.join(h.source.rootPath, absentPath));
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, absentPath)), { code: 'ENOENT' });
    const scenePath = `${root}/diagram.excalidraw`;
    const scene = await importExcalidrawDocumentFile({ workspace: sourceOwner,
      actor: { userId: 'owner', actorId: 'owner', actorType: 'user', sessionId: 'session-owner' }, path: scenePath,
      content: JSON.stringify({ type: 'excalidraw', version: 2,
        elements: [{ id: 'actual-source-rectangle', type: 'rectangle', version: 1, versionNonce: 7,
          isDeleted: false, x: 10, y: 20, width: 50, height: 60 }], appState: { viewBackgroundColor: '#ffffff' }, files: {} }) });
    const originalScene = (await h.admin.query(`SELECT d.lineage_id,s.* FROM collaboration_documents d
      JOIN collaboration_excalidraw_states s ON s.document_id=d.id WHERE d.id=$1`, [scene.documentId])).rows[0]; assert(originalScene);
    const rawBytes = Buffer.from(`---\naliases: [Raw PI Alias]\n---\n# Raw original\n\n[Self](${rawPath}) äöü 😀\n`);
    await fs.writeFile(path.join(h.source.rootPath, rawPath), rawBytes, { flag: 'wx', mode: 0o600 });
    const incoming = await h.upload(incomingPath, Buffer.from('[[Raw PI Alias]]\n'));
    const sourceIds = [original.documentId, target.documentId, absent.documentId, incoming.documentId, scene.documentId];
    const sourcePaths = [originalPath, targetPath, absentPath, incomingPath, rawPath, scenePath];
    const cloneIds = new Set<string>();
    const piRenameSourceSnapshot = async () => {
      const rows = (await h.admin.query(`
        SELECT 'native' AS kind,document_id AS id,to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[])
        UNION ALL SELECT 'scene',document_id,to_jsonb(s)::text,xmin::text FROM collaboration_excalidraw_states s WHERE document_id=ANY($1::text[])
        UNION ALL SELECT 'registry',id,to_jsonb(d)::text,xmin::text FROM collaboration_documents d WHERE id=ANY($1::text[])
        UNION ALL SELECT 'lineage',id,to_jsonb(l)::text,xmin::text FROM file_collaboration_lineages l WHERE id IN (SELECT lineage_id FROM collaboration_documents WHERE id=ANY($1::text[]))
        UNION ALL SELECT 'projection',document_id,to_jsonb(p)::text,xmin::text FROM collaboration_file_projections p WHERE document_id=ANY($1::text[])
        UNION ALL SELECT 'metadata',path,to_jsonb(m)::text,xmin::text FROM workspace_file_metadata m WHERE workspace_id=$2 AND path=ANY($3::text[])
        UNION ALL SELECT 'user-state',path,to_jsonb(u)::text,xmin::text FROM workspace_file_user_states u WHERE workspace_id=$2 AND path=ANY($3::text[])
        UNION ALL SELECT 'revision',path,to_jsonb(r)::text,xmin::text FROM file_revisions r WHERE workspace_id=$2 AND path=ANY($3::text[])
        UNION ALL SELECT 'scene-asset',file_id,to_jsonb(a)::text,xmin::text FROM collaboration_excalidraw_assets a WHERE workspace_id=$2
        ORDER BY kind,id,body,xmin`, [sourceIds, h.source.workspaceId, sourcePaths])).rows;
      const catalogue = (await h.admin.query(`SELECT id,to_jsonb(d)::text AS body,d.xmin::text AS xmin FROM collaboration_documents d
        WHERE workspace_id=$1 ORDER BY id`, [h.source.workspaceId])).rows;
      assert.equal(catalogue.filter(row => cloneIds.has(row.id)).length, cloneIds.size);
      const files: unknown[] = [];
      for (const filePath of sourcePaths) {
        const file = path.join(h.source.rootPath, filePath);
        if (filePath === absentPath) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); files.push({ path: filePath, absent: true }); continue; }
        const info = await fs.lstat(file, { bigint: true }); assert(info.isFile() && !info.isSymbolicLink());
        files.push({ path: filePath, version: filesystemFileVersion(await fs.lstat(file)), dev: String(info.dev), ino: String(info.ino),
          size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), bytes: await fs.readFile(file) });
      }
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [h.source.workspaceId, rawPath])).rows[0].n, 0);
      return { rows, catalogue: catalogue.filter(row => !cloneIds.has(row.id)), files };
    };
    const piRenameNormalize = (input: JSONContent, reverse: Map<string, string>, used: Set<string>): JSONContent => {
      const node = structuredClone(input);
      if (node.attrs?.id) { const id = String(node.attrs.id), originalId = reverse.get(id); assert(originalId);
        assert(!used.has(id)); used.add(id); node.attrs.id = originalId; }
      for (const mark of node.marks ?? []) if (mark.type === 'link' && mark.attrs) mark.attrs.href = '[separately-checked-target]';
      if (node.content) node.content = node.content.map(child => piRenameNormalize(child, reverse, used)); return node;
    };
    const piRenameAssertNative = async (result: AgentPathOperationResult, sourceId: string, destinationPath: string) => {
      assert.equal(result.operation, 'copy_path'); assert.equal(result.destinationPath, destinationPath);
      assert.equal(result.review, undefined); assert.equal(result.changed, true); assert.equal(result.verified, true);
      assert.equal(result.linkStatus, 'complete'); assert.equal(result.entries.length, 1); assert.equal(result.entries[0].changed, true);
      assert.equal(result.bytes, null); assert.equal(result.entries[0].bytes, null);
      assert.equal(Object.hasOwn(result, 'plan'), false);
      const formatted = formatPathOperationResult(result);
      assert.match(formatted, /^Bytes: not available \(native document storage\)$/mu);
      assert.doesNotMatch(formatted, /^Bytes: (?:0|null)$/mu);
      assert(result.operationIds && result.operationIds.length === 1); const operationId = result.operationIds[0];
      const rows = (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows;
      assert.equal(rows.length, 1); const ledger = rows[0] as { actor_user_id: string; actor_session_id: string;
        publication_status: string; private_result: Omit<NativeCopyReceipt, 'publicationStatus'> };
      assert.equal(ledger.actor_user_id, 'owner'); assert.equal(ledger.actor_session_id, sessions.get('owner'));
      assert.equal(ledger.publication_status, 'published'); assert.equal(ledger.private_result.documents.length, 1);
      const receipt = ledger.private_result.documents[0]; assert.equal(receipt.source.documentId, sourceId);
      assert.equal(receipt.clone.path, destinationPath); assert.notEqual(receipt.clone.documentId, sourceId);
      const before = await load(h.connection, sourceId), after = await load(h.connection, receipt.clone.documentId); assert(before && after);
      assert.equal(after.path, destinationPath); assert.equal(after.workspaceId, h.source.workspaceId); assert.equal(after.lifecycleGeneration, 1);
      const registry = (await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE id=ANY($1::text[])',
        [[sourceId, receipt.clone.documentId]])).rows; assert.equal(registry.length, 2);
      assert.equal(registry.find(row => row.id === after.documentId)!.lineage_id, receipt.clone.lineageId);
      assert.notEqual(registry.find(row => row.id === sourceId)!.lineage_id, receipt.clone.lineageId);
      const oldClients = Y.decodeStateVector(before.stateVector), newClients = Y.decodeStateVector(after.stateVector);
      assert(oldClients.size > 0 && newClients.size > 0); assert([...newClients.keys()].every(client => !oldClients.has(client)));
      const oldLinks = inspect(before), newLinks = inspect(after); assert(oldLinks.coverage.complete && newLinks.coverage.complete);
      assert.equal(oldLinks.links.length, 2); assert.equal(newLinks.links.length, 2);
      for (const oldLink of oldLinks.links) {
        const oldLocation = oldLink.cloneLocator;
        const ownerBlockId = oldLocation.ownerBlockId === null ? null : receipt.blockIdMapping[oldLocation.ownerBlockId];
        const nodeId = oldLocation.nodeId === null ? null : receipt.blockIdMapping[oldLocation.nodeId];
        assert(ownerBlockId !== undefined && nodeId !== undefined);
        const corresponding = newLinks.links.filter(link => link.cloneLocator.ownerBlockId === ownerBlockId
          && link.cloneLocator.nodeId === nodeId && link.cloneLocator.ordinal === oldLocation.ordinal);
        assert.equal(corresponding.length, 1); const fresh = corresponding[0];
        assert.equal(fresh.kind, oldLink.kind); assert.equal(fresh.syntax, oldLink.syntax); assert.equal(fresh.fragment, oldLink.fragment);
        assert.equal(fresh.alias, oldLink.alias); assert.equal(fresh.embed, oldLink.embed);
        const oldTarget: string = oldLink.targetPathText.startsWith('/') ? oldLink.targetPathText.slice(1)
          : path.posix.normalize(path.posix.join(path.posix.dirname(before.path), oldLink.targetPathText));
        assert([before.path, targetPath].includes(oldTarget));
        const freshTarget: string = fresh.targetPathText.startsWith('/') ? fresh.targetPathText.slice(1)
          : path.posix.normalize(path.posix.join(path.posix.dirname(after.path), fresh.targetPathText));
        assert.equal(freshTarget, oldTarget === before.path ? destinationPath : targetPath);
      }
      const resolved = newLinks.links.map(link => link.targetPathText.startsWith('/') ? link.targetPathText.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(after.path), link.targetPathText))).sort();
      assert.deepEqual(resolved, [destinationPath, targetPath].sort());
      const targetRows = (await h.admin.query('SELECT id,path FROM collaboration_documents WHERE workspace_id=$1 AND path=ANY($2::text[])',
        [h.source.workspaceId, resolved])).rows; assert.equal(targetRows.length, 2);
      assert.equal(targetRows.find(row => row.path === destinationPath)!.id, after.documentId);
      assert.equal(targetRows.find(row => row.path === targetPath)!.id, target.documentId);
      const oldContent = snapshot(before).content, newContent = snapshot(after).content;
      assert(oldContent.kind === 'rich_text' && newContent.kind === 'rich_text');
      assert.equal(newContent.frontmatter, oldContent.frontmatter); assert.equal(newContent.bodyFinalLineEnding, oldContent.bodyFinalLineEnding);
      const entries = Object.entries(receipt.blockIdMapping); assert(entries.length > 0); assert(entries.every(([old, fresh]) => old !== fresh));
      assert.equal(new Set(entries.map(([, fresh]) => fresh)).size, entries.length);
      const reverse = new Map(entries.map(([old, fresh]) => [fresh, old])), identity = new Map(entries.map(([old]) => [old, old]));
      const usedNew = new Set<string>(), usedOld = new Set<string>();
      assert.deepEqual(piRenameNormalize(newContent.document, reverse, usedNew), piRenameNormalize(oldContent.document, identity, usedOld));
      assert.equal(usedNew.size, reverse.size); assert.equal(usedOld.size, identity.size);
      const mutations = (await h.admin.query(`SELECT DISTINCT actor_id,actor_type,actor_session_id FROM collaboration_native_link_mutation_receipts
        WHERE document_id=$1`, [after.documentId])).rows;
      assert.deepEqual(mutations, [{ actor_id: agentId, actor_type: 'agent', actor_session_id: sessions.get('owner') }]);
      // Completed managed copies retire their temporary stage; the durable
      // journal and completion receipt retain the original request binding.
      assert.equal(await new WorkspaceOperationStaging().loadOwnedCopyByOperationId(operationId), null);
      const operation = (await h.admin.query('SELECT status,request_json FROM workspace_file_operations WHERE operation_id=$1', [operationId])).rows;
      assert.equal(operation.length, 1); assert.equal(operation[0].status, 'completed');
      const request = JSON.parse(operation[0].request_json);
      assert.equal(request.origin.version, 1); assert.deepEqual(request.origin.actor,
        { type: 'agent', userId: 'owner', actorId: agentId, sessionId: sessions.get('owner') });
      assert.deepEqual(request.selections, [{ sourcePath: before.path, destinationPath }]);
      const completion = (await h.admin.query(`SELECT status,receipt_json FROM workspace_file_operation_steps
        WHERE operation_id=$1 AND step_key='copy-completion'`, [operationId])).rows;
      assert.equal(completion.length, 1); assert.equal(completion[0].status, 'applied');
      const completed = JSON.parse(completion[0].receipt_json);
      assert.equal(completed.version, 4); assert.equal(completed.kind, 'native-copy-completion');
      cloneIds.add(after.documentId); return operationId;
    };
    const originalSource = await piRenameSourceSnapshot();
    phase = 'actual PI renamed native copy rebinds clone identity, self and original target links';
    const renamedPath = `${root}/renamed.md`;
    await piRenameAssertNative(await piRenameInvoke('owner', () => copyAgentPaths({ sourcePaths: [originalPath], destinationPath: renamedPath,
      recursive: false, idempotencyKey: crypto.randomUUID() })), original.documentId, renamedPath);
    assert.deepEqual(await piRenameSourceSnapshot(), originalSource); groups++;

    phase = 'PI copy reads genuine native source with no physical Markdown projection';
    const absentDestination = `${root}/renamed-projection-absent.md`;
    await piRenameAssertNative(await piRenameInvoke('owner', () => copyAgentPaths({ sourcePaths: [absentPath], destinationPath: absentDestination,
      recursive: false, idempotencyKey: crypto.randomUUID() })), absent.documentId, absentDestination);
    assert.deepEqual(await piRenameSourceSnapshot(), originalSource); groups++;

    phase = 'actual PI Scene rename uses genuine scene birth instead of raw copy';
    const renamedScene = `${root}/renamed-diagram.excalidraw`;
    const sceneResult = await piRenameInvoke('owner', () => copyAgentPaths({ sourcePaths: [scenePath], destinationPath: renamedScene,
      recursive: false, idempotencyKey: crypto.randomUUID() }));
    assert.equal(sceneResult.operation, 'copy_path'); assert.equal(sceneResult.changed, true); assert.equal(sceneResult.verified, true);
    assert.equal(sceneResult.bytes, null); assert.equal(sceneResult.entries[0].bytes, null);
    assert.equal(Object.hasOwn(sceneResult, 'plan'), false);
    assert.match(formatPathOperationResult(sceneResult), /^Bytes: not available \(native document storage\)$/mu);
    assert.equal(sceneResult.linkStatus, 'complete'); assert(sceneResult.operationIds?.length === 1);
    const sceneOperationId = sceneResult.operationIds[0];
    const sceneLedgers = (await h.admin.query('SELECT intent_json,birth_json FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [sceneOperationId])).rows;
    assert.equal(sceneLedgers.length, 1); assert(sceneLedgers[0].birth_json);
    const sceneIntent = captureExcalidrawCopyIntent(sceneLedgers[0].intent_json), sceneBirth = captureExcalidrawCopyBirthReceipt(sceneLedgers[0].birth_json);
    assert.deepEqual(sceneBirth.intent, sceneIntent); assert.equal(sceneIntent.documents.length, 1); assert.equal(sceneBirth.documents.length, 1);
    assert.deepEqual(sceneIntent.origin.actor, { type: 'agent', userId: 'owner', actorId: agentId, sessionId: sessions.get('owner') });
    const sceneTarget = sceneIntent.documents[0]; assert.equal(sceneTarget.sourceDocumentId, scene.documentId);
    assert.equal(sceneTarget.sourceLineageId, originalScene.lineage_id); assert.equal(sceneTarget.destinationPath, renamedScene);
    assert.notEqual(sceneTarget.documentId, scene.documentId); assert.notEqual(sceneTarget.lineageId, originalScene.lineage_id);
    assert.equal(sceneBirth.documents[0].documentId, sceneTarget.documentId); assert.equal(sceneBirth.documents[0].lineageId, sceneTarget.lineageId);
    const newScene = (await h.admin.query(`SELECT d.lineage_id,s.* FROM collaboration_documents d JOIN collaboration_excalidraw_states s
      ON s.document_id=d.id WHERE d.id=$1`, [sceneTarget.documentId])).rows[0]; assert(newScene);
    assert.equal(newScene.lineage_id, sceneTarget.lineageId); assert.equal(newScene.path, renamedScene); assert.equal(newScene.workspace_id, h.source.workspaceId);
    assert.equal(newScene.canonical_hash, originalScene.canonical_hash); assert.deepEqual(newScene.elements_json, originalScene.elements_json);
    assert.deepEqual(newScene.shared_app_state_json, originalScene.shared_app_state_json); assert.deepEqual(newScene.assets_json, []);
    const portable = JSON.parse(await fs.readFile(path.join(h.source.rootPath, renamedScene), 'utf8'));
    assert.equal(portable.type, 'excalidraw'); assert.deepEqual(portable.elements, originalScene.elements_json); assert.equal(Object.keys(portable.files).length, 0);
    cloneIds.add(sceneTarget.documentId); assert.deepEqual(await piRenameSourceSnapshot(), originalSource); groups++;

    phase = 'selected raw Markdown rename requires import and cannot fall back to fs.cp';
    const rawDestination = `${root}/renamed-raw.md`;
    await assert.rejects(piRenameInvoke('owner', () => copyAgentPaths({ sourcePaths: [rawPath], destinationPath: rawDestination,
      recursive: false, idempotencyKey: crypto.randomUUID() }), true), error => piRenameCode(error) === 'MANAGED_COPY_PLAN_IMPORT_REQUIRED');
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, rawDestination)), { code: 'ENOENT' });
    assert.deepEqual(await piRenameSourceSnapshot(), originalSource); groups++;

    phase = 'actual read-only PI member is denied before any fallback or publication';
    const deniedDestination = `${root}/denied-native-rename.md`;
    await assert.rejects(piRenameInvoke('member', () => copyAgentPaths({ sourcePaths: [originalPath], destinationPath: deniedDestination,
      recursive: false, idempotencyKey: crypto.randomUUID() }), true), { message: 'Agent file writes are disabled for the active workspace.' });
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, deniedDestination)), { code: 'ENOENT' });
    assert.deepEqual(await piRenameSourceSnapshot(), originalSource); groups++;

    phase = 'workspace overwrite flag cannot escape the native owner through the raw fallback';
    await piRenameInvoke('owner', async () => {
      for (const sourcePath of [originalPath, rawPath]) {
        for (const destinationPath of [`${root}/unused-overwrite.md`, targetPath]) {
          await assert.rejects(copyAgentPaths({ sourcePaths: [sourcePath], destinationPath,
            overwrite: true, recursive: false, idempotencyKey: crypto.randomUUID() }),
          error => piRenameCode(error) === 'NATIVE_COPY_OVERWRITE_UNSUPPORTED'
            && Object.getOwnPropertyDescriptor(error, 'status')?.value === 409);
        }
      }
    }, true);
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, `${root}/unused-overwrite.md`)), { code: 'ENOENT' });
    assert.deepEqual(await piRenameSourceSnapshot(), originalSource); groups++;
    assert.equal(groups, 6);
    console.log(JSON.stringify({ suite: 'pi-copy-rename', groups, actualPI: true, renamedNative: true,
      projectionAbsent: true, sceneBirth: true, originalSourcesUnchanged: true, rawImportRequired: true, readonlyDenied: true,
      overwriteDeniedWithoutWrites: true }));
  }); }
  finally { if (originalBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = originalBase; }
}

piCopyRenamePostgresTest().then(() => { complete = true; }).catch((error: unknown) => {
  console.error(JSON.stringify({ suite: 'pi-copy-rename', phase, groups,
    name: error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/gu, '').slice(0, 80) : 'Unknown', code: piRenameCode(error),
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 1500) : undefined }));
  complete = true; process.exitCode = 1;
});
