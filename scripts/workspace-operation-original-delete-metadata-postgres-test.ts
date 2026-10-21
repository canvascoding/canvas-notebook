import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceRequestPrincipalAccess } from '../app/lib/workspaces/request-principal';
import type { OriginalIntent } from '../app/lib/files/workspace-operation-original-delete-evidence';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Real full-DDL PG18/Auth/Upload/Copy/Metadata/producer/claim/OriginalDelete.
// The historical NULL/neutral rows, public share and adversarial D2/S2 below
// are explicitly owned SQL/FS fixtures, not public-create or ACL evidence.
type Row = Record<string, unknown>;
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const missing = async (file: string) => { try { await lstat(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } };
const hasCode = (expected: string) => (error: unknown): boolean => error instanceof Error
  && !(error instanceof assert.AssertionError) && Reflect.get(error, 'code') === expected;
function failure(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > 3) return { name: 'bounded' };
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  return { name: error.name, code: typeof code === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(code) ? code : null,
    frames: error.stack?.split('\n').flatMap(line => {
      const match = /\/(app\/lib\/[A-Za-z0-9_./-]+|scripts\/[A-Za-z0-9_./-]+):(\d+):(\d+)\)?$/u.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 4), ...(cause instanceof Error ? { cause: failure(cause, depth + 1) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 4).map(item => failure(item, depth + 1)) } : {}) };
}
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

async function originalDeleteMetadataPostgresTest(): Promise<void> {
  const files = ['scripts/workspace-operation-original-delete-metadata-postgres-test.ts',
    'scripts/helpers/native-copy-metadata-owner-fixture.ts', 'scripts/workspace-operation-original-delete-postgres-test.ts',
    'scripts/workspace-operation-native-copy-metadata-owner-postgres-test.ts',
    'app/lib/files/workspace-operation-original-delete-domain.ts',
    'app/lib/files/workspace-operation-original-delete.ts', 'app/lib/filesystem/prepared-single-file-trash.ts',
    'app/lib/files/workspace-operation-original-delete-links.ts', 'app/lib/files/workspace-operation-original-delete-public.ts',
    'app/lib/files/workspace-operation-original-delete-evidence.ts', 'app/lib/files/workspace-operation-original-delete-repository.ts',
    'app/lib/files/workspace-path-operation-service.ts', 'app/lib/files/workspace-operation-batch-store.ts',
    'app/lib/files/workspace-operation-job-lifecycle-owner.ts', 'app/lib/files/workspace-file-metadata.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-metadata.ts',
    'app/lib/collaboration/markdown-file-import-persistence.ts', 'app/lib/db/postgres.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(file))])));
  console.log(JSON.stringify({ suite: 'original-delete-metadata', sourcePins: pins }));
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { openDb } = await import('../app/lib/db');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { previewWorkspaceNativeCopyOperation: previewCopy, executeWorkspaceNativeCopyOperation: executeCopy } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
    const { submitDirectWorkspacePathOperation } = await import('../app/lib/files/workspace-path-operation-service');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { executeWorkspaceOperationOriginalDelete: executeDelete } = await import('../app/lib/files/workspace-operation-original-delete');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const store = new WorkspaceOperationBatchStore(), checkouts = new Set<SqlConnection>();
    const group = async (name: string, operation: () => Promise<void>) => {
      currentCase = name; await operation(); groups++; console.log(`PASS original-delete-metadata ${groups}: ${name}`);
    };
    const rows = async (table: string, key: string, value: string, database = h.connection): Promise<Row[]> => {
      assert(['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages',
        'collaboration_native_link_mutation_receipts', 'public_file_shares', 'workspace_file_operation_delete_intents',
        'workspace_file_operation_delete_receipts', 'workspace_file_operation_delete_trash_receipts', 'workspace_trash_entries'].includes(table));
      assert(['id', 'document_id', 'batch_id'].includes(key));
      return await database.all(`SELECT *,xmin::text AS fixture_xmin FROM "${h.schema}".${table} WHERE ${key}=$1`, [value]) as Row[];
    };
    const annotations = async (workspace: WorkspaceContext, file: string, database = h.connection) => ({
      shared: await database.all(`SELECT workspace_id,path,title,created_at,updated_at,xmin::text AS fixture_xmin
        FROM "${h.schema}".workspace_file_metadata WHERE workspace_id=$1 AND path=$2`, [workspace.workspaceId, file]),
      personal: await database.all(`SELECT workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at,xmin::text AS fixture_xmin
        FROM "${h.schema}".workspace_file_user_states WHERE workspace_id=$1 AND path=$2 ORDER BY user_id COLLATE "C"`, [workspace.workspaceId, file]),
    });
    const native = async (documentId: string) => {
      const state = await loadCollaborationStateOnConnection(h.connection, documentId, true); assert(state); return state;
    };
    const literals = async (documentId: string) => {
      const inventory = inspectPersistedDocumentLinks(await native(documentId)); assert.equal(inventory.coverage.complete, true);
      return inventory.links.map(link => link.literal);
    };
    const copy = async (source: WorkspaceContext, destination: WorkspaceContext, paths: string[], userId: 'owner' | 'member' = 'member') => {
      const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId, actorId: userId, sessionId: `session-${userId}` },
        sourceWorkspace: source, destinationWorkspace: destination });
      const selections = paths.map(sourcePath => ({ sourcePath, destinationPath: sourcePath }));
      const request = await h.request(destination, userId, true), plan = await previewCopy({ origin, request, selections });
      const result = await executeCopy({ origin, request, selections, operationId: crypto.randomUUID(), expectedPlanId: plan.planId });
      assert.equal(result.execution.status, 'complete', JSON.stringify(result.execution));
      assert.deepEqual([...result.copied].sort(), [...paths].sort()); return result;
    };
    const access = async (workspace: WorkspaceContext): Promise<Pick<WorkspaceRequestPrincipalAccess, 'workspace' | 'userId' | 'sessionId'>> =>
      withWorkspaceRequestPrincipal(await h.request(workspace, 'owner', true), { workspaceId: workspace.workspaceId, permission: 'canWrite' }, async principal => {
        const database = await openDb(); let committed = false;
        try {
          await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
          const value = await withWorkspaceRequestPrincipalOnConnection(database, principal, async actual => {
            assert.equal(actual.userId, 'owner'); assert.equal(actual.sessionId, 'session-owner');
            assert.equal(actual.workspace.workspaceId, workspace.workspaceId);
            assert.equal(actual.workspace.permissions.canWrite, true); assert.equal(actual.workspace.permissions.canDelete, true);
            await actual.assertCurrent(); return { workspace: actual.workspace, userId: actual.userId, sessionId: actual.sessionId };
          });
          await database.run('COMMIT'); committed = true; return value;
        } catch (error) { await database.run('ROLLBACK'); throw error; }
        finally { await database.close(committed ? undefined : new Error('Discarding failed genuine request-principal fixture phase.')); }
      });
    const setup = async (projected = false) => {
      const suffix = crypto.randomUUID(), targetPath = `target-${suffix}.md`, keepPath = `keep-${suffix}.md`, refPath = `ref-${suffix}.md`;
      const content = Buffer.from('# Target\n\nOriginal D1 bytes.\n');
      await h.upload(targetPath, content); await h.upload(keepPath, Buffer.from('# Keep\n\nIndependent.\n'));
      await h.upload(refPath, Buffer.from(`# Ref\n\n[Remove](${targetPath}) and [Keep](${keepPath}).\n\nUnrelated paragraph.\n`));
      await h.metadata(h.source, targetPath, { title: 'Source database title' });
      await h.metadata(h.source, targetPath, { isFavorite: true, pinned: true }, 'owner');
      await copy(h.source, h.destination, [targetPath, keepPath, refPath]);
      assert.deepEqual((await annotations(h.destination, targetPath)).personal, [], 'Copy must not carry source personal state.');
      const workspace = projected ? h.source : h.destination;
      const registry = (await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status=$3',
        [workspace.workspaceId, targetPath, 'active'])).rows[0]; assert(registry);
      const ref = (await h.admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status=$3',
        [workspace.workspaceId, refPath, 'active'])).rows[0]; assert(ref);
      const keep = (await h.admin.query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status=$3',
        [workspace.workspaceId, keepPath, 'active'])).rows[0]; assert(keep);
      const fullPath = path.join(workspace.rootPath, targetPath);
      assert.equal(await missing(fullPath), !projected);
      if (projected) assert.deepEqual(await readFile(fullPath), content);
      await h.metadata(workspace, targetPath, { title: 'Destination D1 title', isFavorite: true, pinned: true }, 'owner');
      await h.metadata(workspace, targetPath, { isFavorite: true, pinned: true }, 'member');
      await h.metadata(workspace, keepPath, { title: 'Unrelated sibling title', isFavorite: true, pinned: true }, 'owner');
      // Declared historical public-share row under original full migrations.
      // No public-create ACL claim is made by this adversarial SQL fixture.
      const shareId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
      await h.admin.query(`INSERT INTO public_file_shares(id,token,token_hash,token_preview,organization_id,workspace_id,workspace_type,
        workspace_root_relative_path,workspace_path,document_id,lineage_id,lifecycle_generation,file_name,file_identity,target_revision_policy,
        mime_type,size_bytes,status,created_by_user_id,source,security_mode,reason,created_at,updated_at,password_enabled,access_count,policy_revision)
        VALUES($1,$2,$3,'fixture',$4,$5,$6,$7,$8,$9,$10,1,$8,'private-historical-fixture','latest',
          'text/markdown',$11,'active','owner','ui','strict','owned Delete cleanup fixture',100,100,0,0,1)`,
      [shareId, token, sha(token), workspace.organizationId, workspace.workspaceId, workspace.workspaceType,
        workspace.rootRelativePath, targetPath, registry.id, registry.lineage_id, content.length]);
      assert.deepEqual(await literals(ref.id), [targetPath, keepPath]);
      const preservedSource = projected ? h.destination : h.source;
      const sourceBefore = await h.admin.query('SELECT d.id,s.yjs_state,s.state_vector,s.document_sequence FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.workspace_id=$1 AND d.path=ANY($2::text[]) ORDER BY d.path',
        [preservedSource.workspaceId, [targetPath, keepPath, refPath]]);
      return { workspace, targetPath, keepPath, refPath, content, fullPath, documentId: registry.id as string,
        lineageId: registry.lineage_id as string, refId: ref.id as string, keepId: keep.id as string, shareId,
        preservedSource, sourceBefore: sourceBefore.rows, sourceAnnotations: await annotations(preservedSource, targetPath),
        keepAnnotations: await annotations(workspace, keepPath) };
    };
    type Target = Awaited<ReturnType<typeof setup>>;
    const job = async (target: Target) => {
      const current = await access(target.workspace);
      const created = await submitDirectWorkspacePathOperation({ scope: { workspace: current.workspace, fileOptions: { workspace: current.workspace } },
        kind: 'delete', selections: [{ sourcePath: target.targetPath }], actorUserId: current.userId, actorId: current.userId,
        actorType: 'user', actorDisplayName: 'Genuine metadata Delete owner', actorSessionId: current.sessionId!, idempotencyKey: crypto.randomUUID() }, { store });
      assert.equal(created.plan.version, 2); assert.equal(created.plan.readiness, 'ready');
      if (created.plan.version !== 2) assert.fail('Actual native Delete producer required.');
      assert.equal(created.plan.nativeTarget.documentId, target.documentId);
      assert.equal(created.plan.nativeGraphPlan.steps.flatMap(step => step.linkIntents).length, 1);
      const claimed = await store.claim(crypto.randomUUID()); assert(claimed); assert.equal(claimed.batchId, created.batchId);
      return { target, claimed };
    };
    type Job = Awaited<ReturnType<typeof job>>;
    const durable = async (value: Job) => ({
      intents: await rows('workspace_file_operation_delete_intents', 'batch_id', value.claimed.batchId),
      receipts: await rows('workspace_file_operation_delete_receipts', 'batch_id', value.claimed.batchId),
      trashReceipts: await rows('workspace_file_operation_delete_trash_receipts', 'batch_id', value.claimed.batchId),
    });
    const physical = async (value: Job) => {
      const evidence = await durable(value); assert.equal(evidence.intents.length, 1);
      const intent = JSON.parse(String(evidence.intents[0].intent_text)) as OriginalIntent;
      assert.equal(intent.batchId, value.claimed.batchId); assert.equal(intent.native?.documentId, value.target.documentId);
      assert.equal(sha(String(evidence.intents[0].intent_text)), evidence.intents[0].intent_digest);
      const full = path.resolve(h.dataRoot, intent.physical.trashRelativePath); assert(full.startsWith(`${h.dataRoot}${path.sep}`));
      return { evidence, intent, full };
    };
    const proof = async (target: Target) => ({ annotations: await annotations(target.workspace, target.targetPath),
      registry: await rows('collaboration_documents', 'id', target.documentId), lineage: await rows('file_collaboration_lineages', 'id', target.lineageId),
      native: await native(target.documentId), ref: await native(target.refId), keep: await native(target.keepId),
      keepAnnotations: await annotations(target.workspace, target.keepPath),
      share: await rows('public_file_shares', 'id', target.shareId), links: await rows('collaboration_native_link_mutation_receipts', 'document_id', target.refId) });
    type Fault = 'none' | 'rollback-cleanup' | 'commit-ack' | 'source-replacement';
    const tracked = (value: Job, fault: Fault = 'none') => {
      const observation = { opens: 0, closes: 0, ownerSessions: 0,
        connections: [] as Array<{ ordinal: number; closeCalls: number; released: boolean; owner: boolean; pid: string | null; start: string | null }>,
        deleted: [] as string[], injected: false, b2: null as { pid: string; xid: string } | null,
        replacement: null as { identity: Awaited<ReturnType<typeof lstat>>; annotations: Awaited<ReturnType<typeof annotations>> } | null };
      const workspaceLeaseKey = collaborationAdmissionLockKey(value.target.workspace.workspaceId);
      return { observation, open: async (): Promise<SqlConnection> => {
        const externalBefore = fault === 'rollback-cleanup' ? await proof(value.target) : null;
        const raw = await openDb(); checkouts.add(raw); observation.opens++;
        const connection = { ordinal: observation.opens, closeCalls: 0, released: false, owner: false,
          pid: null as string | null, start: null as string | null };
        observation.connections.push(connection);
        const observeOwnerLease = async (sql: string, values: unknown[] | undefined, answer: unknown) => {
          // The genuine native Owner acquires this exact workspace session
          // lease on the same Raw used by all its later phases. History and
          // admission checkouts do not become Owners merely by being opened.
          if (sql !== 'SELECT pg_try_advisory_lock($1::bigint) AS locked' || values?.length !== 1
            || values[0] !== workspaceLeaseKey || (answer as { locked?: boolean } | undefined)?.locked !== true) return;
          assert.equal(connection.owner, false, 'One workspace lease acquisition per actual Owner checkout.');
          const bits = BigInt.asUintN(64, BigInt(workspaceLeaseKey));
          const held = await raw.get(`SELECT pg_backend_pid()::text AS pid,extract(epoch FROM a.backend_start)::text AS start,
            EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
              AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1
              AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
              AND l.classid::bigint=$1::bigint AND l.objid::bigint=$2::bigint) AS held
            FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`,
          [(bits >> BigInt(32)).toString(), (bits & BigInt(0xffffffff)).toString()]) as { pid: string; start: string; held: boolean };
          assert.equal(held?.held, true); assert.match(held.pid, /^[1-9][0-9]*$/u); assert.equal(typeof held.start, 'string'); assert(held.start);
          connection.owner = true; connection.pid = held.pid; connection.start = held.start; observation.ownerSessions++;
        };
        const before = async (sql: string) => {
          if (fault !== 'source-replacement' || observation.injected || !/^DELETE FROM "[^"]+"\.workspace_file_metadata\b/u.test(sql)) return;
          assert.equal(await missing(value.target.fullPath), true);
          await writeFile(value.target.fullPath, 'Owned adversarial S2, preserve exactly.\n', { flag: 'wx', mode: 0o600 });
          // Separate committed SQL rows belonging to this explicit late S2.
          await h.admin.query('UPDATE workspace_file_metadata SET title=$3,updated_at=updated_at+1 WHERE workspace_id=$1 AND path=$2',
            [value.target.workspace.workspaceId, value.target.targetPath, 'New S2 annotation']);
          await h.admin.query('UPDATE workspace_file_user_states SET is_favorite=0,pinned_at=NULL,updated_at=updated_at+1 WHERE workspace_id=$1 AND path=$2',
            [value.target.workspace.workspaceId, value.target.targetPath]);
          observation.replacement = { identity: await lstat(value.target.fullPath), annotations: await annotations(value.target.workspace, value.target.targetPath) };
          observation.injected = true;
        };
        const after = async (sql: string) => {
          const deleted = /^DELETE FROM "[^"]+"\.(workspace_file_metadata|workspace_file_user_states)\b/u.exec(sql);
          if (deleted) {
            observation.deleted.push(deleted[1]);
            if (deleted[1] === 'workspace_file_user_states') {
              observation.b2 = await raw.get('SELECT pg_backend_pid()::text AS pid,pg_current_xact_id_if_assigned()::text AS xid') as { pid: string; xid: string };
              assert(observation.b2?.xid);
              assert.deepEqual(await annotations(value.target.workspace, value.target.targetPath, raw), { shared: [], personal: [] });
              assert.equal((await rows('collaboration_documents', 'id', value.target.documentId, raw))[0].status, 'archived');
              assert.equal((await rows('public_file_shares', 'id', value.target.shareId, raw))[0].status, 'revoked');
              assert.equal((await rows('collaboration_native_link_mutation_receipts', 'document_id', value.target.refId, raw)).length, 1);
              if (fault === 'rollback-cleanup' && !observation.injected) {
                assert.deepEqual(await proof(value.target), externalBefore, 'The actual other backend cannot see any uncommitted B2 change.');
                observation.injected = true; throw Object.assign(new Error('Owned after both actual annotation DELETEs.'), { code: 'FIXTURE_DELETE_METADATA_ROLLBACK' });
              }
            }
          }
          if (fault === 'commit-ack' && !observation.injected && /^COMMIT\s*$/iu.test(sql) && (await durable(value)).receipts.length === 1) {
            observation.injected = true; throw Object.assign(new Error('Owned actual COMMIT acknowledgement loss.'), { code: 'FIXTURE_DELETE_METADATA_ACK_LOST' });
          }
        };
        return { get: async (sql, values) => { await before(sql); const answer = await raw.get(sql, values); await observeOwnerLease(sql, values, answer); await after(sql); return answer; },
          all: async (sql, values) => { await before(sql); const answer = await raw.all(sql, values); await after(sql); return answer; },
          run: async (sql, values) => { await before(sql); const answer = await raw.run(sql, values); await after(sql); return answer; },
          close: async cause => {
            connection.closeCalls++;
            const failures: unknown[] = [];
            // Always forward the real release/discard BEFORE any fixture
            // assertion. Successful history/admission closes may omit cause.
            try {
              await raw.close(cause); connection.released = true; observation.closes++; checkouts.delete(raw);
            } catch (error) { failures.push(error); }
            try {
              assert.equal(connection.closeCalls, 1, 'Every actual checkout closes exactly once.');
              if (connection.owner) assert(cause instanceof Error, 'The dedicated Owner session must be discarded.');
            } catch (error) { failures.push(error); }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, 'Real checkout release and fixture close invariant failed.');
          } };
      } };
    };
    const run = async (value: Job, adapter = tracked(value)) => {
      // A genuine durable completion takes the product's history-only path.
      // Its single checkout is not a new lifecycle Owner session.
      const receiptsAtEntry = (await durable(value)).receipts; assert(receiptsAtEntry.length <= 1);
      let failed = false, primary: unknown;
      try {
        return await store.withClaim(value.claimed, async claim => {
          const applied = await executeDelete(claim, adapter.open);
          const finished = await store.finishClaim(value.claimed, { status: 'applied', trashEntryIds: [applied.trashEntryId],
            completedActions: 1 + (applied.nativeLinks?.length ?? 0), phase: 'complete' });
          assert.equal(finished?.status, 'applied'); return applied;
        });
      } catch (error) { failed = true; primary = error; throw error; }
      finally {
        const failures: unknown[] = [];
        try {
          assert.equal(adapter.observation.opens, adapter.observation.connections.length);
          assert.equal(adapter.observation.opens, adapter.observation.closes);
          for (const connection of adapter.observation.connections) {
            assert.equal(connection.closeCalls, 1); assert.equal(connection.released, true);
          }
          const owners = adapter.observation.connections.filter(connection => connection.owner);
          assert.equal(adapter.observation.ownerSessions, owners.length);
          assert.equal(owners.length, receiptsAtEntry.length === 1 ? 0 : 1, 'Exactly one actual leased Owner, or zero for immutable completed history.');
          if (receiptsAtEntry.length === 1) assert.equal(adapter.observation.opens, 1, 'History-only replay uses exactly one checkout.');
          if (adapter.observation.b2) assert.equal(adapter.observation.b2.pid, owners[0]?.pid, 'B2 stays on the same genuinely leased Owner backend.');
        } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failed ? [primary, ...failures] : failures, 'Original Delete checkout/Owner invariants failed.');
      }
    };
    const resume = async (value: Job): Promise<Job> => {
      const failed = await store.finishClaim(value.claimed, { status: 'needs_recovery', phase: 'recovery', errorCode: 'FIXTURE_EXPECTED_FAILURE' });
      assert.equal(failed?.status, 'needs_recovery');
      const queued = await store.enqueue({ batchId: value.claimed.batchId, planId: value.claimed.planId, userId: 'owner', displayName: 'Original owner', action: 'resume' });
      assert.equal(queued.status, 'queued'); const claimed = await store.claim(crypto.randomUUID()); assert(claimed);
      assert.equal(claimed.batchId, value.claimed.batchId); assert.deepEqual(claimed.plan, value.claimed.plan);
      assert.deepEqual(claimed.authorization, value.claimed.authorization); return { ...value, claimed };
    };
    const assertAbsentOutcome = async (value: Job) => {
      const facts = await physical(value); assert.equal(facts.evidence.receipts.length, 0); assert.equal(facts.evidence.trashReceipts.length, 0);
      assert.equal((await rows('workspace_trash_entries', 'id', facts.intent.physical.trashEntryId)).length, 0);
    };
    const assertApplied = async (value: Job, result: Awaited<ReturnType<typeof run>>, adapter: ReturnType<typeof tracked>) => {
      const facts = await physical(value); assert.equal(facts.evidence.receipts.length, 1); assert.equal(facts.evidence.trashReceipts.length, 1);
      assert.equal(result.receiptDigest, facts.evidence.receipts[0].receipt_digest);
      assert.equal(sha(String(facts.evidence.receipts[0].receipt_text)), result.receiptDigest);
      assert.equal(result.trashEntryId, facts.intent.physical.trashEntryId);
      assert.deepEqual(await annotations(value.target.workspace, value.target.targetPath), { shared: [], personal: [] });
      assert.equal((await native(value.target.documentId)).status, 'archived');
      assert.equal((await rows('public_file_shares', 'id', value.target.shareId))[0].status, 'revoked');
      assert.deepEqual(await literals(value.target.refId), [value.target.keepPath]);
      assert.equal(result.nativeLinks?.length, 1); assert.equal(await missing(value.target.fullPath), true);
      assert.deepEqual(await annotations(value.target.workspace, value.target.keepPath), value.target.keepAnnotations);
      if (facts.intent.physical.source.kind === 'regular_file') assert.deepEqual(await readFile(facts.full), value.target.content);
      assert.deepEqual(adapter.observation.deleted, ['workspace_file_metadata', 'workspace_file_user_states']);
      const b2 = adapter.observation.b2; assert(b2); const xid32 = (BigInt(b2.xid) % BigInt(2 ** 32)).toString();
      const changed = [facts.evidence.receipts[0], facts.evidence.trashReceipts[0],
        ...(await rows('workspace_trash_entries', 'id', result.trashEntryId)),
        ...(await rows('collaboration_documents', 'id', value.target.documentId)),
        ...(await rows('collaboration_yjs_states', 'document_id', value.target.documentId)),
        ...(await rows('public_file_shares', 'id', value.target.shareId)),
        ...(await rows('collaboration_native_link_mutation_receipts', 'document_id', value.target.refId))];
      assert(changed.length >= 7); for (const row of changed) assert.equal(row.fixture_xmin, xid32);
      assert.deepEqual((await h.admin.query('SELECT d.id,s.yjs_state,s.state_vector,s.document_sequence FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.workspace_id=$1 AND d.path=ANY($2::text[]) ORDER BY d.path',
        [value.target.preservedSource.workspaceId, [value.target.targetPath, value.target.keepPath, value.target.refPath]])).rows, value.target.sourceBefore);
      assert.deepEqual(await annotations(value.target.preservedSource, value.target.targetPath), value.target.sourceAnnotations);
    };
    try {
      await group('actual native Copy + shared title and both users personal state are deleted; exact path can be copied again', async () => {
        const target = await setup(), value = await job(target), adapter = tracked(value);
        const before = await annotations(target.workspace, target.targetPath); assert.equal(before.shared.length, 1); assert.equal(before.personal.length, 2);
        await assertApplied(value, await run(value, adapter), adapter);
        await copy(h.source, h.destination, [target.targetPath]);
        const replacement = (await h.admin.query("SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active'", [target.workspace.workspaceId, target.targetPath])).rows[0];
        assert(replacement); assert.notEqual(replacement.id, target.documentId);
        const after = await annotations(target.workspace, target.targetPath); assert.equal(after.shared.length, 1);
        assert.equal((after.shared[0] as Row).title, 'Source database title'); assert.deepEqual(after.personal, []);
      });
      await group('explicit historical NULL title and foreign false/NULL personal rows are removed, not adopted', async () => {
        const target = await setup();
        await h.admin.query('UPDATE workspace_file_metadata SET title=NULL WHERE workspace_id=$1 AND path=$2', [target.workspace.workspaceId, target.targetPath]);
        await h.admin.query('UPDATE workspace_file_user_states SET is_favorite=0,pinned_at=NULL WHERE workspace_id=$1 AND path=$2', [target.workspace.workspaceId, target.targetPath]);
        const historical = await annotations(target.workspace, target.targetPath); assert.equal((historical.shared[0] as Row).title, null);
        assert.equal(historical.personal.length, 2); for (const row of historical.personal as Row[]) { assert.equal(Number(row.is_favorite), 0); assert.equal(row.pinned_at, null); }
        const value = await job(target), adapter = tracked(value); await assertApplied(value, await run(value, adapter), adapter);
        await copy(h.source, h.destination, [target.targetPath]); assert.deepEqual((await annotations(target.workspace, target.targetPath)).personal, []);
      });
      await group('fault after both actual DELETEs rolls back annotations, archive, incoming link and public revoke together', async () => {
        const target = await setup(true), value = await job(target), before = await proof(target), adapter = tracked(value, 'rollback-cleanup');
        await assert.rejects(run(value, adapter), hasCode('FIXTURE_DELETE_METADATA_ROLLBACK'));
        assert.equal(adapter.observation.injected, true); assert.deepEqual(adapter.observation.deleted, ['workspace_file_metadata', 'workspace_file_user_states']);
        assert.deepEqual(await proof(target), before); await assertAbsentOutcome(value);
        assert.equal(await missing(target.fullPath), true); const original = await physical(value); assert.deepEqual(await readFile(original.full), target.content);
        const retry = await resume(value), replay = tracked(retry); await assertApplied(retry, await run(retry, replay), replay);
      });
      await group('lost actual B2 COMMIT acknowledgement recovers immutable completion without repeating annotation cleanup', async () => {
        const target = await setup(), value = await job(target), adapter = tracked(value, 'commit-ack');
        await assert.rejects(run(value, adapter), hasCode('JOB_LIFECYCLE_COMMIT_UNCONFIRMED')); assert.equal(adapter.observation.injected, true);
        const original = await physical(value), receipt = original.evidence.receipts[0]; assert(receipt);
        await assertApplied(value, { ...JSON.parse(String(receipt.receipt_text)), receiptDigest: receipt.receipt_digest }, adapter);
        const retry = await resume(value), replay = tracked(retry), result = await run(retry, replay);
        assert.equal(result.receiptDigest, receipt.receipt_digest); assert.deepEqual(await durable(retry), original.evidence);
        assert.deepEqual(replay.observation.deleted, []); assert.equal(replay.observation.b2, null);
      });
      await group('historical completion preserves explicitly later native D2/S2 and all its annotations without current-row cleanup', async () => {
        const target = await setup(), value = await job(target), adapter = tracked(value, 'commit-ack');
        await assert.rejects(run(value, adapter), hasCode('JOB_LIFECYCLE_COMMIT_UNCONFIRMED')); assert.equal(adapter.observation.injected, true);
        const original = await durable(value); assert.equal(original.receipts.length, 1);
        // Deliberate later committed D2 stored-data fault, like the original
        // Delete20 history fixture. No public native-create authorization claim.
        const documentId = crypto.randomUUID(), lineageId = crypto.randomUUID();
        const insert = async (table: 'file_collaboration_lineages' | 'collaboration_documents' | 'collaboration_yjs_states', data: Row) => {
          const keys = Object.keys(data); assert(keys.every(key => /^[a-z_]+$/u.test(key)));
          await h.admin.query(`INSERT INTO "${h.schema}".${table} (${keys.map(key => `"${key}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map(key => data[key]));
        };
        const source = (await h.admin.query('SELECT d.* FROM collaboration_documents d WHERE workspace_id=$1 AND path=$2 AND status=$3',
          [h.source.workspaceId, target.targetPath, 'active'])).rows[0]; assert(source);
        const lineage = (await h.admin.query('SELECT * FROM file_collaboration_lineages WHERE id=$1', [source.lineage_id])).rows[0]; assert(lineage);
        const state = (await h.admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [source.id])).rows[0]; assert(state);
        await insert('file_collaboration_lineages', { ...lineage, id: lineageId, workspace_id: target.workspace.workspaceId, status: 'active' });
        await insert('collaboration_documents', { ...source, id: documentId, lineage_id: lineageId, workspace_id: target.workspace.workspaceId,
          workspace_type: target.workspace.workspaceType, status: 'active' });
        await insert('collaboration_yjs_states', { ...state, document_id: documentId, workspace_id: target.workspace.workspaceId, status: 'active' });
        await writeFile(target.fullPath, 'Later owned D2 projection.\n', { flag: 'wx', mode: 0o600 });
        await h.admin.query('INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,$3,200,300)',
          [target.workspace.workspaceId, target.targetPath, 'Later D2 title']);
        for (const userId of ['owner', 'member']) await h.admin.query('INSERT INTO workspace_file_user_states(workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at) VALUES($1,$2,$3,0,NULL,200,300)',
          [target.workspace.workspaceId, userId, target.targetPath]);
        // Reading the bytes may update atime. Keep every other own Stats
        // field, including inode, mode, ownership and modification clocks.
        const identity = async () => Object.fromEntries(Object.entries(await lstat(target.fullPath))
          .filter(([key]) => key !== 'atime' && key !== 'atimeMs'));
        const before = { annotations: await annotations(target.workspace, target.targetPath), registry: await rows('collaboration_documents', 'id', documentId),
          lineage: await rows('file_collaboration_lineages', 'id', lineageId), native: await native(documentId), identity: await identity(), bytes: await readFile(target.fullPath) };
        const retry = await resume(value), replay = tracked(retry), result = await run(retry, replay);
        assert.equal(result.receiptDigest, original.receipts[0].receipt_digest); assert.deepEqual(await durable(retry), original);
        assert.deepEqual(replay.observation.deleted, []); assert.equal(replay.observation.b2, null);
        const after = { annotations: await annotations(target.workspace, target.targetPath), registry: await rows('collaboration_documents', 'id', documentId),
          lineage: await rows('file_collaboration_lineages', 'id', lineageId), native: await native(documentId), identity: await identity(), bytes: await readFile(target.fullPath) };
        const differingFields = (['annotations', 'registry', 'lineage', 'native', 'identity', 'bytes'] as const)
          .filter(key => !isDeepStrictEqual(after[key], before[key]));
        if (differingFields.length) console.error(JSON.stringify({ diagnostic: 'original-delete-metadata-historical-proof-fields', differingFields }));
        assert.deepEqual(after, before);
      });
      for (const projected of [true, false]) await group(`late real S2 after ${projected ? 'physical rename' : 'projection_absent'} pre-vacancy gate forces full rollback and preserves new rows`, async () => {
        const target = await setup(projected), value = await job(target), before = await proof(target), adapter = tracked(value, 'source-replacement');
        await assert.rejects(run(value, adapter), hasCode('source-changed'));
        assert.equal(adapter.observation.injected, true); assert.deepEqual(adapter.observation.deleted, ['workspace_file_metadata', 'workspace_file_user_states']);
        const replacement = adapter.observation.replacement; assert(replacement);
        assert.deepEqual(await annotations(target.workspace, target.targetPath), replacement.annotations);
        assert.deepEqual(await readFile(target.fullPath), Buffer.from('Owned adversarial S2, preserve exactly.\n'));
        const identity = await lstat(target.fullPath); for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(identity[key], replacement.identity[key]);
        const after = await proof(target); assert.deepEqual({ ...after, annotations: before.annotations }, before); await assertAbsentOutcome(value);
        const facts = await physical(value);
        assert.equal(facts.intent.physical.source.kind, projected ? 'regular_file' : 'projection_absent');
        if (projected) assert.deepEqual(await readFile(facts.full), target.content);
        // Only our positively identified S2 is removed after all preservation
        // assertions; never remove a changed inode or any foreign pathname.
        const current = await lstat(target.fullPath); assert.equal(current.dev, replacement.identity.dev); assert.equal(current.ino, replacement.identity.ino);
        assert.deepEqual(await readFile(target.fullPath), Buffer.from('Owned adversarial S2, preserve exactly.\n')); await unlink(target.fullPath);
        const retry = await resume(value), replay = tracked(retry); await assertApplied(retry, await run(retry, replay), replay);
      });
      assert.equal(groups, 7, 'The seven original metadata families completed unchanged.');

      await group('direct SQL writer predicates and all three SHARE NOWAIT tuple-lock classes retain their exact semantics', async () => {
        // Deliberate SQL fixture over the actual full-DDL schema. This calls
        // only the existing guard, not a lifecycle/public/native owner or grant.
        const { assertNoCompetingWriter } = await import('../app/lib/files/workspace-operation-original-delete-domain');
        type Access = Parameters<typeof assertNoCompetingWriter>[0];
        type Kind = 'locks' | 'guests' | 'agents';
        const tables = { locks: 'file_locks', guests: 'file_guest_invitations', agents: 'collaboration_agent_operations' } as const;
        const key = (kind: Kind) => kind === 'agents' ? 'operation_id' : 'id';
        const own: Array<{ kind: Kind; id: string }> = [];
        const source = (await h.admin.query(`SELECT d.id,d.path,d.lineage_id,s.lifecycle_generation,s.document_sequence,s.state_vector
          FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
          WHERE d.workspace_id=$1 AND d.status='active' ORDER BY d.path COLLATE "C" LIMIT 1`, [h.source.workspaceId])).rows[0];
        assert(source);
        const foreignWorkspace = (await h.admin.query(`SELECT d.id,d.path,d.lineage_id,s.lifecycle_generation,s.document_sequence,s.state_vector
          FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
          WHERE d.workspace_id=$1 AND d.path=$2 AND d.status='active'`, [h.destination.workspaceId, source.path])).rows[0];
        assert(foreignWorkspace);
        const otherPath = `writer-guard-other-${crypto.randomUUID()}.md`;
        await h.upload(otherPath, Buffer.from('# Independent SQL guard source\n'));
        const foreignPath = (await h.admin.query(`SELECT d.id,d.path,d.lineage_id,s.lifecycle_generation,s.document_sequence,s.state_vector
          FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
          WHERE d.workspace_id=$1 AND d.path=$2 AND d.status='active'`, [h.source.workspaceId, otherPath])).rows[0];
        assert(foreignPath);
        const reader = await openDb(); checkouts.add(reader);
        let blocker: SqlConnection | undefined, forwarded = 0, failed = false, primary: unknown;
        let beforeAgentRead: (() => Promise<void>) | undefined;
        const database: SqlConnection = { ...reader, all: async (sql, values) => {
          forwarded++;
          if (forwarded === 2 && beforeAgentRead) {
            const hook = beforeAgentRead; beforeAgentRead = undefined; await hook();
          }
          return reader.all(sql, values);
        } };
        // Only database and workspace are consumed by this SQL-only guard.
        // This structural adapter is never passed to a genuine phase/API.
        const fixtureAccess = { database, workspace: h.source } as Access;
        const seed = async (kind: Kind, status: string, selected = source, workspace = h.source, expired = false) => {
          const id = crypto.randomUUID(), now = Date.now(); own.push({ kind, id });
          if (kind === 'locks') await h.admin.query(`INSERT INTO file_locks
            (id,workspace_id,workspace_type,path,locked_by_user_id,lock_type,status,expires_at,created_at,updated_at)
            VALUES($1,$2,$3,$4,'owner','edit',$5,$6,1,1)`,
          [id, workspace.workspaceId, workspace.workspaceType, selected.path, status, expired ? 2 : now + 60000]);
          else if (kind === 'guests') await h.admin.query(`INSERT INTO file_guest_invitations
            (id,workspace_id,path,document_id,lifecycle_generation,lineage_id,email,permission,status,created_by_user_id,expires_at,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'read',$8,'owner',$9,1,1)`,
          [id, workspace.workspaceId, selected.path, selected.id, selected.lifecycle_generation, selected.lineage_id,
            `${id}@writer-guard.test`, status, expired ? 2 : now + 60000]);
          else await h.admin.query(`INSERT INTO collaboration_agent_operations
            (operation_id,document_id,workspace_id,organization_id,initiated_by_user_id,actor_id,idempotency_key,payload_hash,
              status,base_state_vector,base_document_sequence,created_at,updated_at)
            VALUES($1,$2,$3,$4,'owner','owner',$1,$5,$6,$7,$8,1,1)`,
          [id, selected.id, workspace.workspaceId, workspace.organizationId, sha(id), status, selected.state_vector, selected.document_sequence]);
          return id;
        };
        const clear = async () => {
          for (const row of own) await h.admin.query(`DELETE FROM "${h.schema}".${tables[row.kind]} WHERE ${key(row.kind)}=$1`, [row.id]);
        };
        const snapshot = async () => {
          const result: unknown[] = [];
          for (const row of own) result.push((await h.admin.query(`SELECT to_jsonb(t) AS row,xmin::text AS fixture_xmin
            FROM "${h.schema}".${tables[row.kind]} t WHERE ${key(row.kind)}=$1`, [row.id])).rows);
          return result;
        };
        const guard = () => assertNoCompetingWriter(fixtureAccess, `"${h.schema}"`, source.path);
        const attempt = async (code?: string) => {
          const before = await snapshot(); forwarded = 0; await reader.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
          try { if (code) await assert.rejects(guard(), hasCode(code)); else await guard();
            assert.equal(forwarded, 2, 'One complete lock/guest SELECT and one fresh final agent SELECT per guard invocation.');
          } finally { await reader.run('ROLLBACK'); }
          assert.deepEqual(await snapshot(), before, 'The SELECT-only guard cannot mutate fixture rows.');
        };
        try {
          blocker = await openDb(); checkouts.add(blocker);
          const readerPid = await reader.get('SELECT pg_backend_pid() AS pid') as Row;
          const blockerPid = await blocker.get('SELECT pg_backend_pid() AS pid') as Row;
          assert.notEqual(readerPid.pid, blockerPid.pid);
          await attempt();
          for (const kind of ['locks', 'guests', 'agents'] as const) {
            for (const inactive of kind === 'locks' ? ['released', 'expired', 'force_released']
              : kind === 'guests' ? ['revoked', 'expired'] : ['persisted', 'failed', 'cancelled']) {
              await seed(kind, inactive); await attempt(); await clear();
            }
            if (kind === 'locks') { await seed(kind, 'active', source, h.source, true); await attempt(); await clear(); }
            await seed(kind, kind === 'agents' ? 'preparing' : 'active', foreignPath);
            await attempt(); await clear();
            await seed(kind, kind === 'agents' ? 'preparing' : 'active', foreignWorkspace, h.destination);
            await attempt(); await clear();
            for (const status of kind === 'agents' ? ['preparing', 'ready', 'applying', 'applied_to_ydoc', 'cancel_requested'] : ['active']) {
              await seed(kind, status); await attempt('ORIGINAL_DELETE_BUSY'); await clear();
            }
          }
          // Actual fixture COMMIT on the independent admin backend AFTER
          // the lock/guest SELECT, BEFORE the original final agent SELECT.
          // This is a SQL freshness probe, not an agent approval/auth proof.
          let afterAgentCommit: unknown[] | undefined;
          beforeAgentRead = async () => { await seed('agents', 'applying'); afterAgentCommit = await snapshot(); };
          forwarded = 0; await reader.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
          try {
            await assert.rejects(guard(), hasCode('ORIGINAL_DELETE_BUSY'));
            assert.equal(forwarded, 2); assert(afterAgentCommit);
          } finally { beforeAgentRead = undefined; await reader.run('ROLLBACK'); }
          assert.deepEqual(await snapshot(), afterAgentCommit); await clear();
          // Guest expiry is intentionally NOT a predicate in the original
          // guard: an active expired invitation still blocks.
          await seed('guests', 'active', source, h.source, true); await attempt('ORIGINAL_DELETE_BUSY'); await clear();
          const ids = { locks: await seed('locks', 'active'), guests: await seed('guests', 'active'), agents: await seed('agents', 'preparing') };
          const before = await snapshot();
          forwarded = 0; await reader.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
          try {
            await assert.rejects(guard(), hasCode('ORIGINAL_DELETE_BUSY')); assert.equal(forwarded, 2);
            // Even with a matching first category, BOTH statements and all three category scans
            // must have acquired their real row locks on this still-held B.
            for (const kind of ['locks', 'guests', 'agents'] as const) {
              await blocker.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
              try { await assert.rejects(Promise.resolve(blocker.all(`SELECT ${key(kind)} FROM "${h.schema}".${tables[kind]}
                WHERE ${key(kind)}=$1 FOR UPDATE NOWAIT`, [ids[kind]])), hasCode('55P03')); }
              finally { await blocker.run('ROLLBACK'); }
            }
            await blocker.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
            try {
              const documents = await blocker.all(`SELECT id FROM "${h.schema}".collaboration_documents WHERE id=$1 FOR UPDATE NOWAIT`, [source.id]);
              assert.equal(documents.length, 1, 'FOR SHARE OF o must not acquire a tuple lock on joined d.');
            } finally { await blocker.run('ROLLBACK'); }
          } finally { await reader.run('ROLLBACK'); }
          assert.deepEqual(await snapshot(), before);
          for (const kind of ['locks', 'guests', 'agents'] as const) {
            forwarded = 0; await blocker.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
            try {
              const locked = await blocker.all(`SELECT ${key(kind)} FROM "${h.schema}".${tables[kind]}
                WHERE ${key(kind)}=$1 FOR UPDATE NOWAIT`, [ids[kind]]); assert.equal(locked.length, 1);
              await reader.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
              try { await assert.rejects(guard(), hasCode('55P03')); assert.equal(forwarded, kind === 'agents' ? 2 : 1); }
              finally { await reader.run('ROLLBACK'); }
            } finally { await blocker.run('ROLLBACK'); }
            assert.deepEqual(await snapshot(), before);
          }
        } catch (error) { failed = true; primary = error; throw error; }
        finally {
          const failures: unknown[] = [];
          for (const connection of [reader, blocker]) if (connection) {
            try { await connection.run('ROLLBACK'); } catch (error) { failures.push(error); }
            try { await connection.close(); checkouts.delete(connection); } catch (error) { failures.push(error); }
          }
          try { await clear(); } catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failed ? [primary, ...failures] : failures, 'SQL-only writer-guard fixture closure failed.');
        }
      });
      assert.equal(groups, 8); assert.equal(checkouts.size, 0);
    } finally { assert.equal(checkouts.size, 0, 'Every actual OriginalDelete owner checkout must close.'); }
  }); }
  finally {
    const after = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(file))])));
    assert.deepEqual(after, pins, 'All direct sources and untouched original20/Metadata13 tests must retain their initial bytes.');
    console.log(JSON.stringify({ suite: 'original-delete-metadata', sourcesUnchanged: true, sourcePins: after }));
  }
  assert.equal(groups, 8); completed = true; console.log(JSON.stringify({ suite: 'original-delete-metadata', groups, passed: true }));
}
originalDeleteMetadataPostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'original-delete-metadata', currentCase, groups, passed: false, error: failure(error) })); process.exitCode = 1;
});
