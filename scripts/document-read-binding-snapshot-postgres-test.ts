import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { DocumentReadError, type DocumentReadPageV1 } from '../app/lib/documents/contracts';
import { collaborationAdmissionLockKey } from '../app/lib/collaboration/room-admission-contract';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

type Audit = { realm: number; relations: number; workspace: number; snapshots: number; failedSnapshots: number;
  nativeRealm: number; nativeRelations: number; nativeFences: number; nativeSnapshots: number;
  begins: number; commits: number; rollbacks: number; injected: boolean; pid?: number };
type Actor = 'http' | 'agent' | 'mcp';

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Observe real driver replies and optionally mutate that same held transaction.
 * Never replace a reply, construct authority or retry an operation. */
async function withReadBindingAudit<T>(operation: () => Promise<T>,
  mutate?: (client: Client, query: typeof Client.prototype.query) => Promise<void>, mutateAfter = 5,
  boundary: 'binding' | 'native' = 'binding'): Promise<{ result: T; audit: Audit }> {
  const original = Client.prototype.query;
  const audit: Audit = { realm: 0, relations: 0, workspace: 0, snapshots: 0, failedSnapshots: 0,
    nativeRealm: 0, nativeRelations: 0, nativeFences: 0, nativeSnapshots: 0,
    begins: 0, commits: 0, rollbacks: 0, injected: false };
  const held: { client?: Client } = {};
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    if (args.some(value => typeof value === 'function')) return Reflect.apply(original, this, args);
    const input = args[0], sql = typeof input === 'string' ? input.trim()
      : input && typeof input === 'object' ? String(Reflect.get(input, 'text') ?? '').trim() : '';
    if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE') {
      assert.equal(held.client, undefined); held.client = this; audit.begins++;
      audit.pid = Number(Reflect.get(this, 'processID')); assert(Number.isSafeInteger(audit.pid) && audit.pid! > 0);
    }
    if (this !== held.client) return Reflect.apply(original, this, args);
    return (async () => {
      let result;
      try { result = await Reflect.apply(original, this, args); }
      catch (error) {
        if (sql.includes('AS binding_relations')) audit.failedSnapshots++;
        throw error;
      }
      if (sql.startsWith('SELECT current_schema() AS schema,') && sql.includes('AS transaction_id')) audit.realm++;
      const values = args[1];
      if (sql.startsWith('SELECT name,') && sql.includes('AS same_relation') && Array.isArray(values)
        && Array.isArray(values[1]) && values[1].length === 6 && values[1].includes('collaboration_file_projections')) audit.relations++;
      if (sql.startsWith('SELECT current_schema() AS schema_name,') && sql.includes('AS transaction_id')) audit.nativeRealm++;
      if (sql.startsWith('SELECT name,') && sql.includes('AS same_relation') && Array.isArray(values)
        && Array.isArray(values[1]) && values[1].length === 8 && values[1].includes('collaboration_admission_targets')) audit.nativeRelations++;
      if (sql.startsWith('SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a')) audit.nativeFences++;
      if (sql.startsWith('SELECT CASE WHEN octet_length(id)<=16384 THEN id END AS id')
        && sql.includes('.canvas_workspaces WHERE id=$1')) audit.workspace++;
      const binding = sql.includes('AS binding_relations') && sql.includes('AS binding_workspace_id');
      const native = sql.includes('AS native_read_relations') && sql.includes('AS native_read_modes');
      if (binding) audit.snapshots++;
      if (native) audit.nativeSnapshots++;
      const selected = boundary === 'binding' ? binding : native;
      const count = boundary === 'binding' ? audit.snapshots : audit.nativeSnapshots;
      if (mutate && selected && count === mutateAfter) {
        try { await mutate(this, original); audit.injected = true; }
        catch (error) { console.error('Read binding mutation failed:', (error as { code?: string }).code ?? 'no-pg-code'); throw error; }
      }
      if (sql === 'COMMIT') audit.commits++;
      if (sql === 'ROLLBACK') audit.rollbacks++;
      return result;
    })();
  } as typeof Client.prototype.query;
  try { return { result: await operation(), audit }; }
  finally { Client.prototype.query = original; }
}

async function documentReadBindingSnapshotPostgresTest(): Promise<void> {
  const baselineOnly = process.env.CANVAS_READ_BINDING_BASELINE === '1';
  const nativeBaselineOnly = process.env.CANVAS_NATIVE_READ_FENCE_BASELINE === '1';
  assert.equal(baselineOnly && nativeBaselineOnly, false);
  await withDocumentReadToolDispatchFixture(async h => {
    const expected = '# Binding observation\n\n[Sibling](source.md)\n\nPreserved äöü 😀.\n';
    const target = await h.seed({ filePath: 'binding/target.md', text: expected, representation: 'tiptap_blocks' });
    const before = await h.snapshot();
    const workspace = (await h.admin.query('SELECT *,xmin::text AS xmin FROM canvas_workspaces WHERE id=$1', [h.workspaceId])).rows;
    const schema = (await h.admin.query('SELECT current_schema() AS schema')).rows[0].schema as string;
    assert.match(schema, /^[a-z0-9_]+$/u);
    const retired = `binding_retired_${randomUUID().replaceAll('-', '')}`;
    const schemaOid = (await h.admin.query('SELECT to_regnamespace($1)::oid::text AS oid', [schema])).rows[0].oid;
    const session = (await h.admin.query('SELECT token FROM session WHERE id=$1', ['reader-session'])).rows[0]; assert(session);
    const cookie = (await serializeSignedCookie('better-auth.session_token', session.token, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
    const token = await h.issue();
    const { POST } = await import('../app/api/documents/read/route');
    const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
    const { getPiTools } = await import('../app/lib/pi/tool-registry');
    const registered: AgentTool | undefined = (await getPiTools('reader', h.agentId, h.piSessionId,
      { strictAuthorization: true, metadataOnlyExternal: true })).find(tool => tool.name === 'read_document');
    assert(registered);
    let rpcId = 0, controls = 0, denied = 0;
    const observations: Array<{ actor: Actor; audit: Audit }> = [];
    const readAdapterBinding = async (actor: Actor, failure?: 'DOCUMENT_SCOPE_CHANGED' | 'DOCUMENT_TOO_LARGE') => {
      let value: unknown;
      if (actor === 'http') {
        const response = await POST(new NextRequest('http://localhost/api/documents/read', { method: 'POST', headers: {
          cookie, 'content-type': 'application/json', 'x-canvas-workspace-id': h.workspaceId,
        }, body: JSON.stringify({ apiVersion: 1, workspaceId: h.workspaceId, documentId: target.documentId, format: 'markdown' }) }));
        value = await response.json();
        assert.equal(response.status, failure ? new DocumentReadError(failure).status : 200, String(object(value).code ?? 'page'));
      } else if (actor === 'agent') {
        const execute = () => registered.execute(randomUUID(),
          { workspaceId: h.workspaceId, documentId: target.documentId, format: 'markdown' });
        if (failure) {
          // The genuine invocation wrapper retains a failed service call even
          // when its inner tool formats that failure. Require the original
          // public error; assertion/protocol failures are never denials.
          await assert.rejects(execute, error => {
            assert(error instanceof DocumentReadError); assert.equal(error.code, failure);
            assert.equal(Object.hasOwn(error, 'fragment'), false); assert.equal(Object.hasOwn(error, 'document'), false);
            return true;
          });
          return;
        }
        const result = await execute();
        assert.notEqual(Reflect.get(result, 'isError'), true);
        assert.equal(result.content.length, 1); const text = object(result.content[0]);
        assert.equal(text.type, 'text'); assert(typeof text.text === 'string'); value = JSON.parse(text.text);
        const { toolOutput: _toolOutput, ...details } = object(result.details); assert.deepEqual(details, value);
      } else {
        const id = ++rpcId;
        const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-11-25',
        }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
          name: 'read_knowledge_source', arguments: { workspace_id: h.workspaceId, document_id: target.documentId, format: 'markdown' },
        } }) }));
        assert.equal(response.status, 200); const envelope = object(await response.json());
        assert.equal(envelope.id, id); assert.equal(envelope.jsonrpc, '2.0'); assert.equal(Object.hasOwn(envelope, 'error'), false);
        const result = object(envelope.result); assert.equal(result.isError === true, Boolean(failure));
        assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
        const text = object(result.content[0]); assert.equal(text.type, 'text'); assert(typeof text.text === 'string');
        value = JSON.parse(text.text); assert.deepEqual(value, result.structuredContent);
      }
      if (failure) {
        const deniedPage = object(value);
        assert.equal(deniedPage.apiVersion, 1); assert.equal(deniedPage.success, false); assert.equal(deniedPage.code, failure);
        assert.equal(Object.hasOwn(deniedPage, 'fragment'), false); assert.equal(Object.hasOwn(deniedPage, 'document'), false);
        assert.deepEqual(deniedPage, { apiVersion: 1, success: false, code: failure });
        return;
      }
      const page = object(value) as unknown as DocumentReadPageV1;
      assert.equal(page.apiVersion, 1); assert.equal(page.complete, true); assert.equal(page.nextCursor, null);
      assert.equal(page.fragment, expected); assert.equal(page.byteOffset, 0); assert.equal(page.byteLength, Buffer.byteLength(expected));
      assert.equal(page.totalBytes, page.byteLength); assert.equal(page.document.documentId, target.documentId);
      assert.equal(page.document.lineageId, target.lineageId); assert.equal(page.document.workspaceId, h.workspaceId);
      assert.equal(page.document.path, target.filePath);
    };
    for (const actor of ['http', 'agent', 'mcp'] as const) {
      const { audit } = await withReadBindingAudit(() => readAdapterBinding(actor));
      assert.equal(audit.begins, 1); assert.equal(audit.commits, 1); assert.equal(audit.rollbacks, 0);
      assert.equal(audit.realm, baselineOnly ? 7 : 1); assert.equal(audit.relations, baselineOnly ? 6 : 0);
      assert.equal(audit.workspace, baselineOnly ? 6 : 0); assert.equal(audit.snapshots, baselineOnly ? 0 : 6);
      if (!baselineOnly) {
        assert.equal(audit.nativeRealm, nativeBaselineOnly ? 4 : 1);
        assert.equal(audit.nativeRelations, nativeBaselineOnly ? 3 : 0);
        assert.equal(audit.nativeFences, nativeBaselineOnly ? 3 : 0);
        assert.equal(audit.nativeSnapshots, nativeBaselineOnly ? 0 : 3);
      }
      assert.equal(audit.injected, false); observations.push({ actor, audit }); controls++;
      if (baselineOnly || nativeBaselineOnly) continue;
      for (const fault of ['workspace', 'search-path', 'shadow-relation', 'namespace', 'oversized'] as const) {
        const mutateAfter = fault === 'namespace' ? 2 : 5;
        console.log(JSON.stringify({ bindingFault: fault, actor, afterSnapshot: mutateAfter }));
        const failure = fault === 'oversized' ? 'DOCUMENT_TOO_LARGE' : 'DOCUMENT_SCOPE_CHANGED';
        const { audit: rejected } = await withReadBindingAudit(() => readAdapterBinding(actor, failure), async (client, query) => {
          const sql = (text: string, values?: unknown[]) => Reflect.apply(query, client, [text, values]);
          if (fault === 'workspace' || fault === 'oversized') await sql(
            `UPDATE "${schema}".canvas_workspaces SET root_relative_path=$1 WHERE id=$2`,
            [fault === 'oversized' ? 'x'.repeat(17000) : `${workspace[0].root_relative_path}-changed`, h.workspaceId]);
          if (fault === 'search-path') await sql(`SET LOCAL search_path="${schema}",pg_catalog,public`);
          if (fault === 'shadow-relation') await sql(`CREATE TEMP TABLE canvas_workspaces (LIKE "${schema}".canvas_workspaces INCLUDING ALL)`);
          if (fault === 'namespace') { await sql(`ALTER SCHEMA "${schema}" RENAME TO "${retired}"`); await sql(`CREATE SCHEMA "${schema}"`); }
        }, mutateAfter);
        assert.equal(rejected.begins, 1); assert.equal(rejected.commits, 0); assert.equal(rejected.rollbacks, 1);
        assert.equal(rejected.injected, true, 'A real held-transaction mutation follows the specified genuine binding reply.');
        // Namespace loss follows the post-lock check, before body access. It
        // fails the next binding query itself; late faults return a sixth real
        // snapshot after the intervening document witness has been checked.
        assert.equal(rejected.snapshots, fault === 'namespace' ? 2 : 6);
        assert.equal(rejected.failedSnapshots, fault === 'namespace' ? 1 : 0);
        assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM canvas_workspaces WHERE id=$1', [h.workspaceId])).rows, workspace);
        const realm = (await h.admin.query('SELECT to_regnamespace($1)::oid::text AS oid,to_regnamespace($2) IS NULL AS retired_absent', [schema, retired])).rows[0];
        assert.equal(realm.oid, schemaOid); assert.equal(realm.retired_absent, true);
        assert.equal((await h.admin.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid=$1 AND state LIKE 'idle in transaction%'", [rejected.pid])).rows[0].n, 0);
        assert.deepEqual(await h.snapshot(), before, 'Rollback preserves original identity, native bytes, metadata and projection rows.');
        denied++;
      }
      for (const fault of ['search-path', 'shadow-relation', 'mixed-fence'] as const) {
        console.log(JSON.stringify({ nativeFenceFault: fault, actor, afterSnapshot: 2 }));
        const { audit: rejected } = await withReadBindingAudit(() => readAdapterBinding(actor, 'DOCUMENT_SCOPE_CHANGED'), async (client, query) => {
          const sql = (text: string, values?: unknown[]) => Reflect.apply(query, client, [text, values]);
          if (fault === 'search-path') await sql(`SET LOCAL search_path="${schema}",pg_catalog,public`);
          if (fault === 'shadow-relation') await sql(`CREATE TEMP TABLE canvas_workspaces (LIKE "${schema}".canvas_workspaces INCLUDING ALL)`);
          if (fault === 'mixed-fence') {
            const result = await sql('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [collaborationAdmissionLockKey(h.workspaceId)]);
            assert.equal(result.rows[0].locked, true, 'Actually add the incompatible exclusive mode on the same held backend.');
          }
        }, 2, 'native');
        assert.equal(rejected.begins, 1); assert.equal(rejected.commits, 0); assert.equal(rejected.rollbacks, 1);
        assert.equal(rejected.injected, true); assert.equal(rejected.nativeSnapshots, 3);
        assert.equal(rejected.nativeRealm, 1); assert.equal(rejected.nativeRelations, 0); assert.equal(rejected.nativeFences, 0);
        assert.deepEqual((await h.admin.query('SELECT *,xmin::text AS xmin FROM canvas_workspaces WHERE id=$1', [h.workspaceId])).rows, workspace);
        assert.deepEqual(await h.snapshot(), before);
        assert.equal((await h.admin.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid=$1 AND state LIKE 'idle in transaction%'", [rejected.pid])).rows[0].n, 0);
        denied++;
      }
      await readAdapterBinding(actor); controls++;
    }
    assert.deepEqual(await h.snapshot(), before);
    const baseline = baselineOnly || nativeBaselineOnly;
    assert.equal(controls, baseline ? 3 : 6); assert.equal(denied, baseline ? 0 : 24);
    console.log(JSON.stringify({ documentReadBindingSnapshot: true, baselineOnly, nativeBaselineOnly, controls, denied,
      lateActualMutationCases: baseline ? 0 : 12, beforeBodyNamespaceCases: baseline ? 0 : 3, nativeFenceDenials: baseline ? 0 : 9,
      originalRowsAndBytesPreserved: true, observations }));
  });
}

let complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
await documentReadBindingSnapshotPostgresTest();
complete = true;
