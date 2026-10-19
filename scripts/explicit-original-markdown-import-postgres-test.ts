import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { MarkdownFileImportReceipt } from '../app/lib/collaboration/markdown-file-import-persistence';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Genuine Request/session/ACL -> explicit original import -> original native
// import kernel. The existing fixture owns schema, DATA, pool and closure.
// This service-boundary suite claims neither endpoint nor browser acceptance.
let phase = 'fixture', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

export async function explicitOriginalMarkdownImportPostgresTest(): Promise<void> {
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { persistExplicitOriginalMarkdownFileForWrite: apply,
      readExplicitOriginalMarkdownImportStatusForWrite: status } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { loadCollaborationStateOnConnection: load, serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { readDocumentForRequest } = await import('../app/lib/documents/service');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { upsertPostgresWorkspaceMemberForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { auth } = await import('../app/lib/auth');
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId,
      { userId: 'member', canRead: true, canWrite: true, canManage: false });
    assert.equal(h.source.permissions.canWrite, false); // stale DTO is never a grant
    let sessionId = 'session-member', sessionToken: string | undefined;
    type Selection = { apiVersion: 1; workspaceId: string; path: string; operationId: string;
      expectedFileVersion: string; initialRepresentation?: 'auto' | 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' };
    const explicitImportSelection = async (filePath: string): Promise<Selection> => ({ apiVersion: 1,
      workspaceId: h.source.workspaceId, path: filePath, operationId: `explicit_${crypto.randomUUID().replaceAll('-', '')}`,
      expectedFileVersion: filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, filePath))) });
    const explicitImportInvoke = async (selection: Selection) => apply(
      await h.request(h.source, 'member', false, sessionToken), selection);
    const explicitImportRotate = async (originalAlreadyRevoked = false) => {
      const oldId = sessionId, oldRequest = await h.request(h.source, 'member', false, sessionToken);
      const nextId = `explicit-session-${crypto.randomUUID()}`, token = crypto.randomBytes(32).toString('hex'), now = Date.now();
      await h.admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)',
        [nextId, token, now + 3600000, now]);
      if (originalAlreadyRevoked) {
        // The actual expired-session reader may already have deleted SID-A.
        // Require the prior revocation, rather than trying to revoke it twice.
        const remaining = await h.admin.query('SELECT id,user_id,expires_at FROM "session" WHERE id=$1', [oldId]);
        assert(remaining.rows.length <= 1);
        if (remaining.rows.length) {
          assert.equal(remaining.rows[0].id, oldId); assert.equal(remaining.rows[0].user_id, 'member');
          assert.equal(Number(remaining.rows[0].expires_at), 1, 'original SID remains explicitly expired');
        }
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1 AND expires_at>$2',
          [oldId, Date.now()])).rows[0].n, 0, 'original SID cannot grant a current session');
      } else {
        assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [oldId])).rowCount,
          1, 'revoke the current SID before normal rotation');
      }
      sessionId = nextId; sessionToken = token;
      const actual = await auth.api.getSession({ headers: (await h.request(h.source, 'member', false, token)).headers });
      assert.equal(actual?.user.id, 'member'); assert.equal(actual?.session.id, nextId); assert.notEqual(nextId, oldId);
      return { oldId, oldRequest };
    };
    const explicitImportReceiptRows = async (operationId: string) => {
      const rows: Record<string, Array<{ body: Record<string, unknown>; xmin: string }>> = {};
      for (const table of ['collaboration_original_markdown_imports', 'collaboration_markdown_file_import_receipts']) {
        rows[table] = (await h.admin.query(`SELECT to_jsonb(t) AS body,t.xmin::text AS xmin FROM ${table} t
          WHERE workspace_id=$1 AND operation_id=$2 ORDER BY to_jsonb(t)::text LIMIT 2`, [h.source.workspaceId, operationId])).rows;
        assert.equal(rows[table].length, 1, table);
      }
      const ledger = rows.collaboration_original_markdown_imports[0].body;
      const receipt = rows.collaboration_markdown_file_import_receipts[0].body;
      assert.equal(ledger.version, 1); assert.equal(typeof ledger.original_text, 'string');
      assert(Buffer.byteLength(ledger.original_text as string) <= 65536);
      assert.equal(ledger.original_digest, crypto.createHash('sha256').update(ledger.original_text as string).digest('hex'));
      assert.equal(ledger.import_fingerprint, receipt.request_fingerprint);
      assert.match(String(ledger.request_digest), /^[a-f0-9]{64}$/u);
      assert.equal(String(ledger.created_at), String(receipt.created_at));
      const original = JSON.parse(ledger.original_text as string);
      assert.equal(original.version, 1); assert.deepEqual(original.receipt, receipt.private_result);
      assert.equal(original.origin.userId, receipt.actor_user_id); assert.equal(original.origin.sessionId, receipt.actor_session_id);
      assert.equal(original.selection.workspaceId, h.source.workspaceId); assert.equal(original.selection.operationId, operationId);
      return rows;
    };
    const explicitImportFilesystem = async () => {
      const result: unknown[] = [], pending = ['.'];
      while (pending.length) {
        assert(result.length < 10000); const relative = pending.shift()!, file = path.join(h.dataRoot, relative);
        const value = await fs.lstat(file, { bigint: true }); assert(!value.isSymbolicLink());
        const identity = { path: relative, dev: String(value.dev), ino: String(value.ino), mode: String(value.mode),
          uid: String(value.uid), gid: String(value.gid), size: String(value.size), nlink: String(value.nlink),
          mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
        result.push(value.isFile() ? { ...identity, sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') } : identity);
        if (value.isDirectory()) pending.push(...(await fs.readdir(file)).sort().map(name => path.join(relative, name)));
      }
      return result;
    };
    const explicitImportDomain = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
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
    const explicitImportNoWrites = async <T>(operation: () => Promise<T>): Promise<T> => {
      const domain = await explicitImportDomain(), files = await explicitImportFilesystem(); let statements = 0, writes = 0;
      try { return await h.withProbe(async event => {
        assert(++statements <= 5000);
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
      }, operation); }
      finally { assert(statements > 0); assert.equal(writes, 0);
        assert.deepEqual(await explicitImportDomain(), domain); assert.deepEqual(await explicitImportFilesystem(), files); }
    };
    const explicitImportCheckReceipt = async (receipt: MarkdownFileImportReceipt, original: Buffer) => {
      assert.equal(receipt.sourceHash, crypto.createHash('sha256').update(original).digest('hex'));
      assert.equal(receipt.sourceBytes, original.length); assert.equal(receipt.target.workspaceId, h.source.workspaceId);
      assert.equal(receipt.checkpointRequired, true); assert.equal(receipt.target.initialSequence, 0);
      const stored = await load(h.connection, receipt.target.documentId); assert(stored);
      assert.equal(stored.documentId, receipt.target.documentId); assert.equal(stored.lifecycleGeneration, receipt.target.lifecycleGeneration);
      const canonical = inspectPersistedNativeCollaborationSnapshot(stored, (doc, snapshot) =>
        snapshot.content.kind === 'plain_text' ? snapshot.content.text : richMarkdownFromYDoc(doc));
      assert.deepEqual(Buffer.from(serializeCanonicalText(canonical, stored)), original);
      assert.equal(stored.newlineStyle, receipt.target.newlineStyle); assert.equal(stored.hasBom, receipt.target.hasBom);
      const inventory = inspectPersistedDocumentLinks(stored); assert(inventory.coverage.complete);
      assert.equal(inventory.document.documentId, receipt.target.documentId);
      const page = await readDocumentForRequest(await h.request(h.source, 'member', false, sessionToken), {
        apiVersion: 1, workspaceId: h.source.workspaceId, documentId: receipt.target.documentId, format: 'native', maxBytes: 262144 });
      assert(page.complete); assert.equal(page.nextCursor, null); assert.equal(page.document.documentId, receipt.target.documentId);
      assert.equal(page.document.lineageId, receipt.target.lineageId); assert.equal(page.document.path, receipt.target.path);
      assert.equal(page.document.lifecycleGeneration, receipt.target.lifecycleGeneration); assert(page.document.version);
      assert.equal(page.projection.status, 'pending'); // import receipt is not projection.current
      const pinned = await readDocumentForRequest(await h.request(h.source, 'member', false, sessionToken), {
        apiVersion: 1, workspaceId: h.source.workspaceId, documentId: receipt.target.documentId,
        expectedVersion: page.document.version, format: 'native', maxBytes: 262144 });
      assert.deepEqual(pinned, page); JSON.parse(page.fragment);
      return stored;
    };

    phase = 'unregistered raw original: same B ledger/native receipt and exact BOM/CRLF profile';
    const profilePath = 'explicit-original-profile.md';
    const profile = Buffer.from('\uFEFF---\r\ntitle: Original\r\n---\r\n\r\n# Heading\r\n\r\n[Self](explicit-original-profile.md) **bold**.\r\n');
    await fs.writeFile(path.join(h.source.rootPath, profilePath), profile, { flag: 'wx', mode: 0o600 });
    const profileSelection = await explicitImportSelection(profilePath), profileBefore = await fs.stat(path.join(h.source.rootPath, profilePath));
    assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
      [h.source.workspaceId, profilePath])).rows[0].n, 0);
    const atomic: Array<{ table: string; client: PoolClient; pid: number; xid: string }> = [];
    const imported = await h.withProbe(async event => {
      const matched = event.text.match(/INSERT\s+INTO\s+(?:"?[^".\s]+"?\.)?"?(collaboration_original_markdown_imports|collaboration_markdown_file_import_receipts|collaboration_documents|collaboration_yjs_states|file_collaboration_lineages)"?\b/iu);
      if (matched) {
        const actual = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        assert(actual.xid); atomic.push({ table: matched[1], client: event.client, pid: actual.pid, xid: actual.xid });
      }
    }, () => explicitImportInvoke(profileSelection));
    assert.equal(imported.disposition, 'applied');
    assert.deepEqual(Object.keys(imported).sort(), ['disposition', 'receipt']);
    for (const table of ['collaboration_original_markdown_imports', 'collaboration_markdown_file_import_receipts',
      'collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) assert(atomic.some(value => value.table === table), table);
    assert.equal(new Set(atomic.map(value => value.client)).size, 1); assert.equal(new Set(atomic.map(value => value.pid)).size, 1);
    assert.equal(new Set(atomic.map(value => value.xid)).size, 1);
    const profileRows = await explicitImportReceiptRows(profileSelection.operationId);
    assert(Object.values(profileRows).flat().every(row => row.xmin === String(BigInt(atomic[0].xid) % (BigInt(1) << BigInt(32)))));
    const stateRows = (await h.admin.query(`SELECT xmin::text AS xmin FROM collaboration_documents WHERE id=$1
      UNION ALL SELECT xmin::text FROM collaboration_yjs_states WHERE document_id=$1
      UNION ALL SELECT xmin::text FROM file_collaboration_lineages WHERE id=$2`,
    [imported.receipt.target.documentId, imported.receipt.target.lineageId])).rows;
    assert.equal(stateRows.length, 3); assert(stateRows.every(row => row.xmin === String(BigInt(atomic[0].xid) % (BigInt(1) << BigInt(32)))));
    assert.equal(profileRows.collaboration_markdown_file_import_receipts[0].body.actor_session_id, sessionId);
    assert.equal(profileRows.collaboration_markdown_file_import_receipts[0].body.request_id, `original-import:${profileSelection.operationId}`);
    await explicitImportCheckReceipt(imported.receipt, profile);
    assert.equal(imported.receipt.target.hasBom, true); assert.equal(imported.receipt.target.newlineStyle, 'crlf');
    assert.equal(filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, profilePath))), filesystemFileVersion(profileBefore));
    assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, profilePath)), profile); groups++;

    phase = 'registered pristine identity becomes initialized without replacing the original file';
    const pristinePath = 'explicit-pristine.markdown', pristineId = `collab-${crypto.randomUUID()}`, pristineBytes = Buffer.from('# Pristine\n\nUnicode: Ä Ω 🙂.\n');
    await fs.writeFile(path.join(h.source.rootPath, pristinePath), pristineBytes, { flag: 'wx', mode: 0o600 });
    await h.admin.query(`INSERT INTO collaboration_documents(id,organization_id,workspace_id,workspace_type,path,provider,status,state_version,created_at,updated_at,yjs_state_lifecycle)
      VALUES($1,$2,$3,$4,$5,'yjs','active',0,1,1,'never_initialized')`,
    [pristineId, h.source.organizationId, h.source.workspaceId, h.source.workspaceType, pristinePath]);
    const pristineSelection = await explicitImportSelection(pristinePath);
    const pristine = await explicitImportInvoke(pristineSelection);
    assert.equal(pristine.disposition, 'applied'); assert.equal(pristine.receipt.target.documentId, pristineId);
    await explicitImportCheckReceipt(pristine.receipt, pristineBytes);
    assert.equal(filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, pristinePath))), pristineSelection.expectedFileVersion); groups++;

    phase = 'receipt-first retry/status are no-write and renewed genuine SID-B retains original SID-A';
    const originalRows = await explicitImportReceiptRows(profileSelection.operationId), originalSession = sessionId;
    await explicitImportNoWrites(async () => {
      const again = await explicitImportInvoke(profileSelection); assert.equal(again.disposition, 'already-applied');
      assert.deepEqual(again.receipt, imported.receipt);
      assert.deepEqual(await status(await h.request(h.source, 'member', false, sessionToken), {
        apiVersion: 1, workspaceId: h.source.workspaceId, operationId: profileSelection.operationId }), imported.receipt);
      assert.equal(await status(await h.request(h.source, 'member', false, sessionToken), {
        apiVersion: 1, workspaceId: h.source.workspaceId, operationId: `unknown_${crypto.randomUUID().replaceAll('-', '')}` }), null);
      await assert.rejects(explicitImportInvoke({ ...profileSelection, path: 'different-original.md' }), { code: 'MARKDOWN_IMPORT_REQUEST_CONFLICT' });
      await assert.rejects(explicitImportInvoke({ ...profileSelection, initialRepresentation: 'plain_text' }), { code: 'MARKDOWN_IMPORT_REQUEST_CONFLICT' });
      await assert.rejects(explicitImportInvoke({ ...profileSelection, operationId: `other_${crypto.randomUUID().replaceAll('-', '')}` }),
        { code: 'MARKDOWN_IMPORT_TARGET_CHANGED' });
    });
    const retired = await explicitImportRotate(); assert.equal(retired.oldId, originalSession);
    await explicitImportNoWrites(async () => {
      await assert.rejects(apply(retired.oldRequest, profileSelection), { code: 'PRINCIPAL_AUTH_REVOKED' });
      const again = await explicitImportInvoke(profileSelection); assert.equal(again.disposition, 'already-applied');
      assert.deepEqual(again.receipt, imported.receipt);
      assert.deepEqual(await status(await h.request(h.source, 'member', false, sessionToken), {
        apiVersion: 1, workspaceId: h.source.workspaceId, operationId: profileSelection.operationId }), imported.receipt);
    });
    assert.deepEqual(await explicitImportReceiptRows(profileSelection.operationId), originalRows); groups++;

    phase = 'historical status/retry survive a missing old path and later invalid-UTF8 replacement without adopting it';
    // Explicit adversarial projection tamper, NOT an actual Move/lifecycle proof.
    // Later D2 cannot be parsed as an import; historical result still binds D1.
    const retainedOriginal = path.join(h.source.rootPath, `${profilePath}.fixture-original`);
    await fs.rename(path.join(h.source.rootPath, profilePath), retainedOriginal);
    await assert.rejects(fs.lstat(path.join(h.source.rootPath, profilePath)), { code: 'ENOENT' });
    await explicitImportNoWrites(async () => {
      assert.deepEqual(await status(await h.request(h.source, 'member', false, sessionToken), {
        apiVersion: 1, workspaceId: h.source.workspaceId, operationId: profileSelection.operationId }), imported.receipt);
      const again = await explicitImportInvoke(profileSelection); assert.equal(again.disposition, 'already-applied');
      assert.deepEqual(again.receipt, imported.receipt);
    });
    const d2 = Buffer.from([0xff, 0xfe, 0x00, 0x44, 0x32]);
    await fs.writeFile(path.join(h.source.rootPath, profilePath), d2, { flag: 'wx', mode: 0o600 });
    assert.notEqual(filesystemFileVersion(await fs.stat(path.join(h.source.rootPath, profilePath))), profileSelection.expectedFileVersion);
    await explicitImportNoWrites(async () => {
      assert.deepEqual(await status(await h.request(h.source, 'member', false, sessionToken), {
        apiVersion: 1, workspaceId: h.source.workspaceId, operationId: profileSelection.operationId }), imported.receipt);
      const again = await explicitImportInvoke(profileSelection); assert.equal(again.disposition, 'already-applied');
      assert.deepEqual(again.receipt, imported.receipt);
    });
    assert.deepEqual(await explicitImportReceiptRows(profileSelection.operationId), originalRows);
    assert.deepEqual(await fs.readFile(retainedOriginal), profile);
    assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, profilePath)), d2); groups++;

    phase = 'stale observed original FileVersion rejects without domain or filesystem changes';
    const stalePath = 'explicit-stale.md'; await fs.writeFile(path.join(h.source.rootPath, stalePath), '# Before\n', { flag: 'wx', mode: 0o600 });
    const stale = await explicitImportSelection(stalePath);
    await fs.writeFile(path.join(h.source.rootPath, stalePath), '# Actual replacement, different size\n');
    await explicitImportNoWrites(() => assert.rejects(explicitImportInvoke(stale), { code: 'MARKDOWN_IMPORT_TARGET_CHANGED' })); groups++;

    phase = 'actual write-right loss rejects both import and historical status under remaining read';
    await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId,
      { userId: 'member', canRead: true, canWrite: false, canManage: false });
    try { await explicitImportNoWrites(async () => {
      await assert.rejects(explicitImportInvoke(stale), { code: 'PRINCIPAL_ACCESS_DENIED' });
      await assert.rejects(status(await h.request(h.source, 'member', false, sessionToken), {
        apiVersion: 1, workspaceId: h.source.workspaceId, operationId: profileSelection.operationId }), { code: 'PRINCIPAL_ACCESS_DENIED' });
    }); } finally { await upsertPostgresWorkspaceMemberForActor(owner, h.source.workspaceId,
      { userId: 'member', canRead: true, canWrite: true, canManage: false }); }
    groups++;

    phase = 'real same-B COMMIT acknowledgement loss: independent visibility and explicit renewed-session recovery';
    for (const revokeAfterCommit of [false, true]) {
      const filePath = revokeAfterCommit ? 'explicit-ack-revoked.md' : 'explicit-ack.md', bytes = Buffer.from(`# ${filePath}\n\nOriginal ACK body.\n`);
      await fs.writeFile(path.join(h.source.rootPath, filePath), bytes, { flag: 'wx', mode: 0o600 });
      const selected = await explicitImportSelection(filePath), oldId = sessionId;
      let mutationClient: PoolClient | undefined, mutationPid = 0, mutationXid = '', mutationStart = '', receiptSeen = false, faulted = false;
      let committed: Awaited<ReturnType<typeof explicitImportReceiptRows>> | undefined;
      let mutationRows: Awaited<ReturnType<typeof explicitImportReceiptRows>> | undefined;
      const operation = h.withProbe(async event => {
        if (/INSERT\s+INTO\s+(?:"?[^".\s]+"?\.)?"?collaboration_original_markdown_imports"?\b/iu.test(event.text)) {
          assert.equal(mutationClient, undefined); assert.equal(event.result.rowCount, 1, 'actual ledger INSERT rowCount'); mutationClient = event.client;
          const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid,current_schema() AS schema FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert(actual.xid); assert.equal(actual.schema, h.schema); mutationPid = actual.pid; mutationXid = actual.xid; mutationStart = actual.start;
          mutationRows = {};
          for (const table of ['collaboration_original_markdown_imports', 'collaboration_markdown_file_import_receipts']) {
            mutationRows[table] = (await event.raw(`SELECT to_jsonb(t) AS body,t.xmin::text AS xmin FROM ${table} t
              WHERE workspace_id=$1 AND operation_id=$2 ORDER BY to_jsonb(t)::text LIMIT 2`, [h.source.workspaceId, selected.operationId])).rows;
            assert.equal(mutationRows[table].length, 1, `same-B original row for ${table}`);
          }
          assert.equal((await h.admin.query(`SELECT ((SELECT count(*) FROM collaboration_original_markdown_imports WHERE workspace_id=$1 AND operation_id=$2)
            +(SELECT count(*) FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2))::integer AS n`,
          [h.source.workspaceId, selected.operationId])).rows[0].n, 0);
        }
        if (/INSERT\s+INTO\s+(?:"?[^".\s]+"?\.)?"?collaboration_markdown_file_import_receipts"?\b/iu.test(event.text)) receiptSeen = true;
        if (/^COMMIT\s*;?\s*$/iu.test(event.text.trim()) && event.client === mutationClient && !faulted) {
          assert(receiptSeen); assert(mutationPid > 0); assert.equal(event.result.command, 'COMMIT');
          const actual = (await event.raw(`SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS start,
            pg_current_xact_id_if_assigned()::text AS xid FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
          assert.equal(actual.pid, mutationPid); assert.equal(actual.start, mutationStart); assert.equal(actual.xid, null);
          // h.withProbe has already forwarded THIS actual COMMIT. A different
          // admin backend must now observe BOTH immutable rows before throw.
          const adminPid = (await h.admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          assert.notEqual(adminPid, mutationPid); committed = await explicitImportReceiptRows(selected.operationId);
          assert.deepEqual(committed, mutationRows);
          assert(Object.values(committed).flat().every(row => row.xmin === String(BigInt(mutationXid) % (BigInt(1) << BigInt(32)))));
          assert.equal(committed.collaboration_markdown_file_import_receipts[0].body.actor_session_id, oldId);
          faulted = true;
          if (revokeAfterCommit) assert.equal((await h.admin.query('UPDATE "session" SET expires_at=1 WHERE id=$1 RETURNING id', [oldId])).rowCount, 1, 'revoke original SID after real COMMIT');
          throw new Error('FIXTURE_EXPLICIT_IMPORT_COMMIT_ACK_LOST');
        }
      }, () => explicitImportInvoke(selected));
      if (revokeAfterCommit) await assert.rejects(operation, { code: 'PRINCIPAL_AUTH_REVOKED' });
      else { const recovered = await operation; assert.equal(recovered.disposition, 'commit-recovered');
        assert.deepEqual(recovered.receipt, committed?.collaboration_markdown_file_import_receipts[0].body.private_result); }
      assert(faulted && committed); assert.equal(mutationClient !== undefined, true);
      const original = committed.collaboration_markdown_file_import_receipts[0].body.private_result as MarkdownFileImportReceipt;
      if (revokeAfterCommit) {
        const retired = await explicitImportRotate(true); assert.equal(retired.oldId, oldId);
        await assert.rejects(apply(retired.oldRequest, selected), { code: 'PRINCIPAL_AUTH_REVOKED' });
      }
      await explicitImportNoWrites(async () => {
        const repeated = await explicitImportInvoke(selected); assert.equal(repeated.disposition, 'already-applied');
        assert.deepEqual(repeated.receipt, original);
        assert.deepEqual(await status(await h.request(h.source, 'member', false, sessionToken), {
          apiVersion: 1, workspaceId: h.source.workspaceId, operationId: selected.operationId }), original);
      });
      assert.deepEqual(await explicitImportReceiptRows(selected.operationId), committed);
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, filePath)), bytes);
    }
    groups++;
    assert.equal(groups, 7);
  }); complete = true; console.log(JSON.stringify({ test: 'explicit-original-markdown-import-postgres', groups, originalExit: 0 })); }
  finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}

explicitOriginalMarkdownImportPostgresTest().catch((error: unknown) => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error(JSON.stringify({ test: 'explicit-original-markdown-import-postgres', phase, groups,
    name: error instanceof Error ? error.name : 'UnknownError',
    code: typeof code === 'string' && /^[A-Z0-9_]{1,120}$/u.test(code) ? code : undefined,
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 1500) : undefined }));
  process.exitCode = 1;
});
