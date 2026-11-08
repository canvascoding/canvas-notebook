import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture, type MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import { withInstalledApiKeySdkMcpFixture } from './helpers/installed-api-key-sdk-mcp-fixture';

type Kind = 'move' | 'delete';
type Profile = 'native' | 'native-only' | 'physical' | 'cohort';
type Phase = 'baseline' | 'http' | 'claim' | 'completion';
type Native = { documentId: string; sourcePath: string; state: Buffer; vector: Buffer; generation: number };
type Job = { name: string; kind: Kind; profile: Profile; phase: Phase; sourcePath: string; destinationPath: string; operationId: string;
  planId: string; batchId?: string; native: Native[]; physical: { sourcePath: string; bytes: Buffer }[];
  incoming?: { documentId: string; sequence: number }; rows?: unknown; completionRows?: unknown; recoveryRows?: unknown };
let stage = 'setup';
async function main() {
  const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL; assert(python && wheel);
  await withNativeCopyMetadataOwnerFixture(async h => {
    Object.assign(process.env, { BASE_URL: 'http://localhost', FILE_VERSION_CENTER_MODE: 'off', CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'move_knowledge_source,delete_knowledge_source,read_knowledge_source' });
    assert.equal((await import('../app/lib/file-version-center/policy-v1')).resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).capture, false);
    assert.equal((await import('../app/lib/files/workspace-file-undo-policy')).WORKSPACE_FILE_UNDO_ENABLED, false);
    await h.admin.query("UPDATE organization_user_permissions SET can_delete_team_files=1 WHERE organization_id='principal-org' AND user_id='member'");
    await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [h.source.workspaceId]);
    const { createApiIntegration, rotateApiKey, updateApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const manager = new Headers((await h.request()).headers); manager.set('Origin', 'http://localhost');
    const workspaceId = h.source.workspaceId, actions = ['read', 'move', 'delete', 'status', 'recover'] as const;
    const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Installed native path SDK', workspaceIds: [workspaceId],
      actions: [...actions], expiresAt: Date.now() + 3_600_000 });
    const privateValues = [issued.key, h.dataRoot];
    let revision = issued.integration.revision, credentialId = issued.credential.id;
    const managerToken = randomBytes(32).toString('hex');
    await h.admin.query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('sdk-path-manager',$1,'member',$2,$3,$3)",
      [managerToken, Date.now() + 3_600_000, Date.now()]);
    const store = new WorkspaceOperationBatchStore(), jobs: Job[] = [];
    const destination = (j: Job, sourcePath: string) => `${j.destinationPath}${sourcePath.slice(j.sourcePath.length)}`;
    const snapshot = async () => {
      const tables = (await h.admin.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND c.relname ~ '^(collaboration_|file_collaboration_|workspace_|file_revision)' ORDER BY c.relname`, [h.schema])).rows;
      const rows: Record<string, unknown> = {};
      for (const { relname } of tables) { assert(/^[a-z][a-z0-9_]*$/u.test(relname));
        rows[relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS data,xmin::text AS row_xmin FROM "${h.schema}"."${relname}" t ORDER BY data,row_xmin`)).rows; }
      return rows;
    };
    const incoming = async (j: Job) => {
      const targets = [...new Set([...j.native.map(n => n.sourcePath), ...j.physical.map(p => p.sourcePath)])];
      const value = await h.upload(`sdk-path-incoming-${randomUUID()}.md`, Buffer.from(targets.map(target => `[Preserve SDK label](${target})`).join(' ') + '\n'));
      const state = await loadCollaborationStateOnConnection(h.connection, value.documentId); assert(state);
      j.incoming = { documentId: value.documentId, sequence: state.documentSequence };
    };
    const seed = async (kind: Kind, profile: Profile, phase: Phase): Promise<Job> => {
      const root = `sdk-path-${randomUUID()}`, sourcePath = profile === 'cohort' ? root : `${root}.${profile === 'physical' ? 'pdf' : 'md'}`;
      const j: Job = { name: `${kind}_${profile.replace('-', '_')}_${phase}`, kind, profile, phase, sourcePath,
        destinationPath: `sdk-path-moved-${randomUUID()}${profile === 'cohort' ? '' : path.posix.extname(sourcePath)}`,
        operationId: randomUUID(), planId: '', native: [], physical: [] };
      if (profile === 'cohort') await fs.mkdir(path.join(h.source.rootPath, root), { mode: 0o700 });
      if (profile !== 'physical') {
        const paths = profile === 'cohort' ? [`${root}/note.md`, `${root}/virtual.md`] : [sourcePath];
        for (const selected of paths) {
          const bytes = Buffer.from('# SDK native original\n\nKeep every native state byte.\n'), uploaded = await h.upload(selected, bytes);
          const state = await loadCollaborationStateOnConnection(h.connection, uploaded.documentId); assert(state);
          j.native.push({ documentId: uploaded.documentId, sourcePath: selected, state: Buffer.from(state.yjsState), vector: Buffer.from(state.stateVector), generation: state.lifecycleGeneration });
          if (profile === 'native-only' || selected.endsWith('/virtual.md')) await fs.unlink(path.join(h.source.rootPath, selected));
          else j.physical.push({ sourcePath: selected, bytes });
        }
      }
      if (profile === 'physical' || profile === 'cohort') {
        const paths = profile === 'physical' ? [sourcePath] : [`${root}/paper.pdf`, `${root}/photo.png`];
        for (const selected of paths) {
          const bytes = Buffer.from(selected.endsWith('.pdf') ? '%PDF-1.7\nSDK exact original PDF bytes\n' : 'SDK exact original PNG bytes\n');
          await fs.writeFile(path.join(h.source.rootPath, selected), bytes, { flag: 'wx', mode: 0o600 }); j.physical.push({ sourcePath: selected, bytes });
        }
      }
      await incoming(j); jobs.push(j); return j;
    };
    const baselineMove = await seed('move', 'native', 'baseline'); baselineMove.name = 'move_native';
    for (const profile of ['native-only', 'physical', 'cohort'] as const) await seed('move', profile, 'baseline');
    // The same caller ID is legal in two separately authorized action namespaces.
    // Delete follows this actual Move; it must not adopt its journal or receipts.
    const baselineDelete: Job = { ...baselineMove, name: 'delete_native', kind: 'delete', sourcePath: baselineMove.destinationPath,
      destinationPath: '', native: baselineMove.native.map(n => ({ ...n, sourcePath: destination(baselineMove, n.sourcePath) })),
      physical: baselineMove.physical.map(p => ({ ...p, sourcePath: destination(baselineMove, p.sourcePath) })), incoming: undefined };
    jobs.push(baselineDelete);
    for (const profile of ['native-only', 'physical', 'cohort'] as const) await seed('delete', profile, 'baseline');
    for (const phase of ['http', 'claim', 'completion'] as const) for (const kind of ['move', 'delete'] as const) await seed(kind, 'native', phase);
    assert.equal(jobs.length, 14);
    const byName = new Map(jobs.map(j => [j.name, j])); assert.equal(byName.size, jobs.length);
    const count = async () => (await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_operation_batches')).rows[0].n as number;
    const initialCount = await count();
    const receiptRows = async (j: Job) => {
      assert(j.batchId); const table = j.kind === 'move' ? 'workspace_file_operation_move_receipts' : 'workspace_file_operation_delete_receipts';
      return (await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1`, [j.batchId])).rows;
    };
    const verify = async (j: Job) => {
      assert(j.batchId); const batch = await store.get(j.batchId); assert(batch?.authorization.mode === 'api-key');
      assert.equal(batch.status, 'applied'); assert.equal(batch.planId, j.planId); assert.equal(batch.authorization.kind, j.kind);
      assert.equal(batch.authorization.actorSessionId, null); assert.equal(batch.authorization.credentialId, issued.credential.id);
      assert.equal(batch.authorization.integrationId, issued.integration.id); assert.equal(JSON.stringify(batch.authorization).includes(issued.key), false);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM agents WHERE agent_id=$1', [batch.authorization.actorId])).rows[0].n, 0);
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM pi_sessions WHERE agent_id=$1', [batch.authorization.actorId])).rows[0].n, 0);
      for (const n of j.native) {
        const row = (await h.admin.query('SELECT path,status,yjs_state,state_vector,lifecycle_generation FROM collaboration_yjs_states WHERE document_id=$1', [n.documentId])).rows[0]; assert(row);
        assert.equal(row.path, j.kind === 'move' ? destination(j, n.sourcePath) : n.sourcePath); assert.equal(row.status, j.kind === 'move' ? 'active' : 'archived');
        assert.deepEqual(row.yjs_state, n.state); assert.deepEqual(row.state_vector, n.vector); assert.equal(Number(row.lifecycle_generation), n.generation + (j.kind === 'delete' ? 1 : 0));
      }
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, j.sourcePath)), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
      if (j.kind === 'move') {
        for (const p of j.physical) assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, destination(j, p.sourcePath))), p.bytes);
        for (const n of j.native.filter(n => !j.physical.some(p => p.sourcePath === n.sourcePath)))
          await assert.rejects(fs.lstat(path.join(h.source.rootPath, destination(j, n.sourcePath))), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
      } else {
        const trash = (await h.admin.query('SELECT status,trash_relative_path FROM workspace_trash_entries WHERE original_path=$1', [j.sourcePath])).rows;
        assert.equal(trash.length, 1); assert.equal(trash[0].status, 'trashed');
        for (const p of j.physical) {
          const relative = j.profile === 'cohort' ? p.sourcePath.slice(j.sourcePath.length + 1) : '';
          assert.deepEqual(await fs.readFile(path.join(h.dataRoot, trash[0].trash_relative_path, relative)), p.bytes);
        }
      }
      if (j.profile === 'physical') {
        const selected = j.kind === 'move' ? j.destinationPath : j.sourcePath;
        assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2', [workspaceId, selected])).rows[0].n, 0);
      }
      assert(j.incoming); const state = await loadCollaborationStateOnConnection(h.connection, j.incoming.documentId); assert(state);
      assert.equal(state.documentSequence, j.incoming.sequence + 1);
      const links = inspectPersistedDocumentLinks(state).links;
      for (const selected of [...new Set([...j.native.map(n => n.sourcePath), ...j.physical.map(p => p.sourcePath)])]) {
        assert.equal(links.some(link => link.targetPathText === selected), false);
        if (j.kind === 'move') assert(links.some(link => link.targetPathText === destination(j, selected)));
      }
    };
    let armedHttp: Job | undefined, armedCommit: Job | undefined, commitClient: MetadataSqlEvent['client'] | undefined, commitRows: unknown;
    const httpDrops = new Set<string>(), commitLosses = new Set<string>(), calls = new Map<string, number>();
    const transportOutcomes: Record<string, string> = {};
    const recoveryBusy = new Map<string, number>();
    let contentionHeld = false, controlledContentionVerified = false;
    let finalRows: unknown;
    const selectedJob = (value: Record<string, unknown>) => {
      assert(typeof value.name === 'string'); const j = byName.get(value.name); assert(j); return j;
    };
    const readPlan = (j: Job, value: Record<string, unknown>) => { assert(typeof value.planId === 'string'); assert.match(value.planId, /^[a-f0-9]{64}$/u); j.planId = value.planId; };
    let probe: Awaited<ReturnType<typeof withInstalledApiKeySdkMcpFixture>>;
    try { probe = await h.withProbe(async event => {
      const j = armedCommit; if (!j) return;
      const table = j.phase === 'claim' ? 'workspace_file_operation_batches' : `workspace_file_operation_${j.kind}_receipts`;
      if (!commitClient && /^\s*INSERT\s+INTO\b/iu.test(event.text) && event.text.includes(table)) {
        assert.equal(event.result.command, 'INSERT'); assert.equal(event.result.rowCount, 1); commitClient = event.client;
        j.batchId = String(event.values[0]); assert.match(j.batchId, /^[a-f0-9]{64}$/u);
        commitRows = (await event.raw(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1`, [j.batchId])).rows;
        assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE batch_id=$1`, [j.batchId])).rows[0].n, 0);
      }
      if (event.client === commitClient && /^\s*COMMIT\s*$/iu.test(event.text) && !commitLosses.has(j.name)) {
        assert.equal(event.result.command, 'COMMIT'); assert.deepEqual((await h.admin.query(`SELECT to_jsonb(t)::text AS body,xmin::text AS xmin FROM "${table}" t WHERE batch_id=$1`, [j.batchId])).rows, commitRows);
        commitLosses.add(j.name); armedCommit = undefined; throw Object.assign(new Error('Lost acknowledgement after independently visible actual COMMIT.'), { code: 'FIXTURE_INSTALLED_KEY_PATH_COMMIT_ACK_LOST' });
      }
    }, () => withInstalledApiKeySdkMcpFixture({ python, wheel, probe: path.resolve('scripts/helpers/python_sdk_api_key_path_probe.py'), key: issued.key,
      config: { workspaceId, jobs: jobs.map(j => ({ name: j.name, kind: j.kind, phase: j.phase, sourcePath: j.sourcePath,
        destinationPath: j.destinationPath, operationId: j.operationId, ...(j.native[0] ? { documentId: j.native[0].documentId,
          destinationNativePath: destination(j, j.native[0].sourcePath) } : {}) })) },
      exchange: async (rpc, response, body) => {
        assert.equal(response.headers.get('www-authenticate'), null);
        for (const value of privateValues) assert.equal(body.includes(Buffer.from(value)), false);
        if (rpc?.method !== 'tools/call' || !['move_knowledge_source', 'delete_knowledge_source'].includes(rpc.params?.name ?? '')) return;
        const args = rpc.params?.arguments, id = args?.operation_id, action = args?.action;
        if (typeof id === 'string' && typeof action === 'string') {
          const key = `${rpc.params?.name}:${id}:${action}`; calls.set(key, (calls.get(key) ?? 0) + 1);
        }
        const value = response.status === 200 ? JSON.parse(body.toString()).result?.structuredContent : undefined;
        if (value?.operation?.batchId) {
          const j = jobs.find(item => `${item.kind}_knowledge_source` === rpc.params?.name && item.operationId === id); assert(j);
          j.batchId ??= value.operation.batchId; assert.equal(j.batchId, value.operation.batchId);
        }
        const j = armedHttp;
        if (j && rpc.params?.name === `${j.kind}_knowledge_source` && id === j.operationId && action === 'apply') {
          assert.equal(response.status, 200); assert.equal(value.operation.completion.status, 'confirmed'); await verify(j);
          j.rows = await snapshot(); httpDrops.add(j.name); armedHttp = undefined; return 'drop';
        }
      },
      event: async (value, send) => {
        stage = value.event;
        if (stage === 'applied') {
          const j = selectedJob(value); readPlan(j, value); await verify(j);
          if (j === baselineMove) await incoming(baselineDelete);
          j.rows = await snapshot(); send({ ready: true });
        } else if (stage === 'history_checked') {
          const j = selectedJob(value); assert.deepEqual(await snapshot(), j.rows); send({ ready: true });
        } else if (stage === 'arm_http') {
          const j = selectedJob(value); readPlan(j, value); assert(!armedHttp); armedHttp = j; send({ ready: true });
        } else if (stage === 'http_observed') {
          const j = selectedJob(value); assert(httpDrops.has(j.name)); assert.equal(value.retainedOperationId, j.operationId); assert.equal(value.safeToAutoRetry, false);
          assert(value.transportOutcome === 'unknown_result' || value.transportOutcome === 'cancelled_after_http_failure'); transportOutcomes[j.name] = value.transportOutcome;
          assert.equal(calls.get(`${j.kind}_knowledge_source:${j.operationId}:apply`), 1); assert.equal(calls.get(`${j.kind}_knowledge_source:${j.operationId}:status`), undefined);
          assert.deepEqual(await snapshot(), j.rows); send({ ready: true });
        } else if (stage === 'http_recovered') {
          const j = selectedJob(value); assert.deepEqual(await snapshot(), j.rows); assert.equal(calls.get(`${j.kind}_knowledge_source:${j.operationId}:apply`), 1); send({ ready: true });
        } else if (stage === 'arm_commit') {
          const j = selectedJob(value); readPlan(j, value); assert(!armedCommit); armedCommit = j; commitClient = undefined; commitRows = undefined; send({ ready: true });
        } else if (stage === 'commit_observed') {
          const j = selectedJob(value); assert(commitLosses.has(j.name)); assert.equal(calls.get(`${j.kind}_knowledge_source:${j.operationId}:apply`), 1);
          assert.equal(calls.get(`${j.kind}_knowledge_source:${j.operationId}:status`), undefined); j.rows = await snapshot(); send({ ready: true });
        } else if (stage === 'commit_status') {
          const j = selectedJob(value); assert.deepEqual(await snapshot(), j.rows);
          if (j.phase === 'claim') assert.equal((await h.admin.query("UPDATE workspace_file_operation_batches SET lease_expires_at=1 WHERE batch_id=$1 AND status='applying' RETURNING batch_id", [j.batchId])).rowCount, 1);
          else j.completionRows = await receiptRows(j);
          j.recoveryRows = await snapshot();
          // Real contention, not a fabricated MCP result: maintenance also uses
          // SHARE UPDATE EXCLUSIVE, which conflicts with the claim's NOWAIT lock.
          if (j.name === 'delete_native_claim') {
            await h.admin.query('BEGIN'); contentionHeld = true;
            await h.admin.query("SET LOCAL lock_timeout='2000ms'");
            await h.admin.query('LOCK TABLE workspace_file_operation_batches IN SHARE UPDATE EXCLUSIVE MODE');
          }
          send({ ready: true });
        } else if (stage === 'recover_busy' || stage === 'recover_busy_status') {
          const j = selectedJob(value); assert.equal(j.phase, 'claim');
          assert.deepEqual(await snapshot(), j.recoveryRows);
          for (const file of j.physical) assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, file.sourcePath)), file.bytes);
          assert.equal(calls.get(`${j.kind}_knowledge_source:${j.operationId}:apply`), 1);
          if (stage === 'recover_busy') {
            const attempt = (recoveryBusy.get(j.name) ?? 0) + 1;
            assert.equal(value.attempt, attempt); assert(attempt <= 3); recoveryBusy.set(j.name, attempt);
            assert.equal(calls.get(`${j.kind}_knowledge_source:${j.operationId}:recover`), attempt);
            if (contentionHeld) {
              assert.equal(j.name, 'delete_native_claim');
              assert.equal((await h.admin.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_locks
                WHERE pid=pg_catalog.pg_backend_pid() AND relation='workspace_file_operation_batches'::regclass
                  AND mode='ShareUpdateExclusiveLock' AND granted`)).rows[0].n, 1);
              await h.admin.query('ROLLBACK'); contentionHeld = false; controlledContentionVerified = true;
              assert.deepEqual(await snapshot(), j.recoveryRows);
            }
          }
          send({ ready: true, readOnlyVerified: true });
        } else if (stage === 'commit_recovered') {
          const j = selectedJob(value); await verify(j); if (j.phase === 'completion') assert.deepEqual(await receiptRows(j), j.completionRows); send({ ready: true });
        } else if (stage === 'ready_rotate') {
          assert.equal(await count(), initialCount + jobs.length); assert(baselineMove.batchId && baselineDelete.batchId); assert.notEqual(baselineMove.batchId, baselineDelete.batchId);
          finalRows = await snapshot(); const rotated = await rotateApiKey(manager, issued.integration.id, { expectedRevision: revision++, requestId: randomUUID(), expiresAt: Date.now() + 3_600_000 });
          credentialId = rotated.credential.id; privateValues.push(rotated.key); send({ key: rotated.key });
        } else if (stage === 'rotated_history' || stage === 'denial_checked' || stage === 'issuer_logout_checked') {
          assert.deepEqual(await snapshot(), finalRows); send({ ready: true });
        } else if (stage === 'ready_reduce') {
          await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [workspaceId], actions: ['read', 'move', 'delete'] }); send({ ready: true });
        } else if (stage === 'ready_allowlist') {
          await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [h.destination.workspaceId], actions: [...actions] }); send({ ready: true });
        } else if (stage === 'ready_acl') {
          await updateApiIntegration(manager, issued.integration.id, { expectedRevision: revision++, name: issued.integration.name, workspaceIds: [workspaceId], actions: [...actions] });
          await h.admin.query("UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]); send({ ready: true });
        } else if (stage === 'ready_restore') {
          await h.admin.query("UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id='member'", [workspaceId]); send({ ready: true });
        } else if (stage === 'ready_disable') { process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source'; send({ ready: true });
        } else if (stage === 'disabled_checked') { process.env.CANVAS_MCP_DIRECT_TOOLS = 'move_knowledge_source,delete_knowledge_source,read_knowledge_source'; assert.deepEqual(await snapshot(), finalRows); send({ ready: true });
        } else if (stage === 'logout_issuer') {
          assert.equal((await h.admin.query("DELETE FROM session WHERE id='session-member'")).rowCount, 1); manager.set('Authorization', `Bearer ${managerToken}`); send({ ready: true });
        } else if (stage === 'ready_revoke') {
          await revokeApiKey(manager, issued.integration.id, { expectedRevision: revision, credentialId }); send({ ready: true });
        } else if (stage === 'complete') { assert.equal(value.groups, 21); assert.equal(value.compiledNext, false); assert.equal(value.oauthIssuance, false); }
        else assert.fail('Unexpected installed SDK path milestone.');
        if (['history_checked', 'http_recovered', 'commit_recovered'].includes(stage)) {
          const j = selectedJob(value); console.log(JSON.stringify({ suite: 'installed-key-path-group', name: j.name, stage, passed: true }));
        }
      },
    })); } finally { if (contentionHeld) { await h.admin.query('ROLLBACK'); contentionHeld = false; } }
    assert.equal(httpDrops.size, 2); assert.equal(commitLosses.size, 4); assert.equal(probe.droppedAcknowledgements, 2);
    assert(controlledContentionVerified); assert((recoveryBusy.get('delete_native_claim') ?? 0) >= 1);
    for (const j of jobs) {
      const key = `${j.kind}_knowledge_source:${j.operationId}`;
      assert.equal(probe.pathCalls[`${key}:apply`], j.phase === 'baseline' ? 2 : 1);
      assert.equal(probe.pathCalls[`${key}:recover`], j.name === 'move_native' || j.name === 'delete_native' ? 3 : 1 + (recoveryBusy.get(j.name) ?? 0));
    }
    assert.equal(await count(), initialCount + jobs.length); assert.deepEqual(await snapshot(), finalRows);
    assert(probe.deniedMethods.length >= 2); assert(probe.deniedMethods.every(method => ['tools/call', 'server/discover', 'initialize'].includes(method)));
    console.log(JSON.stringify({ suite: 'installed-api-key-sdk-native-path-http', passed: true, groups: 21, wheelSha256: probe.wheelSha256,
      keyHeaderOnlyRequests: probe.keyHeaderOnlyRequests, actual401: probe.deniedMethods.length, nativeOperationsCreated: jobs.length,
      droppedHttpAcknowledgements: httpDrops.size, lostCommitAcknowledgements: commitLosses.size, automaticWriteReplays: 0,
      controlledTableContentionVerified: controlledContentionVerified,
      explicitRecoveryRetriesAfterUnchangedRowsAndReadOnlyStatus: [...recoveryBusy.values()].reduce((sum, count) => sum + count, 0),
      transportOutcomes,
      separateKindNamespacesForSameCallerId: true, protectedOriginalsAndHistoryRetained: true, stderrBytes: probe.stderrBytes,
      compiledNext: false, oauthIssuance: false, reviewCenterEnabled: false, undoEnabled: false }));
  });
}
main().catch(error => { console.error(JSON.stringify({ suite: 'installed-api-key-sdk-native-path-http', passed: false, stage,
  name: error instanceof Error ? error.name : undefined, code: error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined,
  assertion: error instanceof assert.AssertionError ? { operator: error.operator, actual: typeof error.actual === 'number' ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'number' ? error.expected : typeof error.expected } : undefined,
  stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s*at\b/u.test(line)).slice(0, 5) : undefined })); process.exitCode = 1; });
