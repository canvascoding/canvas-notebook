import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { ApiKeyAction } from '../app/lib/api-keys/contracts';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let stage = 'setup', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
const sha = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'import_knowledge_file,read_knowledge_source' });
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { persistApiKeyOriginalMarkdownFileForWrite: apply, readApiKeyOriginalMarkdownImportStatusForWrite: status,
      persistExplicitOriginalMarkdownFileForWrite: sessionImport } =
      await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { decodeApiKeyOriginalMarkdownImportRecordV2: decode, serializeApiKeyOriginalMarkdownImportRecordV2: serialize,
      apiKeyOriginalMarkdownImportOperationId } =
      await import('../app/lib/collaboration/api-key-original-markdown-import-contract');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { loadCollaborationStateOnConnection: load, serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const headers = new Headers((await h.request(h.source, 'owner')).headers); headers.set('Origin', 'http://localhost');
    const actions: ApiKeyAction[] = ['read', 'import', 'status'];
    const issued = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Existing original key importer',
      workspaceIds: [h.source.workspaceId], actions, expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, credentialId = issued.credential.id, revision = 1;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/documents/import-existing',
      { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const sessionsBefore = (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text FROM session s ORDER BY id')).rows;
    const selection = async (filePath: string, representation: 'auto' | 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'plain_text') => ({
      apiVersion: 1 as const, workspaceId: h.source.workspaceId, path: filePath, operationId: `key_original_${randomUUID().replaceAll('-', '')}`,
      expectedFileVersion: filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, filePath))), initialRepresentation: representation });
    const createSource = async (filePath: string, bytes: Uint8Array, representation: 'auto' | 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'plain_text') => {
      await fs.writeFile(path.join(h.source.rootPath, filePath), bytes, { flag: 'wx', mode: 0o600 }); return selection(filePath, representation);
    };
    const run = (selected: Awaited<ReturnType<typeof selection>>, entryPoint: 'request' | 'mcp' = 'request') => apply(credential, selected, entryPoint);
    const inspect = (selected: Awaited<ReturnType<typeof selection>>, entryPoint: 'request' | 'mcp' = 'request') =>
      status(credential, { apiVersion: 1, workspaceId: selected.workspaceId, operationId: selected.operationId }, entryPoint);
    const rows = async (operationId: string) => {
      const result: Record<string, unknown> = {};
      for (const table of ['collaboration_original_markdown_import_api_keys', 'collaboration_markdown_file_import_receipts']) {
        result[table] = (await h.admin.query(`SELECT to_jsonb(t) AS row,t.xmin::text AS xmin FROM ${table} t WHERE workspace_id=$1 AND operation_id=$2`,
          [h.source.workspaceId, operationId])).rows;
      }
      return result;
    };
    const immutableReads = async (consume: () => Promise<void>) => h.withProbe(async event => {
      assert.doesNotMatch(event.text, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\s+(?:"?[^".\s]+"?\.)?"?(?:collaboration_|file_collaboration_|file_revisions)/iu);
      assert.doesNotMatch(event.text, /\b(?:FROM|JOIN)\s+(?:"?[^".\s]+"?\.)?"?(?:collaboration_documents|collaboration_yjs_states)\b/iu);
    }, consume);
    const update = async (next: ApiKeyAction[]) => updateApiIntegration(headers, issued.integration.id,
      { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [h.source.workspaceId], actions: next });
    const rotate = async () => {
      const next = await rotateApiKey(headers, issued.integration.id,
        { requestId: randomUUID(), expectedRevision: revision++, expiresAt: Date.now() + 3_600_000 });
      key = next.key; credentialId = next.credential.id; credential = await authenticate();
    };
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++;
      console.log(`API-key original import owner passed: ${name}`); };
    const bytes = Buffer.from('\ufeff# Existing original\r\n\r\nUnicode Ä Ω 😀.\r\n');
    const selected = await createSource('key-original-profile.md', bytes);
    let imported: Awaited<ReturnType<typeof run>>;
    await check('one genuine key/native commit retains original bytes, physical version and sessionless attribution', async () => {
      imported = await run(selected); assert.equal(imported.disposition, 'applied');
      const receipt = imported.receipt; assert.match(receipt.operationId, /^key-original-[a-f0-9]{64}$/u);
      assert.equal(receipt.sourceHash, sha(bytes)); assert.equal(receipt.sourceBytes, bytes.length);
      assert.equal(receipt.target.initialSequence, 0); assert.equal(receipt.target.newlineStyle, 'crlf'); assert.equal(receipt.target.hasBom, true);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, selected.path)), bytes);
      assert.equal(filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, selected.path))), selected.expectedFileVersion);
      const stored = await load(h.connection, receipt.target.documentId); assert(stored);
      const canonical = inspectPersistedNativeCollaborationSnapshot(stored, (_doc, snapshot) =>
        snapshot.content.kind === 'plain_text' ? snapshot.content.text : assert.fail('The selected original is plain text.'));
      assert.deepEqual(Buffer.from(serializeCanonicalText(canonical, stored)), bytes);
      const row = (await h.admin.query('SELECT * FROM collaboration_original_markdown_import_api_keys WHERE operation_id=$1', [receipt.operationId])).rows[0];
      const original = decode(row.original_text); assert.equal(original.callerOperationId, selected.operationId);
      assert.equal(original.origin.credentialId, issued.credential.id); assert.equal(original.origin.integrationId, issued.integration.id);
      assert.equal(original.origin.userId, 'owner'); assert.equal(original.origin.kind, 'api_key');
      assert(!Object.keys(original.origin).some(name => /session|token|secret/iu.test(name)));
      assert(!row.original_text.includes(key)); assert.equal(row.original_digest, sha(row.original_text));
      const native = (await h.admin.query('SELECT actor_user_id,actor_session_id,request_id,private_result FROM collaboration_markdown_file_import_receipts WHERE operation_id=$1', [receipt.operationId])).rows[0];
      assert.equal(native.actor_session_id, null); assert.equal(native.actor_user_id, 'owner'); assert.deepEqual(native.private_result, receipt);
      assert.equal(native.request_id, `key-original-import:${receipt.operationId}`);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_original_markdown_imports WHERE operation_id=$1', [receipt.operationId])).rows[0].n, 0);
    });
    await check('same-op retry, public status, actual rotation and MCP retain immutable native rows', async () => {
      const before = await rows(imported.receipt.operationId);
      await immutableReads(async () => { assert.deepEqual((await run(selected)).receipt, imported.receipt);
        assert.deepEqual(await inspect(selected), imported.receipt); });
      await rotate();
      await immutableReads(async () => { assert.equal((await run(selected, 'mcp')).disposition, 'already-applied');
        assert.deepEqual(await inspect(selected, 'mcp'), imported.receipt); });
      assert.deepEqual(await rows(imported.receipt.operationId), before);
    });
    await check('changed path, physical version, representation and forged credential cannot borrow a receipt', async () => {
      const before = await rows(imported.receipt.operationId);
      for (const changed of [{ ...selected, path: 'another.md' }, { ...selected, expectedFileVersion: selected.expectedFileVersion + '1' },
        { ...selected, initialRepresentation: 'tiptap_xml' as const }]) {
        await assert.rejects(run(changed), code('MARKDOWN_IMPORT_REQUEST_CONFLICT'));
      }
      await assert.rejects(apply(Object.freeze({}) as typeof credential, selected, 'request'));
      assert.deepEqual(await rows(imported.receipt.operationId), before);
    });
    await check('registered never-initialized identity and both rich representations use the shared original writer', async () => {
      const pristine = await createSource('key-original-pristine.markdown', Buffer.from('# Pristine\n\nRetain my identity.\n'), 'auto');
      const documentId = `collab-${randomUUID()}`;
      await h.admin.query(`INSERT INTO collaboration_documents(id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
        VALUES($1,$2,$3,$4,$5,'yjs','active',0,1,1,'never_initialized')`,
      [documentId, h.source.organizationId, h.source.workspaceId, h.source.workspaceType, pristine.path]);
      assert.equal((await run(pristine)).receipt.target.documentId, documentId);
      for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
        const next = await createSource(`key-original-${representation}.md`, Buffer.from('# Native rich\n\nA **bold** original.\n'), representation);
        const result = await run(next); assert.equal(result.receipt.target.representation, representation);
        assert.equal(filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, next.path))), next.expectedFileVersion);
      }
    });
    await check('historical status/retry do not inspect a missing path or invalid later physical replacement', async () => {
      // Adversarial physical projection tamper, not acceptance of a real Move.
      const file = path.join(h.source.rootPath, selected.path), retained = `${file}.fixture-original`;
      await fs.rename(file, retained);
      await immutableReads(async () => { assert.deepEqual(await inspect(selected), imported.receipt); assert.deepEqual((await run(selected)).receipt, imported.receipt); });
      const replacement = Buffer.from([255, 254, 0, 68, 50]); await fs.writeFile(file, replacement, { flag: 'wx' });
      await immutableReads(async () => { assert.deepEqual(await inspect(selected), imported.receipt); assert.deepEqual((await run(selected)).receipt, imported.receipt); });
      assert.deepEqual(await fs.readFile(file), replacement); assert.deepEqual(await fs.readFile(retained), bytes);
    });
    await check('Import-only can apply and retry but cannot use public Status or another integration', async () => {
      await update(['import']);
      const next = await createSource('key-original-import-only.md', Buffer.from('Import needs no borrowed Read or Create permission.\n'));
      const result = await run(next); assert.equal(result.disposition, 'applied'); assert.equal((await run(next)).disposition, 'already-applied');
      await assert.rejects(inspect(next), code('API_KEY_ACCESS_DENIED'));
      await update(actions);
      const other = await createApiIntegration(headers, { requestId: randomUUID(), name: 'Different importer',
        workspaceIds: [h.source.workspaceId], actions, expiresAt: Date.now() + 3_600_000 });
      const otherCredential = await authenticateApiKeyRequest(new Request('http://localhost', { headers: { 'X-Canvas-API-Key': other.key } }));
      assert.equal(await status(otherCredential, { apiVersion: 1, workspaceId: selected.workspaceId, operationId: selected.operationId }, 'request'), null);
      await assert.rejects(apply(otherCredential, selected, 'request'), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
    });
    await check('hidden HTTP originals remain inaccessible through MCP retry and historical Status', async () => {
      const hidden = await createSource('.key-original-hidden.md', Buffer.from('HTTP workspace namespace.\n'));
      const result = await run(hidden); assert.equal(result.disposition, 'applied');
      await assert.rejects(run(hidden, 'mcp'), code('MARKDOWN_IMPORT_INVALID_INPUT'));
      await assert.rejects(inspect(hidden, 'mcp'), code('MARKDOWN_IMPORT_REQUEST_CONFLICT'));
      assert.deepEqual(await inspect(hidden), result.receipt);
    });
    await check('source replacement invalidates the real FD expectation without native writes', async () => {
      const content = Buffer.from('Identical bytes are not an identical physical file.\n');
      const next = await createSource('key-original-replaced.md', content), file = path.join(h.source.rootPath, next.path);
      await fs.writeFile(`${file}.replacement`, content, { flag: 'wx' }); await fs.rename(`${file}.replacement`, file);
      assert.notEqual(filesystemFileVersion(await fs.stat(file)), next.expectedFileVersion);
      await assert.rejects(run(next), code('MARKDOWN_IMPORT_TARGET_CHANGED')); assert.deepEqual(await fs.readFile(file), content);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [next.workspaceId, next.path])).rows[0].n, 0);
    });
    await check('PG guards reject mutation, Session-shaped origins and null representation', async () => {
      for (const sql of ['UPDATE collaboration_original_markdown_import_api_keys SET created_at=created_at WHERE operation_id=$1',
        'DELETE FROM collaboration_original_markdown_import_api_keys WHERE operation_id=$1']) await assert.rejects(h.admin.query(sql, [imported.receipt.operationId]), code('55000'));
      const row = (await h.admin.query('SELECT * FROM collaboration_original_markdown_import_api_keys WHERE operation_id=$1', [imported.receipt.operationId])).rows[0];
      const original = decode(row.original_text); assert.equal(serialize(original), row.original_text);
      for (const invalid of [{ ...original, origin: { ...original.origin, sessionId: 'session-owner' } },
        { ...original, selection: { ...original.selection, initialRepresentation: null } }]) {
        assert.throws(() => decode(invalid), code('MARKDOWN_IMPORT_INVALID_INPUT'));
        const text = JSON.stringify(invalid);
        await assert.rejects(h.admin.query(`INSERT INTO collaboration_original_markdown_import_api_keys
          (workspace_id,operation_id,version,request_digest,original_text,original_digest,import_fingerprint,created_at)
          VALUES($1,$2,2,$3,$4,$5,$6,$7)`, [row.workspace_id, row.operation_id, row.request_digest, text, sha(text), row.import_fingerprint, row.created_at]), code('23514'));
      }
    });
    await check('failure after both native and key insertion rolls back atomically without replay', async () => {
      const content = Buffer.from('Rollback retains this exact source.\n'), next = await createSource('key-original-rollback.md', content);
      let inserts = 0;
      await assert.rejects(h.withProbe(async event => {
        if (/INSERT\s+INTO\s+(?:"[^".]+"\.)?collaboration_original_markdown_import_api_keys\b/iu.test(event.text)) {
          inserts++; throw new Error('FIXTURE_KEY_ORIGINAL_BEFORE_COMMIT');
        }
      }, () => run(next)), /FIXTURE_KEY_ORIGINAL_BEFORE_COMMIT/u);
      assert.equal(inserts, 1); assert.equal(await inspect(next), null);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, next.path)), content);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [next.workspaceId, next.path])).rows[0].n, 0);
    });
    await check('a genuine native Session receipt without key attribution cannot be adopted or replayed', async () => {
      const content = Buffer.from('Existing Session receipt remains Session-owned.\n');
      const next = await createSource('key-original-unbound-native.md', content);
      const original = decode((await h.admin.query('SELECT original_text FROM collaboration_original_markdown_import_api_keys WHERE operation_id=$1',
        [imported.receipt.operationId])).rows[0].original_text);
      const internalId = apiKeyOriginalMarkdownImportOperationId(original.origin, next.operationId);
      // A real Session import is allowed to choose this syntactically valid ID.
      // Its genuine native receipt is not a key grant or key-sidecar substitute.
      const sessionResult = await sessionImport(await h.request(h.source, 'owner'), { ...next, operationId: internalId });
      assert.equal(sessionResult.disposition, 'applied'); assert.equal(sessionResult.receipt.operationId, internalId);
      const before = await rows(internalId);
      assert.equal((before.collaboration_original_markdown_import_api_keys as unknown[]).length, 0);
      await immutableReads(async () => {
        await assert.rejects(run(next), code('MARKDOWN_IMPORT_REQUEST_CONFLICT'));
        await assert.rejects(inspect(next), code('MARKDOWN_IMPORT_REQUEST_CONFLICT'));
      });
      assert.deepEqual(await rows(internalId), before); assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, next.path)), content);
    });
    for (const revoked of [false, true]) await check(`real COMMIT acknowledgement loss: ${revoked ? 'current revocation blocks recovery' : 'fresh key phase confirms, without replay'}`, async () => {
      const content = Buffer.from(`Real lost COMMIT acknowledgement ${revoked}.\n`);
      const next = await createSource(`key-original-ack-${revoked}.md`, content);
      let mutationClient: PoolClient | undefined, operationId = '', faulted = false, insertions = 0;
      const operation = h.withProbe(async event => {
        if (/INSERT\s+INTO\s+(?:"[^".]+"\.)?collaboration_original_markdown_import_api_keys\b/iu.test(event.text)) {
          mutationClient = event.client; operationId = String(event.values[1]); insertions++;
          assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_original_markdown_import_api_keys WHERE operation_id=$1', [operationId])).rows[0].n, 0);
        }
        if (/^COMMIT\s*;?\s*$/iu.test(event.text.trim()) && event.client === mutationClient && !faulted) {
          assert.equal(event.result.command, 'COMMIT');
          const committed = await rows(operationId); assert(Object.values(committed).every(value => Array.isArray(value) && value.length === 1));
          faulted = true;
          if (revoked) await revokeApiKey(headers, issued.integration.id, { expectedRevision: revision++, credentialId });
          throw new Error('FIXTURE_KEY_ORIGINAL_COMMIT_ACK_LOST');
        }
      }, () => run(next));
      if (revoked) await assert.rejects(operation, code('API_KEY_INVALID'));
      else { const result = await operation; assert.equal(result.disposition, 'commit-recovered'); assert.equal(result.receipt.operationId, operationId); }
      assert(faulted); assert.equal(insertions, 1); const committed = await rows(operationId);
      if (revoked) await rotate();
      await immutableReads(async () => { const result = await run(next); assert.equal(result.disposition, 'already-applied');
        assert.equal(result.receipt.operationId, operationId); assert.deepEqual(await inspect(next), result.receipt); });
      assert.deepEqual(await rows(operationId), committed); assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, next.path)), content);
    });
    assert.deepEqual((await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text FROM session s ORDER BY id')).rows, sessionsBefore);
    console.log(`API-key original import owner: ${groups} genuine key/PostgreSQL/native groups passed; HTTP/MCP adapters and installed SDK acceptance are separate.`);
  });
  complete = true;
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-original-import-owner', passed: false, stage,
  name: error?.name, code: error?.code, message: error?.message, stack: error?.stack })); process.exitCode = 1; });
