/** Pure phase-ownership regression for the complete current Executor.
 * Executes the complete original Executor module at test time, without copying
 * its algorithm. Only the PG lifecycle boundary and operation adapters are fake.
 * Kernel/flock, planner, filesystem transitions and journal are real.
 * This proves phase ownership, not genuine PG/native-Yjs/public-route behavior.
 */
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { buildWorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import { buildWorkspacePlannerSnapshot } from '../app/lib/markdown/workspace-file-operation-preview';
import { groupWorkspaceLinkWrites } from '../app/lib/markdown/workspace-link-write-groups';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import { getWorkspaceFileLifecycleLeases, withWorkspaceFileLifecycleLeases,
  type WorkspaceFileLifecycleLease } from '../app/lib/collaboration/file-lifecycle-admission-context';
import { WorkspaceFileLifecycleBusyError } from '../app/lib/files/workspace-file-lifecycle-guard';
import type * as Executor from '../app/lib/files/workspace-operation-batch-executor';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceTrashEntry } from '../app/lib/filesystem/workspace-trash';

const repo = process.cwd();
const requireLocal = createRequire(path.join(repo, 'package.json'));
const ts = requireLocal('typescript') as typeof import('typescript');
const { Pool, Client } = requireLocal('pg') as typeof import('pg');
const executorFile = path.join(repo, 'app/lib/files/workspace-operation-batch-executor.ts');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type KernelLockIdentity = { dev: string; ino: string; nlink: string; uid: string };
const kernelLockIdentity = (stat: BigIntStats): KernelLockIdentity => ({
  dev: stat.dev.toString(), ino: stat.ino.toString(), nlink: stat.nlink.toString(), uid: stat.uid.toString(),
});
const independentKernelLockProbe = String.raw`
import errno, fcntl, json, os, stat, sys
expected = json.loads(sys.argv[2])
def identity(value):
    return {"dev": str(value.st_dev), "ino": str(value.st_ino), "nlink": str(value.st_nlink), "uid": str(value.st_uid)}
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    before_stat = os.fstat(fd)
    before = identity(before_stat)
    if before != expected or not stat.S_ISREG(before_stat.st_mode) or before_stat.st_nlink != 1 or before_stat.st_uid != os.geteuid() or stat.S_IMODE(before_stat.st_mode) & 0o077:
        raise RuntimeError("Independent kernel probe lock identity is unsafe or changed.")
    blocked = False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
            raise
        blocked = True
    after_stat = os.fstat(fd)
    after = identity(after_stat)
    if after != expected or not stat.S_ISREG(after_stat.st_mode) or after_stat.st_nlink != 1 or after_stat.st_uid != os.geteuid() or stat.S_IMODE(after_stat.st_mode) & 0o077:
        raise RuntimeError("Independent kernel probe lock identity changed after flock.")
    print(json.dumps({"blocked": blocked, "before": before, "after": after}), flush=True)
finally:
    os.close(fd)
`;

/** A separate open file description tests the real OS flock, without waiting
 * for the lock and without inspecting or emulating the product's local queue.
 * The 2s limit closes this helper only; it is not a document/domain retry.
 */
async function assertIndependentKernelLockBlocked(dataRoot: string, workspaceId: string): Promise<void> {
  const lockPath = path.join(dataRoot, 'canvas-file-locks', `${hash(workspaceId)}.lock`);
  const rootHandle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await rootHandle.stat({ bigint: true });
    assert(before.isFile()); assert.equal(before.nlink, BigInt(1));
    const ownerUid = process.geteuid?.(); assert.notEqual(ownerUid, undefined);
    assert.equal(before.uid, BigInt(ownerUid!)); assert.equal(before.mode & BigInt(0o077), BigInt(0));
    const expected = kernelLockIdentity(before);
    assert.deepEqual(kernelLockIdentity(await fs.lstat(lockPath, { bigint: true })), expected);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3',
        ['-I', '-c', independentKernelLockProbe, lockPath, JSON.stringify(expected)],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', spawnError: Error | undefined, timedOut = false, overflow = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 2_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 4_096) { overflow = true; stdout = stdout.slice(0, 4_096); child.kill('SIGKILL'); } });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 4_096) { overflow = true; stderr = stderr.slice(0, 4_096); child.kill('SIGKILL'); } });
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (spawnError) reject(spawnError);
        else if (timedOut) reject(new Error('Independent kernel NB probe exceeded its 2s helper closure limit.'));
        else if (overflow) reject(new Error('Independent kernel NB probe returned oversized output.'));
        else resolve({ code, signal, stdout, stderr });
      });
    });
    assert.equal(result.signal, null); assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const proof = JSON.parse(result.stdout) as { blocked: unknown; before: KernelLockIdentity; after: KernelLockIdentity };
    assert.deepEqual(proof.before, expected); assert.deepEqual(proof.after, expected);
    assert.deepEqual(kernelLockIdentity(await rootHandle.stat({ bigint: true })), expected);
    assert.deepEqual(kernelLockIdentity(await fs.lstat(lockPath, { bigint: true })), expected);
    assert.equal(proof.blocked, true, 'the same private lock inode must reject an independent nonblocking exclusive flock before checkpoint publication');
  } finally { await rootHandle.close(); }
}

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-legacy-publication-phase-'));
  const previous = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT };
  const poolQuery = Object.getOwnPropertyDescriptor(Pool.prototype, 'query');
  const poolConnect = Object.getOwnPropertyDescriptor(Pool.prototype, 'connect');
  const clientQuery = Object.getOwnPropertyDescriptor(Client.prototype, 'query');
  const clientConnect = Object.getOwnPropertyDescriptor(Client.prototype, 'connect');
  let forbiddenDatabaseAttempts = 0;
  const noDatabase = () => { forbiddenDatabaseAttempts++; throw new Error('PG access is forbidden in this pure phase fixture.'); };
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, value: noDatabase });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, writable: true, value: noDatabase });
  Object.defineProperty(Client.prototype, 'query', { configurable: true, writable: true, value: noDatabase });
  Object.defineProperty(Client.prototype, 'connect', { configurable: true, writable: true, value: noDatabase });
  Object.assign(process.env, { DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot });
  const originalSource = await fs.readFile(executorFile, 'utf8');
  const sourceHash = hash(originalSource);
  const checks: Array<{ name: string; passed: true }> = [];
  let guardEntries = 0, guardCloses = 0;
  const ownedLeases: WorkspaceFileLifecycleLease[] = [];

  // Boundary model only: the actual production guard owns this same kernel
  // around a session lease. This mock performs no SQL and grants no native B.
  const lifecycle = async <T>(input: { workspaceId: string; paths: readonly string[] }, operation: () => Promise<T>): Promise<T> => {
    guardEntries++;
    return withWorkspaceMutationLock(input.workspaceId, async () => {
      const lease: WorkspaceFileLifecycleLease = { active: true, verify: async () => lease.active };
      ownedLeases.push(lease);
      const leases = new Map(getWorkspaceFileLifecycleLeases()); leases.set(input.workspaceId, lease);
      try { return await withWorkspaceFileLifecycleLeases(leases, operation); }
      finally { lease.active = false; guardCloses++; }
    });
  };
  const require = createRequire(executorFile);
  const exports = {};
  try {
    // Evaluate the current complete source; no copy of its control flow.
    const compiled = ts.transpileModule(originalSource, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } });
    new Function('require', 'module', 'exports', compiled.outputText)((specifier: string) => {
      if (specifier === 'server-only') return {};
      if (specifier === './workspace-file-lifecycle-guard') return {
        withWorkspaceFileLifecycleGuard: lifecycle,
        WorkspaceFileLifecycleBusyError,
      };
      return require(specifier);
    }, { exports }, exports);
    const createExecutor = (exports as typeof Executor).createWorkspaceOperationBatchExecutor;

    for (const name of ['separate-publication-phase', 'inherited-active-rejected', 'inherited-inactive-allowed'] as const) {
      const folder = path.join(dataRoot, name); await fs.mkdir(folder, { mode: 0o700 });
      const workspace: WorkspaceContext = { workspaceId: `phase-${name}`, workspaceType: 'personal',
        rootPath: path.join(folder, 'workspace'), rootRelativePath: `${name}/workspace`,
        actor: { userId: 'tester', role: 'owner' }, ownerUserId: 'tester', organizationId: null,
        legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true,
          canRunAgent: true, canCreatePublicLinks: false, canManageWorkspace: true } };
      const scope: WorkspaceOperationBatchScope = { workspace, fileOptions: { workspace } };
      await fs.mkdir(workspace.rootPath, { mode: 0o700 });
      const target = 'owned.pdf', source = 'incoming.md', targetBytes = Buffer.from('%PDF-1.7\nowned pure fixture\n');
      const sourceText = '[Owned asset](owned.pdf)\n\nKeep this paragraph.\n';
      const absolute = (relative: string) => path.join(workspace.rootPath, relative);
      await fs.writeFile(absolute(target), targetBytes, { mode: 0o600, flag: 'wx' });
      await fs.writeFile(absolute(source), sourceText, { mode: 0o600, flag: 'wx' });
      const build = async (input: Parameters<typeof buildWorkspaceOperationBatchPlan>[0]) => {
        const result = await buildWorkspaceOperationBatchPlan(input, { buildSnapshot: buildWorkspacePlannerSnapshot });
        assert.equal(result.version, 1);
        if (result.version !== 1) assert.fail('This regression requires the legacy asset plan.');
        return result;
      };
      const plan = await build({ scope, actions: [{ reviewId: randomUUID(), kind: 'delete', selections: [{ sourcePath: target }] }] });
      assert.equal(plan.readiness, 'ready'); assert.deepEqual(plan.issues, []);
      assert.equal(groupWorkspaceLinkWrites(plan.linkPlan).length, 1);
      const batchId = randomUUID(), storageRoot = path.join(folder, 'manifests');
      const journal = path.join(storageRoot, `${batchId}.json`);
      const counts = { backup: 0, preflight: 0, path: 0, link: 0, checkpoint: 0 };
      const trashEntries = new Map<string, WorkspaceTrashEntry>();
      const pendingText = new Map<string, string>();
      const independent = new AsyncResource(`independent-phase-contender-${name}`);
      let contender: Promise<void> | undefined, contenderEntered = false;
      const started = gate();
      const assertApplyingLease = async () => {
        const lease = getWorkspaceFileLifecycleLeases()?.get(workspace.workspaceId);
        assert.equal(lease?.active, true, 'actual apply callbacks require the enclosing lifecycle lease');
        assert.equal(await lease?.verify(), true);
      };
      const beforeEntries = guardEntries, beforeCloses = guardCloses;
      const executor = createExecutor({
        storageRoot, readBatch: async () => null, rebuild: build, snapshot: buildWorkspacePlannerSnapshot,
        htmlEvidenceCurrent: async () => {}, documentProof: async () => null,
        // Deliberately not a backup/content correctness fixture. The adapter
        // counts this premutation boundary without invoking its SQL catalogue.
        backup: async input => {
          counts.backup++; await assertApplyingLease();
          return { version: 1, backupId: `opb-${hash(input.operationId + input.path)}`,
            operationId: input.operationId, workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
            organizationId: null, originalPath: input.path, itemType: 'file', capturedAt: new Date().toISOString(),
            retention: 'until_manual_cleanup', sizeBytes: 0, fileCount: 0, directoryCount: 0,
            contentSha256: hash(''), entries: [] };
        },
        preflight: async input => {
          counts.preflight++; await assertApplyingLease();
          return { planId: input.plan.planId, sources: groupWorkspaceLinkWrites(input.plan).map(group => ({
            sourceWorkspaceId: workspace.workspaceId, sourcePathBefore: group.sourcePathBefore,
            beforeSha256: group.beforeSha256, documentId: null, mode: 'plain-file' as const,
          })) };
        },
        trash: async input => {
          counts.path++; await assertApplyingLease();
          const selected = input.paths[0]; assert.equal(selected, target);
          const id = `trash-${randomUUID()}`, trashRelativePath = `${name}/trash-${id}`;
          await fs.rename(absolute(selected), path.join(dataRoot, trashRelativePath));
          const entry: WorkspaceTrashEntry = { id, organizationId: null, workspaceId: workspace.workspaceId,
            workspaceType: workspace.workspaceType, ownerUserId: 'tester', originalPath: selected,
            trashRelativePath, entryName: selected, itemType: 'file', sizeBytes: targetBytes.length,
            fileCount: 1, directoryCount: 0, status: 'trashed', deletedByUserId: 'tester', restoredByUserId: null,
            purgedByUserId: null, deletedAt: new Date(), expiresAt: new Date(Date.now() + 86400_000),
            restoredAt: null, purgedAt: null, metadataJson: null };
          trashEntries.set(entry.id, entry);
          return { trashed: [entry], failed: [] };
        },
        listTrash: async input => {
          assert.equal(input.workspace.workspaceId, workspace.workspaceId);
          assert.equal(input.status, 'trashed');
          return [...trashEntries.values()].slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 1000));
        },
        archive: async () => { await assertApplyingLease(); }, sharesDeleted: async () => { await assertApplyingLease(); },
        probeLink: async (_input, group) => {
          const content = pendingText.get(group.path) ?? await fs.readFile(absolute(group.path), 'utf8');
          return hash(content) === group.afterSha256 ? 'after' : hash(content) === group.beforeSha256 ? 'before' : 'unknown';
        },
        applyLink: async (_input, group) => {
          counts.link++; await assertApplyingLease();
          assert.equal(hash(await fs.readFile(absolute(group.path))), group.beforeSha256);
          pendingText.set(group.path, group.afterContent);
          return { workspaceId: workspace.workspaceId, path: group.path, beforeSha256: group.beforeSha256,
            afterSha256: group.afterSha256, status: 'applied', mode: 'plain-file', documentId: null };
        },
        checkpointLink: async (_input, group) => {
          counts.checkpoint++;
          assert.notEqual(getWorkspaceFileLifecycleLeases()?.get(workspace.workspaceId)?.active, true,
            'projection must start after the exclusive lifecycle lease ended');
          assert.equal(guardCloses, beforeCloses + 1, 'the lifecycle owner finally completed before publication');
          const stored = JSON.parse(await fs.readFile(journal, 'utf8')) as { payload: string; sha256: string };
          assert.equal(hash(stored.payload), stored.sha256);
          const durable = JSON.parse(stored.payload) as { steps: Array<{ state: string }>; status: string };
          assert(durable.steps.length >= 2); assert(durable.steps.every(step => step.state === 'applied'));
          assert.notEqual(durable.status, 'applied', 'saved path/link receipts are not a false final checkpoint acknowledgement');
          assert.equal(hash(pendingText.get(group.path)!), group.afterSha256);
          if (!contender) contender = independent.runInAsyncScope(() => (async () => {
            started.resolve();
            await withWorkspaceMutationLock(workspace.workspaceId, async () => {
              contenderEntered = true;
              const envelope = JSON.parse(await fs.readFile(journal, 'utf8')) as { payload: string; sha256: string };
              assert.equal(hash(envelope.payload), envelope.sha256);
              assert.equal(JSON.parse(envelope.payload).status, 'applied',
                'independent kernel contender enters only after the final durable journal commit');
            });
          })());
          await started.promise;
          // A separate OFD must observe the real OS lock as busy before we
          // publish. Combined with the existing contender assertion below,
          // neither a slow contender nor scheduling can hide a missing owner.
          await assertIndependentKernelLockBlocked(dataRoot, workspace.workspaceId);
          assert.equal(contenderEntered, false, 'outer kernel remains held while publication is in progress');
          await fs.writeFile(absolute(group.path), group.afterContent); pendingText.delete(group.path);
        },
      });
      const execute = () => executor.execute({ batchId, plan, scope, actorUserId: 'tester', actorDisplayName: 'Tester' });
      try {
        if (name === 'inherited-active-rejected') {
          const inherited: WorkspaceFileLifecycleLease = { active: true, verify: async () => true };
          await withWorkspaceFileLifecycleLeases(new Map([[workspace.workspaceId, inherited]]), () =>
            assert.rejects(execute(), error => error instanceof Error && 'code' in error
              && error.code === 'COLLABORATION_FILE_LIFECYCLE_BUSY'));
          assert.deepEqual(counts, { backup: 0, preflight: 0, path: 0, link: 0, checkpoint: 0 });
          assert.equal(guardEntries, beforeEntries, 'reject inherited active scope before opening another lifecycle boundary');
          await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
          assert.deepEqual(await fs.readFile(absolute(target)), targetBytes);
          assert.equal(await fs.readFile(absolute(source), 'utf8'), sourceText);
        } else {
          const outcome = name === 'inherited-inactive-allowed'
            ? await withWorkspaceFileLifecycleLeases(new Map([[workspace.workspaceId,
              { active: false, verify: async () => false }]]), execute)
            : await execute();
          assert.equal(outcome.status, 'applied', outcome.errorCode ?? '');
          assert.equal(outcome.completedActions, outcome.totalActions);
          assert.equal(guardEntries, beforeEntries + 1); assert.equal(guardCloses, beforeCloses + 1);
          assert.equal(counts.path, 1); assert.equal(counts.link, 1); assert.equal(counts.checkpoint, 1);
          assert(counts.backup > 0); assert.equal(counts.preflight, 1);
          await contender; assert.equal(contenderEntered, true);
          assert.equal(await fs.readFile(absolute(source), 'utf8'), 'Owned asset\n\nKeep this paragraph.\n');
          await assert.rejects(fs.stat(absolute(target)), { code: 'ENOENT' });
        }
        checks.push({ name, passed: true });
      } finally { await contender; independent.emitDestroy(); }
    }
    assert.equal(forbiddenDatabaseAttempts, 0); assert(ownedLeases.every(lease => !lease.active));
    assert.equal(hash(await fs.readFile(executorFile)), sourceHash, 'the original Executor source stayed unchanged during the test');
    assert.equal(checks.length, 3);
    console.log(JSON.stringify({ suite: 'legacy-publication-phase-pure', checks, sourceHash,
      scope: 'Actual original Executor, FS/journal/planner/kernel; fake lifecycle SQL boundary and operation adapters. No genuine PG/native-Yjs/public-route claim.' }));
  } finally {
    if (poolQuery) Object.defineProperty(Pool.prototype, 'query', poolQuery); else Reflect.deleteProperty(Pool.prototype, 'query');
    if (poolConnect) Object.defineProperty(Pool.prototype, 'connect', poolConnect); else Reflect.deleteProperty(Pool.prototype, 'connect');
    if (clientQuery) Object.defineProperty(Client.prototype, 'query', clientQuery); else Reflect.deleteProperty(Client.prototype, 'query');
    if (clientConnect) Object.defineProperty(Client.prototype, 'connect', clientConnect); else Reflect.deleteProperty(Client.prototype, 'connect');
    for (const key of ['DATA', 'CANVAS_DATA_ROOT'] as const) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

let completed = false;
process.once('beforeExit', () => { if (!completed) { console.error('legacy-publication-phase-pure: INCOMPLETE'); process.exitCode = 1; } });
void main().then(() => {
  completed = true;
  console.log('legacy-publication-phase-pure: COMPLETED: all three phase assertions and cleanup settled.');
}).catch(error => { console.error(error); process.exitCode = 1; });
