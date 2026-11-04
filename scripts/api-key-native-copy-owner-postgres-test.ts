import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { ApiKeyWorkspaceCopyPrincipal, ApiKeyWorkspaceCopyPurpose } from '../app/lib/api-keys/document-read-principal';
import type { WorkspaceOperationCopyApiKeyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import type { WorkspaceOperationManagedCopyPlan } from '../app/lib/files/workspace-operation-managed-copy-plan';
import type { NativeCopyReceipt } from '../app/lib/collaboration/native-copy-persistence';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import { seedNativeCopyMixedSource } from './helpers/native-copy-mixed-source-fixture';

let stage = 'setup', groups = 0;
const code = (wanted: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === wanted);
async function main() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { BASE_URL: 'http://localhost', FILE_VERSION_CENTER_MODE: 'shadow', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source' });
    const { createApiIntegration, updateApiIntegration, rotateApiKey, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { authenticateApiKeyRequest } = await import('../app/lib/api-keys/authentication');
    const { withApiKeyWorkspaceCopyPrincipal: capture, withApiKeyWorkspaceCopyPrincipalOnConnection: phase } =
      await import('../app/lib/api-keys/document-read-principal');
    const { captureWorkspaceOperationCopyApiKeyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { previewWorkspaceNativeCopyOperation: preview, executeWorkspaceNativeCopyOperation: execute,
      recoverWorkspaceNativeCopyOperation: recover, captureNativeCopyApiKeyPhasePurpose } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { readApiKeyWorkspaceNativeCopyOperationStatus: status, readMcpWorkspaceNativeCopyOperationStatus: oauthStatus,
      assertNativeCopyStatusSessionOnConnection } = await import('../app/lib/files/workspace-operation-native-copy-status');
    const { captureExcalidrawCopyIntent, captureExcalidrawCopyBirthReceipt } = await import('../app/lib/excalidraw-collaboration/copy-data');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks: links } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const pool = getPostgresRuntimeQueryable() as unknown as Pool, staging = new WorkspaceOperationStaging(), journal = new WorkspaceOperationJournal();
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaceIds = [h.source.workspaceId, h.destination.workspaceId], actions = ['copy', 'status', 'recover'] as const;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Native Copy fixture integration', workspaceIds,
      actions: [...actions], expiresAt: Date.now() + 3_600_000 });
    let key = issued.key, revision = 1, credentialId = issued.credential.id;
    const authenticate = () => authenticateApiKeyRequest(new Request('http://localhost/api/files/copy', { headers: { 'X-Canvas-API-Key': key } }));
    let credential = await authenticate();
    const selected = (purpose: ApiKeyWorkspaceCopyPurpose, source: 'request' | 'mcp' = 'request') =>
      ({ sourceWorkspaceId: workspaceIds[0], destinationWorkspaceId: workspaceIds[1], purpose, source });
    const origin = async (principal: ApiKeyWorkspaceCopyPrincipal, purpose: ApiKeyWorkspaceCopyPurpose) => {
      const client = await pool.connect();
      const database: SqlConnection = { get: async (s, v) => (await client.query(s, v)).rows[0], all: async (s, v) => (await client.query(s, v)).rows,
        run: async (s, v) => ({ changes: (await client.query(s, v)).rowCount ?? 0 }), close: () => assert.fail('Caller owns B.') };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        const result = await phase(database, principal, purpose, async current => captureWorkspaceOperationCopyApiKeyOrigin({ userId: current.userId,
          integrationId: current.integrationId, instanceId: current.instanceId, credentialId: current.credentialId, entryPoint: current.entryPoint,
          sourceWorkspace: current.sourceWorkspace, destinationWorkspace: current.destinationWorkspace }));
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    type Job = Awaited<ReturnType<typeof seedNativeCopyMixedSource>> & { plan?: WorkspaceOperationManagedCopyPlan; original?: WorkspaceOperationCopyApiKeyOrigin };
    const seed = () => seedNativeCopyMixedSource(h) as Promise<Job>;
    const invoke = async (job: Job) => {
      job.plan = await capture(credential, selected('copy_preview'), async apiKeyPrincipal => {
        const current = await origin(apiKeyPrincipal, 'copy_preview');
        const plan = await preview({ origin: current, apiKeyPrincipal, selections: job.selections }); assert.equal(plan.version, 3);
        return plan as WorkspaceOperationManagedCopyPlan;
      });
      return capture(credential, selected('copy_apply'), async apiKeyPrincipal => {
        const current = await origin(apiKeyPrincipal, 'copy_apply'); job.original = current;
        return execute({ origin: current, apiKeyPrincipal, operationId: job.operationId, expectedPlanId: job.plan!.planId, selections: job.selections });
      });
    };
    const repeat = (job: Job, purpose: 'copy_apply' | 'copy_recover' = 'copy_apply', source: 'request' | 'mcp' = 'request') =>
      capture(credential, selected(purpose, source), async apiKeyPrincipal => {
        const current = await origin(apiKeyPrincipal, purpose);
        return (purpose === 'copy_recover' ? recover : execute)({ origin: current, apiKeyPrincipal, operationId: job.operationId,
          expectedPlanId: job.plan!.planId, selections: job.selections });
      });
    const readStatus = (job: Job) => capture(credential, selected('copy_status'), async apiKeyPrincipal =>
      status({ origin: await origin(apiKeyPrincipal, 'copy_status'), apiKeyPrincipal, operationId: job.operationId }));
    const nativeLedger = async (id: string) => (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [id])).rows[0];
    const sceneLedger = async (id: string) => (await h.admin.query('SELECT *,xmin::text AS xmin FROM collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [id])).rows[0];
    const domainSnapshot = async () => {
      const names = (await h.admin.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
        AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)' OR c.relname='file_revisions') ORDER BY c.relname`, [h.schema])).rows;
      assert(names.length > 11 && names.length < 513); const rows: Record<string, unknown> = {};
      for (const { relname } of names) {
        assert(/^[a-z_]+$/u.test(relname));
        rows[relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${relname}" t ORDER BY to_jsonb(t)::text,xmin::text LIMIT 10001`)).rows;
        assert((rows[relname] as unknown[]).length <= 10000);
      }
      return rows;
    };
    const complete = async (job: Job, result: Awaited<ReturnType<typeof invoke>>, known: boolean) => {
      assert.equal(result.execution.status, 'complete', String(result.execution.errorCode)); assert.equal(result.alreadyKnown, known);
      assert.deepEqual(result.copied, [job.destinationPath]);
      const native = await nativeLedger(job.operationId), scene = await sceneLedger(job.operationId); assert(native && scene?.birth_json);
      assert.equal(native.actor_user_id, 'member'); assert.equal(native.actor_session_id, null); assert.equal(native.publication_status, 'published');
      const intent = captureExcalidrawCopyIntent(scene.intent_json), birth = captureExcalidrawCopyBirthReceipt(scene.birth_json);
      assert.deepEqual(intent.origin, job.original); assert.deepEqual(birth.intent, intent);
      const operation = await journal.get(job.operationId); assert.equal(operation?.status, 'completed');
      assert.deepEqual(JSON.parse(operation!.requestJson).origin, job.original); assert(operation!.steps.every(step => step.status === 'applied'));
      const receipt = native.private_result as Omit<NativeCopyReceipt, 'publicationStatus'>; assert.equal(receipt.documents.length, 2);
      for (const clone of receipt.documents) {
        const before = await load(h.connection, clone.source.documentId), after = await load(h.connection, clone.clone.documentId); assert(before && after);
        assert.notEqual(before.documentId, after.documentId); assert.equal(after.workspaceId, h.destination.workspaceId);
        const oldClients = Y.decodeStateVector(before.stateVector), newClients = Y.decodeStateVector(after.stateVector);
        assert([...newClients.keys()].every(client => !oldClients.has(client)));
        const prior = links(before), actual = links(after); assert(prior.coverage.complete && actual.coverage.complete);
        const recipes = job.plan!.nativePathPlan.mutations.filter(item => item.source.documentId === before.documentId && item.sourcePathAfter === after.path);
        const literal = (link: typeof actual.links[number]) => String(link.ref.kind === 'link-mark' ? link.ref.expected.href : link.ref.expected);
        assert.deepEqual(actual.links.map(literal), prior.links.map(link => recipes.find(recipe => recipe.linkId === link.id)?.nextValue ?? literal(link)));
      }
      assert.equal(intent.documents.length, 1);
      const copiedScene = (await h.admin.query('SELECT * FROM collaboration_excalidraw_states WHERE document_id=$1', [intent.documents[0].documentId])).rows[0];
      assert.equal(copiedScene.canonical_hash, job.latest.state.canonicalHash); assert(copiedScene.elements_json.some((item: { id: string }) => item.id === 'latest'));
      assert.deepEqual(await fs.readFile(job.blob(h.destination.workspaceId)), job.png);
      assert.deepEqual(await fs.readFile(path.join(h.destination.rootPath, job.destinationPath, 'manual.pdf')), job.pdf);
      assert((await fs.stat(path.join(h.destination.rootPath, job.destinationPath, 'empty'))).isDirectory());
      assert.deepEqual(await job.sourceSnapshot(), job.sourceBefore, 'Read-only source, revision history, Yjs, Scene, assets and bytes stay unchanged.');
      assert.equal(await staging.loadManagedCopyByOperationId(job.operationId), null);
      return { native, scene, intent, receipt };
    };
    const check = async (name: string, consume: () => Promise<void>) => { stage = name; await consume(); groups++; console.log(`API-key native Copy passed: ${name}`); };
    let baseline!: Job;
    await check('actual key Copy publishes current mixed native/Scene/assets, binary and empty directory with fresh IDs and unchanged read-only source', async () => {
      baseline = await seed(); await complete(baseline, await invoke(baseline), false);
    });
    await check('same-workspace native Copy publishes a distinct cohort and preserves the writable source documents and assets', async () => {
      const native = (await nativeLedger(baseline.operationId)).private_result as Omit<NativeCopyReceipt, 'publicationStatus'>;
      const intent = captureExcalidrawCopyIntent((await sceneLedger(baseline.operationId)).intent_json);
      const ids = [...native.documents.map(item => item.clone.documentId), ...intent.documents.map(item => item.documentId)];
      const source = async () => ({ states: (await h.admin.query(`SELECT 'native' AS kind,document_id AS id,to_jsonb(s)::text AS body,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=ANY($1::text[])
        UNION ALL SELECT 'scene',document_id,to_jsonb(s)::text,xmin::text FROM collaboration_excalidraw_states s WHERE document_id=ANY($1::text[]) ORDER BY kind,id`, [ids])).rows,
      assets: (await h.admin.query('SELECT to_jsonb(a)::text AS body,xmin::text AS xmin FROM collaboration_excalidraw_assets a WHERE workspace_id=$1 AND file_id=$2', [workspaceIds[1], baseline.assetId])).rows });
      const before = await source(), destinationPath = `same-workspace-${randomUUID()}`;
      const job: Job = { ...baseline, operationId: randomUUID(), destinationPath, selections: [{ sourcePath: baseline.destinationPath, destinationPath }], plan: undefined, original: undefined };
      const same = (purpose: ApiKeyWorkspaceCopyPurpose) => ({ ...selected(purpose), sourceWorkspaceId: workspaceIds[1] });
      job.plan = await capture(credential, same('copy_preview'), async apiKeyPrincipal => {
        const current = await origin(apiKeyPrincipal, 'copy_preview');
        const plan = await preview({ origin: current, apiKeyPrincipal, selections: job.selections }); assert.equal(plan.version, 3); return plan as WorkspaceOperationManagedCopyPlan;
      });
      const result = await capture(credential, same('copy_apply'), async apiKeyPrincipal => {
        job.original = await origin(apiKeyPrincipal, 'copy_apply');
        return execute({ origin: job.original, apiKeyPrincipal, operationId: job.operationId, expectedPlanId: job.plan!.planId, selections: job.selections });
      });
      await complete(job, result, false); assert.deepEqual(await source(), before);
    });
    await check('rotation and another entry point retain original provenance and all completed domain rows and xmins', async () => {
      const before = await domainSnapshot(), oldCredential = credential;
      const rotated = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      await complete(baseline, await repeat(baseline, 'copy_apply', 'mcp'), true);
      assert.deepEqual(await domainSnapshot(), before); assert.notEqual(credentialId, baseline.original!.credentialId);
      await assert.rejects(capture(oldCredential, selected('copy_apply'), async apiKeyPrincipal => execute({ origin: baseline.original!, apiKeyPrincipal,
        operationId: baseline.operationId, expectedPlanId: baseline.plan!.planId, selections: baseline.selections })), code('API_KEY_INVALID'));
    });
    await check('pure current-key status confirms historical receipts without domain DML, DDL, notifications or row changes', async () => {
      const before = await domainSnapshot(), writes: string[] = []; let statements = 0;
      const result = await h.withProbe(async event => {
        statements++;
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|pg_notify\s*\()/iu.test(event.text)) writes.push(event.text);
      }, () => readStatus(baseline));
      assert(statements > 0); assert.deepEqual(writes, []); assert.equal(result.completion.status, 'confirmed'); assert.equal(result.journal.status, 'completed');
      assert.deepEqual(await domainSnapshot(), before);
    });
    await check('fixed purposes, mixed transports and forged or expired handles reject before any native owner checkout', async () => {
      let acquisitions = 0;
      for (const purpose of ['copy_preview', 'copy_status', 'copy_recover'] as const) await assert.rejects(capture(credential, selected(purpose), async apiKeyPrincipal => {
        const acquired = () => { acquisitions++; }; pool.on('acquire', acquired);
        try { await execute({ origin: baseline.original!, apiKeyPrincipal, operationId: baseline.operationId, selections: baseline.selections }); }
        finally { pool.off('acquire', acquired); }
      }), code('API_KEY_PRINCIPAL_SCOPE_CHANGED'));
      assert.equal(acquisitions, 0);
      await assert.rejects(execute({ origin: baseline.original!, apiKeyPrincipal: {} as ApiKeyWorkspaceCopyPrincipal,
        operationId: baseline.operationId, selections: baseline.selections }), code('API_KEY_PRINCIPAL_REQUIRED'));
      let inactive: ApiKeyWorkspaceCopyPrincipal | undefined;
      await capture(credential, selected('copy_apply'), async principal => { inactive = principal; }); assert(inactive);
      await assert.rejects(execute({ origin: baseline.original!, apiKeyPrincipal: inactive,
        operationId: baseline.operationId, selections: baseline.selections }), code('API_KEY_PRINCIPAL_REQUIRED'));
      await capture(credential, selected('copy_apply'), async apiKeyPrincipal => {
        assert.throws(() => captureNativeCopyApiKeyPhasePurpose(apiKeyPrincipal, baseline.original!), code('NATIVE_COPY_OWNER_REQUIRED'));
        await assert.rejects(execute({ origin: baseline.original!, apiKeyPrincipal, mcpPrincipal: {} as never,
          operationId: baseline.operationId, selections: baseline.selections }), code('NATIVE_COPY_INVALID_REQUEST'));
        let getter = 0;
        await assert.rejects(execute({ origin: baseline.original!, get apiKeyPrincipal() { getter++; return apiKeyPrincipal; },
          operationId: baseline.operationId, selections: baseline.selections }), code('NATIVE_COPY_INVALID_REQUEST'));
        assert.equal(getter, 0);
      });
      await capture(credential, selected('copy_status'), async apiKeyPrincipal => {
        await assert.rejects(oauthStatus({ origin: baseline.original!, apiKeyPrincipal, operationId: baseline.operationId } as never), code('NATIVE_COPY_STATUS_INVALID'));
        await assert.rejects(assertNativeCopyStatusSessionOnConnection(h.connection, baseline.original!), code('NATIVE_COPY_STATUS_REQUIRED'));
      });
    });
    await check('lost actual B1 COMMIT acknowledgement retains original IDs and durable Stage for explicit recovery after rotation', async () => {
      const job = await seed(); let b1: MetadataSqlEvent['client'] | undefined, fired = false;
      const interrupted = await h.withProbe(async event => {
        if (/^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text) && event.values.includes(job.operationId)) b1 = event.client;
        if (!fired && b1 === event.client && /^\s*COMMIT\s*$/iu.test(event.text)) {
          fired = true; assert.equal((await nativeLedger(job.operationId)).publication_status, 'native_committed');
          assert.equal((await sceneLedger(job.operationId)).birth_json, null);
          throw Object.assign(new Error('Fixture lost actual durable B1 acknowledgement.'), { code: 'EIO' });
        }
      }, () => invoke(job));
      assert(fired); assert.equal(interrupted.execution.status, 'needs_recovery'); assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED');
      const retained = await staging.loadManagedCopyByOperationId(job.operationId); assert(retained);
      assert.deepEqual(retained.origin, job.original); assert(!JSON.stringify(retained).includes(key));
      assert(!JSON.stringify(retained).includes('apiKeyPrincipal'));
      const ids = (await nativeLedger(job.operationId)).private_result.documents;
      const pending = await domainSnapshot(); const observed = await readStatus(job);
      assert.equal(observed.completion.status, 'not_confirmed'); assert.deepEqual(await domainSnapshot(), pending);
      assert.equal((await staging.loadManagedCopyByOperationId(job.operationId))?.payloadSha256, retained.payloadSha256);
      const rotated = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
      key = rotated.key; credentialId = rotated.credential.id; credential = await authenticate();
      const completed = await complete(job, await repeat(job, 'copy_recover', 'mcp'), true);
      assert.deepEqual(completed.receipt.documents, ids);
    });
    await check('actual destination ACL withdrawal after B1 prevents Scene/asset publication until fresh explicit recovery', async () => {
      const job = await seed(); let b1: MetadataSqlEvent['client'] | undefined, fired = false;
      await assert.rejects(h.withProbe(async event => {
        if (/^\s*INSERT INTO collaboration_excalidraw_copy_receipts\b/iu.test(event.text) && event.values.includes(job.operationId)) b1 = event.client;
        if (!fired && b1 === event.client && /^\s*COMMIT\s*$/iu.test(event.text)) {
          fired = true; assert.equal((await h.admin.query("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaceIds[1]])).rowCount, 1);
        }
      }, () => invoke(job)), code('API_KEY_ACCESS_DENIED'));
      assert(fired); assert.equal((await sceneLedger(job.operationId)).birth_json, null); assert(await staging.loadManagedCopyByOperationId(job.operationId));
      await assert.rejects(readStatus(job), code('API_KEY_ACCESS_DENIED'));
      await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [workspaceIds[1]]);
      await complete(job, await repeat(job, 'copy_recover'), true);
    });
    await check('unknown Copy status and recovery return 404 without preparing an operation or durable Stage', async () => {
      const before = await domainSnapshot(), unknown = randomUUID();
      await assert.rejects(capture(credential, selected('copy_recover'), async apiKeyPrincipal => recover({
        origin: await origin(apiKeyPrincipal, 'copy_recover'), apiKeyPrincipal, operationId: unknown,
        expectedPlanId: baseline.plan!.planId, selections: baseline.selections })), code('NATIVE_COPY_OPERATION_NOT_FOUND'));
      await assert.rejects(capture(credential, selected('copy_status'), async apiKeyPrincipal => status({
        origin: await origin(apiKeyPrincipal, 'copy_status'), apiKeyPrincipal, operationId: unknown })), code('NATIVE_COPY_STATUS_NOT_FOUND'));
      assert.deepEqual(await domainSnapshot(), before); assert.equal(await staging.loadManagedCopyByOperationId(unknown), null);
    });
    await check('another integration, withdrawn status action and actual revocation cannot read or resume original Copy', async () => {
      const other = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Different native Copy owner', workspaceIds,
        actions: [...actions], expiresAt: Date.now() + 3_600_000 });
      const otherCredential = await authenticateApiKeyRequest(new Request('http://localhost/api/files/copy', { headers: { 'X-Canvas-API-Key': other.key } }));
      await assert.rejects(capture(otherCredential, selected('copy_status'), async apiKeyPrincipal => status({ origin: await origin(apiKeyPrincipal, 'copy_status'),
        apiKeyPrincipal, operationId: baseline.operationId })), code('NATIVE_COPY_STATUS_NOT_FOUND'));
      await revokeApiKey(manager, other.integration.id, { expectedRevision: 1, credentialId: other.credential.id });
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds, actions: ['copy'] });
      await assert.rejects(readStatus(baseline), code('API_KEY_ACCESS_DENIED'));
      await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds, actions: [...actions] });
      await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId });
      await assert.rejects(readStatus(baseline), code('API_KEY_INVALID')); await assert.rejects(repeat(baseline, 'copy_recover'), code('API_KEY_INVALID'));
    });
  });
  console.log(`API-key native Copy: ${groups} genuine PostgreSQL/FD/owner/status/recovery groups passed. Public adapters and installed SDK Copy remain separate.`);
}
main().catch(error => { console.error(JSON.stringify({ suite: 'api-key-native-copy-owner', stage, error: error instanceof Error ? error.name : 'UnknownError',
  code: error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string' ? Reflect.get(error, 'code') : undefined,
  ...(error instanceof assert.AssertionError ? { actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : {}) })); process.exitCode = 1; });
