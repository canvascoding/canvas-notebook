import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { QueryResult, PoolClient } from 'pg';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { DocumentSearchPageV1, DocumentSearchRequestV1 } from '../app/lib/documents/search-contract';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';

// Actual migrated PostgreSQL, original request principals and shared service.
// Raw SQL below arranges fixture content/adversarial changes; it never supplies
// authorization, substitutes a query result or claims document-create coverage.
let groups = 0, completed = false, stage = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const code = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
type Query = (text: string, values?: unknown[]) => Promise<QueryResult>;

export async function nativeDocumentSearchServicePostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { searchDocumentsForRequest: search, readDocumentForRequest: read } = await import('../app/lib/documents/service');
    const { POST } = await import('../app/api/documents/search/route');
    const { NextRequest } = await import('next/server');
    const { DOCUMENT_SEARCH_PAGE_JSON_SCHEMA_V1, DOCUMENT_SEARCH_ERROR_JSON_SCHEMA_V1 } = await import('../app/lib/documents/search-json-schema');
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/server/validators/ajv');
    const validator = new AjvJsonSchemaValidator(), validatePage = validator.getValidator<DocumentSearchPageV1>(DOCUMENT_SEARCH_PAGE_JSON_SCHEMA_V1),
      validateError = validator.getValidator(DOCUMENT_SEARCH_ERROR_JSON_SCHEMA_V1);
    const workspace = h.source, workspaceId = workspace.workspaceId;
    const raw = h.admin.query.bind(h.admin) as Query;
    const seed = async (file: string, body: string, query: Query = raw, selected: WorkspaceContext = workspace,
      initialized = true) => {
      const id = `search-${randomUUID()}`, lineage = `lineage-${randomUUID()}`, doc = createPlainTextYDoc(body);
      try {
        await query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
          VALUES($1,$2,$3,$4,$5,'active',100)`, [lineage, selected.workspaceId, selected.workspaceType, selected.organizationId ?? null, file]);
        await query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
          state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'yjs',$7,$8,'active',100,100)`,
        [id, lineage, selected.workspaceId, selected.workspaceType, selected.organizationId ?? null, file, initialized ? 7 : 0, initialized ? 'initialized' : 'never_initialized']);
        if (initialized) await query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,
          lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,
          checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
          VALUES($1,$2,$3,$4,'plain_text',1,1,$5,$6,7,100,0,NULL,NULL,NULL,'lf',0,0,'active')`,
        [id, selected.workspaceId, selected.organizationId ?? null, file, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
      } finally { doc.destroy(); }
      return { id, lineage, file, body };
    };
    const title = async (file: string, value: string, query: Query = raw) => query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
      VALUES($1,$2,$3,100,100) ON CONFLICT(workspace_id,path) DO UPDATE SET title=excluded.title,updated_at=workspace_file_metadata.updated_at+1`, [workspaceId, file, value]);
    const selection = (scopePath: string, query: string, extra: Partial<DocumentSearchRequestV1> = {}): DocumentSearchRequestV1 =>
      ({ apiVersion: 1, workspaceId, query, scopePath, ...extra });
    const run = async (input: DocumentSearchRequestV1, user: 'owner' | 'member' = 'member'): Promise<DocumentSearchPageV1> =>
      search(await h.request(workspace, user, true), input);
    const assertPage = (page: DocumentSearchPageV1): void => {
      assert(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 12_000);
      assert.equal(page.coverage.returned, page.hits.length); assert.equal(page.coverage.remoteLive, 'unknown');
      assert.equal(page.coverage.globalCurrentContent, 'not_certified'); assert.equal('complete' in page, false);
      for (const hit of page.hits) {
        assert(Buffer.byteLength(hit.snippet, 'utf8') <= 512); assert.equal(Buffer.from(hit.snippet).toString('utf8'), hit.snippet);
        assert.equal(hit.document.kind, 'native_document'); assert.equal(hit.document.workspaceId, workspaceId);
        assert(hit.document.version && hit.document.metadataVersion && hit.document.lineageId);
        assert.equal(hit.currency.observedVersion, hit.document.version);
      }
    };
    const nativeRows = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states',
        'workspace_file_metadata', 'file_revisions', 'file_revision_contents', 'collaboration_file_projections']) {
        result[table] = (await h.admin.query(`SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      }
      return result;
    };
    const files = async () => {
      const result: Record<string, unknown> = {};
      const visit = async (file: string): Promise<void> => {
        const stat = await fs.lstat(file, { bigint: true }); assert(!stat.isSymbolicLink());
        result[path.relative(workspace.rootPath, file)] = { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
          ...(stat.isFile() ? { bytes: (await fs.readFile(file)).toString('base64') } : {}) };
        if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
      };
      await visit(workspace.rootPath); return result;
    };
    const walk = async (scope: string, query: string): Promise<string[]> => {
      const seen: string[] = [], cursors = new Set<string>(); let cursor: string | undefined, terminal = false;
      for (let index = 0; index < 30; index++) {
        const page = await run(selection(scope, query, { limit: index === 0 ? 1 : 3, ...(cursor ? { cursor } : {}) })); assertPage(page);
        for (const hit of page.hits) { assert(!seen.includes(hit.document.documentId)); seen.push(hit.document.documentId); }
        if (page.nextCursor === null) { terminal = true; break; }
        assert(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      assert(terminal, 'Bounded traversal must reach the actual terminal cursor.'); return seen;
    };

    stage = 'native current data and metadata ranking';
    const imported = await h.upload('projection/native.md', Buffer.from('Canonicalneedle from actual Markdown upload 😀'));
    const stale = await h.upload('projection/stale.md', Buffer.from('Canonicalneedle second current document.'));
    await fs.unlink(path.join(workspace.rootPath, 'projection/native.md'));
    await fs.writeFile(path.join(workspace.rootPath, 'projection/stale.md'), 'Only diskstalephrase exists here.');
    const full = await seed('foreign/native.payload', 'Canonicalneedle stable ID full body 😀 café; final.');
    const foreign = await seed('foreign-other/native.payload', 'Canonicalneedle forbidden sibling.');
    for (let index = 0; index < 8; index++) await seed(`rank/a${index}.md`, 'rankneedle body');
    const exact = await seed('rank/zz-last.md', 'rankneedle body'); await h.metadata(workspace, exact.file, { title: 'rankneedle' });
    const literal = await seed('literal/a.md', 'actual a+b text'), regexOnly = await seed('literal/b.md', 'aaab regex-only text');
    const unicode = await seed('unicode/note.md', `${'😀'.repeat(300)}unicodehit${'é'.repeat(400)}`);
    const rowsBefore = await nativeRows(), fsBefore = await files();
    const importedPage = await run(selection('projection', 'canonicalneedle')); assertPage(importedPage);
    assert.deepEqual(new Set(importedPage.hits.map(hit => hit.document.documentId)), new Set([imported.documentId, stale.documentId]));
    assert(importedPage.hits.every(hit => hit.currency.source === 'persisted_yjs' && hit.currency.observedDurable));
    assert.deepEqual((await run(selection('projection', 'diskstalephrase'))).hits, []);
    const foreignPage = await run(selection('foreign', 'canonicalneedle')); assertPage(foreignPage);
    assert.deepEqual(foreignPage.hits.map(hit => hit.document.documentId), [full.id]); assert.notEqual(full.id, foreign.id);
    const post = async (body: string) => {
      const original = await h.request(workspace, 'member', true), headers = new Headers(original.headers);
      headers.set('content-type', 'application/json');
      return POST(new NextRequest('http://localhost/api/documents/search', { method: 'POST', headers, body }));
    };
    const response = await post(JSON.stringify(selection('foreign', 'canonicalneedle')));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const decoded = validatePage(await response.json()); assert.equal(decoded.valid, true, decoded.errorMessage ?? 'Invalid document search page'); assert(decoded.data);
    assertPage(decoded.data); assert.deepEqual(decoded.data.hits, foreignPage.hits);
    let invalidQueries = 0;
    await h.withProbe(async () => { invalidQueries++; }, async () => {
      for (const body of [JSON.stringify({ ...selection('foreign', 'canonicalneedle'), unknown: true }),
        JSON.stringify({ ...selection('foreign', 'canonicalneedle'), padding: 'x'.repeat(32 * 1024) })]) {
        const rejected = await post(body); assert.equal(rejected.status, 400);
        assert.equal(rejected.headers.get('cache-control'), 'no-store'); assert.equal(rejected.headers.get('x-content-type-options'), 'nosniff');
        const failure: unknown = await rejected.json(), checked = validateError(failure); assert.equal(checked.valid, true, checked.errorMessage ?? 'Invalid document search error');
        assert.deepEqual(failure, { apiVersion: 1, success: false, code: 'INVALID_SEARCH_REQUEST' });
      }
    });
    assert.equal(invalidQueries, 0, 'Unknown/oversized route selectors must fail before any SQL principal/search phase.');
    let readCursor: string | undefined, reconstructed = '', readTerminal = false, byteOffset = 0;
    for (let index = 0; index < 40; index++) {
      const page = await read(await h.request(workspace, 'member', true), { apiVersion: 1, workspaceId, documentId: full.id,
        expectedVersion: foreignPage.hits[0].document.version, format: 'text', maxBytes: 4, ...(readCursor ? { cursor: readCursor } : {}) });
      assert.equal(page.byteOffset, byteOffset); assert.equal(page.document.version, foreignPage.hits[0].document.version);
      byteOffset += page.byteLength; reconstructed += page.fragment;
      if (page.nextCursor === null) { assert(page.complete); readTerminal = true; break; } readCursor = page.nextCursor;
    }
    assert(readTerminal); assert.equal(reconstructed, full.body);
    const ranked = await run(selection('rank', 'rankneedle', { limit: 1 })); assertPage(ranked);
    assert.equal(ranked.hits[0].document.documentId, exact.id, 'Exact title beyond the first alphabetic eight must be admitted first.');
    assert.equal(ranked.coverage.windowStart, 0); assert.equal(ranked.coverage.windowEnd, 8);
    assert.deepEqual((await run(selection('literal', 'a+b'))).hits.map(hit => hit.document.documentId), [literal.id]); assert.notEqual(literal.id, regexOnly.id);
    const unicodePage = await run(selection('unicode', 'unicodehit')); assertPage(unicodePage);
    assert.equal(unicodePage.hits[0].document.documentId, unicode.id); assert.match(unicodePage.hits[0].snippet, /unicodehit/u);
    assert.deepEqual(await nativeRows(), rowsBefore); assert.deepEqual(await files(), fsBefore);
    console.log('PASS real request native authority, absent/stale projections, late exact title, literal query, Unicode snippets and versioned ID reading'); groups++;

    stage = 'continuation bounds and honest coverage';
    const many = [];
    for (let index = 0; index < 10; index++) many.push(await seed(`continuation/n${String(index).padStart(2, '0')}.md`, 'needle in body'));
    assert.deepEqual(new Set(await walk('continuation', 'needle')), new Set(many.map(target => target.id)));
    for (let index = 0; index < 8; index++) await seed(`empty-window/a${index}.md`, 'unrelated body');
    const later = await seed('empty-window/z.md', 'latebodyneedle');
    const empty = await run(selection('empty-window', 'latebodyneedle')); assertPage(empty);
    assert.deepEqual(empty.hits, []); assert(empty.nextCursor); assert.equal(empty.coverage.moreCandidates, true);
    const laterPage = await run(selection('empty-window', 'latebodyneedle', { cursor: empty.nextCursor }));
    assert.deepEqual(laterPage.hits.map(hit => hit.document.documentId), [later.id]); assert.equal(laterPage.nextCursor, null);
    await seed('coverage/.secret.md', 'coveragehit'); await seed('coverage/pristine.md', '', raw, workspace, false);
    const oversized = await seed('coverage/large.md', `coveragehit ${'x'.repeat(270 * 1024)}`), visible = await seed('coverage/visible.md', 'coveragehit');
    const coverage = await run(selection('coverage', 'coveragehit')); assertPage(coverage);
    assert.deepEqual(coverage.hits.map(hit => hit.document.documentId), [visible.id]); assert.equal(coverage.coverage.candidateCount, 2);
    assert.equal(coverage.coverage.pristineExcluded, 1); assert.equal(coverage.coverage.excludedInWindow.tooLarge, 1);
    assert.equal(coverage.coverage.localLive, 'unknown'); assert.equal(coverage.nextCursor, null); assert.notEqual(oversized.id, visible.id);
    const envelopeA = await seed('envelope/a.md', 'envelopehit'), envelopeB = await seed('envelope/b.md', 'envelopehit');
    await title(envelopeA.file, '界'.repeat(1800)); await title(envelopeB.file, '界'.repeat(1800));
    const near = await run(selection('envelope', 'envelopehit', { limit: 25 })); assertPage(near);
    assert.equal(near.hits.length, 1); assert(near.nextCursor); assert.equal(near.coverage.moreWindowHits, true);
    assert(Buffer.byteLength(JSON.stringify(near), 'utf8') > 6000);
    const rest = await run(selection('envelope', 'envelopehit', { cursor: near.nextCursor, limit: 1 })); assertPage(rest);
    assert.equal(rest.hits.length, 1); assert.notEqual(rest.hits[0].document.documentId, near.hits[0].document.documentId); assert.equal(rest.nextCursor, null);
    await title(envelopeA.file, '界'.repeat(4096));
    await assert.rejects(run(selection(envelopeA.file, 'envelopehit')), error => code(error) === 'SEARCH_OUTPUT_TOO_LARGE');
    await assert.rejects(run(selection('界'.repeat(4000), 'nohits')), error => code(error) === 'SEARCH_OUTPUT_TOO_LARGE',
      'An empty page must obey the same 12k envelope bound.');
    console.log('PASS same-window cursor rest with changed limits, zero-hit continuation, explicit exclusions and complete-envelope UTF-8 bounds'); groups++;

    stage = 'independent current corpus and raw ABA checks';
    const target = await seed('drift/current.md', 'raw needle A');
    const baseline = await nativeRows();
    for (const mode of ['new-unmatched-id', 'metadata', 'generation'] as const) {
      let changed = false;
      await h.withProbe(async event => {
        if (!changed && event.text.includes('s.yjs_state,s.state_vector') && event.values[0] === target.id) {
          changed = true;
          if (mode === 'new-unmatched-id') await seed('drift/unmatched-new.md', 'no matching phrase here', event.raw);
          if (mode === 'metadata') await title(target.file, 'Changed after original body read', event.raw);
          if (mode === 'generation') await event.raw('UPDATE collaboration_yjs_states SET lifecycle_generation=lifecycle_generation+1 WHERE document_id=$1', [target.id]);
        }
      }, () => assert.rejects(run(selection('drift', 'needle')), error => mode === 'new-unmatched-id'
        ? code(error) === 'SEARCH_CORPUS_CHANGED' : ['DOCUMENT_SCOPE_CHANGED', 'SEARCH_CORPUS_CHANGED'].includes(String(code(error)))));
      assert(changed); assert.deepEqual(await nativeRows(), baseline, 'Same-B adversarial writes must actually roll back.');
    }
    const a = new Y.Doc(), b = new Y.Doc(); a.clientID = 831007; b.clientID = 831007;
    let updateA: Buffer, updateB: Buffer, vectorA: Buffer;
    try { a.getText('content').insert(0, 'raw needle A'); b.getText('content').insert(0, 'raw needle B');
      updateA = Buffer.from(Y.encodeStateAsUpdate(a)); updateB = Buffer.from(Y.encodeStateAsUpdate(b)); vectorA = Buffer.from(Y.encodeStateVector(a)); }
    finally { a.destroy(); b.destroy(); }
    assert.equal(updateA.byteLength, updateB.byteLength); assert.notDeepEqual(updateA, updateB);
    await raw('UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3 WHERE document_id=$1', [target.id, updateA, vectorA]);
    let switched = false, restored = false;
    await h.withProbe(async event => {
      if (!switched && event.text.includes('canvas.native-search.window.v1') && Array.isArray(event.values[0]) && event.values[0].includes(target.id)) {
        switched = true; await event.raw('UPDATE collaboration_yjs_states SET yjs_state=$2 WHERE document_id=$1', [target.id, updateB]);
      } else if (switched && !restored && event.text.includes('s.yjs_state,s.state_vector') && event.values[0] === target.id) {
        assert(Buffer.from(event.result.rows[0].yjs_state).equals(updateB)); restored = true;
        await event.raw('UPDATE collaboration_yjs_states SET yjs_state=$2 WHERE document_id=$1', [target.id, updateA]);
      }
    }, () => assert.rejects(run(selection('drift', 'needle')), error => code(error) === 'DOCUMENT_VERSION_CONFLICT'));
    assert(switched && restored); assert(Buffer.from((await raw('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [target.id])).rows[0].yjs_state).equals(updateA));
    console.log('PASS independent full membership/metadata/lifecycle rechecks and actual raw state A→B→A are terminal without snippets'); groups++;

    stage = 'current authority and confirmed publication';
    const authorityTarget = await seed('authority/read.md', 'authorityneedle body');
    const originalRows = await nativeRows(); let revoked = false;
    await h.withProbe(async event => {
      if (!revoked && event.text.includes('s.yjs_state,s.state_vector') && event.values[0] === authorityTarget.id) {
        revoked = true; assert.equal((await event.raw(`UPDATE canvas_workspace_members SET can_read=0 WHERE workspace_id=$1
          AND user_id='member' AND can_read=1 AND can_write=0 AND can_manage=0`, [workspaceId])).rowCount, 1);
      }
    }, () => assert.rejects(run(selection('authority', 'authorityneedle')), error => code(error) === 'ACCESS_DENIED'));
    assert(revoked); assert.equal(Number((await raw("SELECT can_read FROM canvas_workspace_members WHERE workspace_id=$1 AND user_id='member'", [workspaceId])).rows[0].can_read), 1);
    assert.deepEqual(await nativeRows(), originalRows);
    const first = await run(selection('continuation', 'needle', { limit: 1 })); assert(first.nextCursor);
    for (const input of [selection('continuation', 'different', { cursor: first.nextCursor }),
      selection('foreign', 'needle', { cursor: first.nextCursor })]) {
      await assert.rejects(run(input), error => code(error) === 'SEARCH_CORPUS_CHANGED');
    }
    await assert.rejects(run(selection('continuation', 'needle', { cursor: first.nextCursor }), 'owner'), error => code(error) === 'SEARCH_CORPUS_CHANGED');
    let lostCommit = false;
    await h.withProbe(async event => { if (!lostCommit && event.text === 'COMMIT') { lostCommit = true; throw new Error('Lost real Search COMMIT acknowledgement.'); } },
      () => assert.rejects(run(selection('authority', 'authorityneedle')), error => code(error) === 'READ_OUTCOME_UNCONFIRMED'));
    assert(lostCommit);
    let released = false, restoredRelease = false, releaseClient: PoolClient | undefined, releaseDescriptor: PropertyDescriptor | undefined;
    try {
      await h.withProbe(async (event: MetadataSqlEvent) => {
        if (event.text !== 'COMMIT' || releaseClient) return;
        releaseClient = event.client; releaseDescriptor = Object.getOwnPropertyDescriptor(event.client, 'release');
        const original = event.client.release;
        Object.defineProperty(event.client, 'release', { configurable: true, writable: true, value: (error?: Error | boolean) => {
          original.call(event.client, error); released = true;
          if (releaseDescriptor) Object.defineProperty(event.client, 'release', releaseDescriptor); else Reflect.deleteProperty(event.client, 'release');
          restoredRelease = true; throw new Error('Lost actual Search close acknowledgement after release.');
        } });
      }, () => assert.rejects(run(selection('authority', 'authorityneedle')), error => code(error) === 'READ_OUTCOME_UNCONFIRMED'));
    } finally { if (releaseClient && !restoredRelease) {
      if (releaseDescriptor) Object.defineProperty(releaseClient, 'release', releaseDescriptor); else Reflect.deleteProperty(releaseClient, 'release');
    } }
    assert(released && restoredRelease); assert.deepEqual(await nativeRows(), originalRows);
    console.log('PASS actual current ACL/cursor origin checks and lost real COMMIT/close acknowledgements publish no search page'); groups++;
  });
  assert.equal(groups, 4); completed = true;
  console.log(JSON.stringify({ suite: 'native-document-search-service', groups, evidence: 'actual_pg_request_principal_and_service' }));
}

nativeDocumentSearchServicePostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'native-document-search-service', stage, groups, name: error instanceof Error ? error.name : 'UnknownError', code: code(error) ?? null }));
  console.error(error); process.exitCode = 1;
});
