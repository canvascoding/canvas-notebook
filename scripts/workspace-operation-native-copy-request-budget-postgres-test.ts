import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceOperationNativeCopySelection } from '../app/lib/files/workspace-operation-native-copy-plan';
import type { MetadataSqlEvent } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Genuine Web principal/Owner + real PG/FD fixture. No auth, SQL results,
// planner, clone, serialization or filesystem publication is substituted.
const sha = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
let currentCase = 'setup', groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

export async function nativeCopyRequestBudgetPostgresTest(): Promise<void> {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { serializeWorkspaceOperationRequest } = await import('../app/lib/files/workspace-operation-journal');
    const { previewWorkspaceNativeCopyOperation: preview, executeWorkspaceNativeCopyOperation: execute,
      recoverWorkspaceNativeCopyOperation: recover } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { NativeCopyRequestTooLargeError } = await import('../app/lib/files/workspace-operation-native-copy-request-budget');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-member' },
      sourceWorkspace: h.source, destinationWorkspace: h.destination });
    const staging = new WorkspaceOperationStaging();
    // The existing Stage reader legitimately initializes its storage root.
    // Prime that owned fixture baseline; no universal DATA-metadata claim.
    assert.equal(await staging.loadManagedCopyByOperationId(crypto.randomUUID()), null);
    const sourceRoot = `budget-source-${crypto.randomUUID()}`;
    const sourceBase = [sourceRoot, ...Array.from({ length: 4 }, () => 's'.repeat(180))].join('/');
    const sourcePaths = Array.from({ length: 40 }, (_, index) => `${sourceBase}/item-${index}.${index === 0 ? 'md' : 'bin'}`);
    const native = await h.upload(sourcePaths[0], Buffer.from('# Budget source\n'));
    await fs.mkdir(path.join(h.source.rootPath, sourceBase), { recursive: true });
    for (const file of sourcePaths.slice(1)) await fs.writeFile(path.join(h.source.rootPath, file), Buffer.from('opaque'), { flag: 'wx', mode: 0o600 });
    const bytes = (selections: readonly WorkspaceOperationNativeCopySelection[]) => Buffer.byteLength(
      serializeWorkspaceOperationRequest({ kind: 'copy', origin, selections }).requestJson, 'utf8');
    const selectionsAt = (target: number, tag: string): WorkspaceOperationNativeCopySelection[] => {
      const root = `budget-${tag}-${crypto.randomUUID()}`;
      const base = [root, ...Array.from({ length: 3 }, () => 'd'.repeat(180)), 'e'.repeat(60)].join('/');
      const selections = sourcePaths.map((sourcePath, index) => ({ sourcePath, destinationPath: `${base}/item-${index}-"🧪.${index === 0 ? 'md' : 'bin'}` }));
      let count = bytes(selections); assert(count < target);
      // Leave the final, potentially occupied filename short. Padding is test
      // data chosen with the actual canonical serializer, not a serializer copy.
      for (const selected of selections.slice(0, -1)) {
        if (count === target) break;
        const add = Math.min(180, target - count), extension = path.posix.extname(selected.destinationPath), before = count;
        selected.destinationPath = selected.destinationPath.slice(0, -extension.length) + 'x'.repeat(add) + extension;
        count = bytes(selections); assert.equal(count - before, add);
      }
      assert.equal(count, target);
      for (const selected of selections) for (const value of [selected.sourcePath, selected.destinationPath]) {
        assert(value.length <= 1024); assert(value.split('/').every(component => Buffer.byteLength(component) <= 255));
      }
      return selections;
    };
    const snapshot = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
        AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)' OR c.relname='file_revisions') ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 11 && tables.length <= 512); const rows: Record<string, unknown> = {};
      for (const table of tables) {
        assert.equal(typeof table.relname, 'string');
        const name = `"${String(table.relname).replaceAll('"', '""')}"`;
        const actual = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert(actual.length <= 10000); rows[table.relname] = actual;
      }
      return { tables, rows };
    };
    const workspaceFiles = async () => {
      const result: unknown[] = [];
      const visit = async (root: string, relative: string, workspaceId: string): Promise<void> => {
        assert(result.length < 10000); const file = path.join(root, relative), info = await fs.lstat(file, { bigint: true }); assert(!info.isSymbolicLink());
        const value = { workspaceId, path: relative, dev: String(info.dev), ino: String(info.ino), mode: String(info.mode), uid: String(info.uid),
          size: String(info.size), nlink: String(info.nlink), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
        result.push(info.isFile() ? { ...value, sha256: sha(await fs.readFile(file)) } : value);
        if (info.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(root, path.join(relative, name), workspaceId);
      };
      for (const workspace of [h.source, h.destination]) await visit(workspace.rootPath, '.', workspace.workspaceId);
      const assetRoot = path.join(h.dataRoot, 'collaboration-assets'); let assetsPresent = true;
      try { await fs.lstat(assetRoot); } catch (error) {
        if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') assetsPresent = false; else throw error;
      }
      if (assetsPresent) await visit(assetRoot, '.', 'owned-asset-storage'); else result.push({ assetStorage: 'absent' });
      return result;
    };
    const budgetError = (error: unknown) => {
      assert(error instanceof NativeCopyRequestTooLargeError); assert.equal(error.code, 'NATIVE_COPY_REQUEST_TOO_LARGE'); assert.equal(error.status, 413); return true;
    };
    const denied = async (selections: readonly WorkspaceOperationNativeCopySelection[], renameOnCollision = false) => {
      const operationId = crypto.randomUUID(), before = await snapshot(), files = await workspaceFiles(), writes: string[] = [];
      const stageNames = (await fs.readdir(path.join(h.dataRoot, 'workspace-operation-staging'))).sort();
      const probe = async (event: MetadataSqlEvent) => {
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\s\S]*?\bSET\b|MERGE\s+INTO|TRUNCATE)\b/iu.test(event.text)
          && /\b(?:collaboration_|file_collaboration_|workspace_file_|file_revisions)/u.test(event.text)) writes.push(event.text);
      };
      await h.withProbe(probe, async () => {
        await assert.rejects(preview({ origin, request: await h.request(), selections, renameOnCollision }), budgetError);
        await assert.rejects(execute({ origin, request: await h.request(), operationId, selections, renameOnCollision }), budgetError);
      });
      assert.deepEqual(writes, [], 'Budget rejection precedes native, clone, metadata and Journal DML.');
      assert.equal(await staging.loadManagedCopyByOperationId(operationId), null);
      assert.deepEqual((await fs.readdir(path.join(h.dataRoot, 'workspace-operation-staging'))).sort(), stageNames);
      assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_operations WHERE operation_id=$1', [operationId])).rows[0].n, 0);
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await workspaceFiles(), files,
        'No source/destination files, prepared directories, names, bytes or identities change. Lock metadata outside workspaces is not compared.');
    };
    const group = async (name: string, action: () => Promise<void>) => { currentCase = name; await action(); groups++; console.log(`PASS native Copy budget PG ${groups}: ${name}`); };
    await group('exact full canonical 65536 UTF-8 bytes including actual Origin passes genuine Owner Preview', async () => {
      const selections = selectionsAt(65536, 'allowed'), plan = await preview({ origin, request: await h.request(), selections });
      assert.deepEqual(plan.selections, selections); assert.equal(bytes(plan.selections), 65536);
      assert.equal(plan.cloneRequirements.length, 1); assert.equal(plan.cloneRequirements[0].sourcePath, sourcePaths[0]);
      assert(plan.sourceEvidence.nativeBindings.some(binding => binding.expected.documentId === native.documentId && binding.expected.path === sourcePaths[0]));
      const canonical = serializeWorkspaceOperationRequest({ kind: 'copy', origin, selections: plan.selections });
      assert(canonical.requestJson.length < 65536); assert(canonical.requestJson.includes('\\"')); assert(canonical.requestJson.includes('🧪'));
    });
    await group('65537 UTF-8 bytes reject Preview and fresh Execute before Stage, clone, Journal or physical preparation', async () => {
      const selections = selectionsAt(65537, 'oversize');
      assert.equal(bytes(selections), 65537); assert(serializeWorkspaceOperationRequest({ kind: 'copy', origin, selections }).requestJson.length < 65536);
      await denied(selections);
    });
    await group('budget follows the real final collision filename: 65532 plus four passes, 65533 plus four rejects early', async () => {
      const prepareCollision = async (size: number, tag: string) => {
        const selections = selectionsAt(size, tag), selected = selections.at(-1)!;
        await fs.mkdir(path.dirname(path.join(h.destination.rootPath, selected.destinationPath)), { recursive: true });
        await fs.writeFile(path.join(h.destination.rootPath, selected.destinationPath), Buffer.from('occupied'), { flag: 'wx', mode: 0o600 });
        return selections;
      };
      const allowed = await prepareCollision(65532, 'collision-allowed');
      const plan = await preview({ origin, request: await h.request(), selections: allowed, renameOnCollision: true });
      const original = allowed.at(-1)!, final = plan.selections.at(-1)!;
      assert.equal(final.sourcePath, original.sourcePath);
      assert.equal(final.destinationPath, path.posix.join(path.posix.dirname(original.destinationPath), 'item-39-"🧪 (1).bin'));
      assert.equal(bytes(allowed), 65532); assert.equal(bytes(plan.selections), 65536);
      const over = await prepareCollision(65533, 'collision-denied'); assert.equal(bytes(over), 65533);
      await denied(over, true);
    });
    await group('small original survives lost actual B1 COMMIT ACK and fixed Recover keeps the original clone IDs and request', async () => {
      const sourcePath = `budget-control-${crypto.randomUUID()}.md`, destinationPath = `budget-recovered-${crypto.randomUUID()}.md`;
      const source = await h.upload(sourcePath, Buffer.from('# Recover budget control\n')), selections = [{ sourcePath, destinationPath }];
      const plan = await preview({ origin, request: await h.request(), selections }), operationId = crypto.randomUUID();
      const encoded = serializeWorkspaceOperationRequest({ kind: 'copy', origin, selections });
      const originalRequest = await h.request();
      let b1Client: MetadataSqlEvent['client'] | undefined, fired = false;
      const interrupted = await h.withProbe(async event => {
        if (/^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(event.text) && event.values.includes(operationId)) b1Client = event.client;
        if (!fired && b1Client === event.client && /^\s*COMMIT\s*$/iu.test(event.text)) {
          assert.equal((await h.admin.query('SELECT publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0].publication_status, 'native_committed');
          fired = true; throw Object.assign(new Error('Actual B1 acknowledgement lost after independently visible COMMIT.'), { code: 'EIO' });
        }
      }, () => execute({ origin, request: originalRequest, operationId, expectedPlanId: plan.planId, selections }));
      assert(fired); assert.equal(interrupted.execution.status, 'needs_recovery'); assert.equal(interrupted.execution.errorCode, 'NATIVE_COPY_COMMIT_UNCONFIRMED');
      const stage = await staging.loadManagedCopyByOperationId(operationId); assert(stage); assert.deepEqual(stage.request, { kind: 'copy', origin, selections });
      const before = (await h.admin.query('SELECT private_result FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0].private_result;
      const resumed = await recover({ origin, request: await h.request(), operationId, expectedPlanId: plan.planId, selections });
      assert.equal(resumed.execution.status, 'complete'); assert.equal(resumed.alreadyKnown, true); assert.deepEqual(resumed.copied, [destinationPath]);
      const after = (await h.admin.query('SELECT private_result,publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
      assert.equal(after.publication_status, 'published'); assert.deepEqual(after.private_result, before);
      assert.equal(before.documents[0].source.documentId, source.documentId);
      const stored = (await h.admin.query('SELECT request_json,request_hash FROM workspace_file_operations WHERE operation_id=$1', [operationId])).rows[0];
      assert.equal(stored.request_json, encoded.requestJson); assert.equal(stored.request_hash, encoded.requestHash);
      assert.equal(await staging.loadManagedCopyByOperationId(operationId), null);
    });
  });
  assert.equal(groups, 4); completed = true;
  console.log('Native Copy request budget PG: 4/4 genuine Web/Owner/PG/FD families; no MCP, SDK, TCP, OAuth or browser acceptance.');
}
void nativeCopyRequestBudgetPostgresTest().catch(error => {
  console.error('Native Copy budget PG failed:', { currentCase, groups, name: error instanceof Error ? error.name : typeof error,
    code: error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1, 7) : undefined }); process.exitCode = 1;
});
