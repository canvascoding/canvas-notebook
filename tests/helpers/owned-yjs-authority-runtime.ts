import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { OwnedNativeFileRoomReadInput } from '../../scripts/lib/owned-yjs-native-delete-links-room-target';
import { assertOrigin, requireOwnedYjsQaTarget } from '../../scripts/lib/owned-yjs-authority-qa';

/** Test supervisor control, never an application endpoint or a stored-PID kill. */
export async function restartOwnedYjsAuthorityHost(mode: 'graceful' | 'crash'): Promise<void> {
  const before = await requireOwnedYjsQaTarget();
  const endpoint = new URL(process.env.CANVAS_YJS_QA_RESTART_URL ?? '');
  assert.equal(endpoint.pathname, '/restart');
  const origin = new URL(endpoint); origin.pathname = '/'; assertOrigin(origin.href);
  assert.notEqual(origin.port, String(before.port));
  const token = process.env.CANVAS_YJS_QA_RESTART_TOKEN; assert(token && token.length >= 48);
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: before.nonce, mode }) });
  assert.equal(response.status, 200, 'Owned supervisor restart was not confirmed.');
  const value = await response.json() as { success: boolean; nonce: string; restartCount: number };
  assert.equal(value.success, true); assert.equal(value.nonce, before.nonce); assert.equal(value.restartCount, before.restartCount + 1);
  const after = await requireOwnedYjsQaTarget();
  for (const key of ['fixtureRoot', 'rootDevice', 'rootInode', 'dataRoot', 'dataDevice', 'dataInode',
    'databaseName', 'databaseOid', 'databaseOwner', 'ownerMarker', 'head', 'sourceFingerprint', 'buildFingerprint', 'port'] as const) {
    assert.equal(after[key], before[key], `Restart changed the owned fixture (${key}).`);
  }
  assert.equal(after.restartCount, before.restartCount + 1);
  assert.notEqual(`${after.serverPid}:${after.serverStart}`, `${before.serverPid}:${before.serverStart}`);
}

export type OwnedNativeMoveSharedHolder = Readonly<{
  held: Readonly<{ version: 1; kind: 'owned-native-move-shared-holder'; phase: 'held'; nonce: string;
    workspaceId: string; documentId: string; databaseOid: string; pid: number; backendStart: string;
    key: string; high: number; low: number; mode: 'ShareLock'; lockCount: 1; scopeProof: string; ownerEpoch: number }>;
  release(): Promise<void>;
}>;

/** One fixed owned Move-room child, with actual PG shared-lock/close receipts.
 * The held input is comparison data; this helper grants no application rights. */
export async function holdOwnedNativeMoveSharedRoom(input: OwnedNativeFileRoomReadInput): Promise<OwnedNativeMoveSharedHolder> {
  const owned = await requireOwnedYjsQaTarget();
  assert.equal(owned.activeSpec, 'tests/workspace-operation-native-move.spec.ts');
  const wire = Buffer.from(JSON.stringify(input)).toString('base64url'); assert(wire.length <= 8 * 1024);
  const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx',
    'scripts/owned-yjs-native-move-room-read.ts', wire, '--hold-shared'], {
    cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let failure: unknown, didExit = false, exitCode: number | null = null, signal: NodeJS.Signals | null = null;
  let pending = '', bytes = 0, errorBytes = 0;
  let held: OwnedNativeMoveSharedHolder['held'] | undefined, final: Record<string, unknown> | undefined;
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const fail = (error: unknown) => { failure ??= error; rejectReady(failure); };
  const readinessTimeout = setTimeout(() => { fail(new Error('Owned Move holder readiness timed out.')); child.stdin.end(); }, 30_000);
  const watchdog = setTimeout(() => { fail(new Error('Owned Move holder exceeded its fixed lifetime.')); if (!didExit) child.kill('SIGTERM'); }, 110_000);
  child.once('error', error => fail(error));
  child.stdin.on('error', error => fail(error));
  child.once('exit', (code, stopped) => { didExit = true; exitCode = code; signal = stopped; });
  child.once('close', () => {
    clearTimeout(readinessTimeout); clearTimeout(watchdog);
    if (!held) fail(new Error('Owned Move holder exited before readiness.'));
    resolveClosed();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    try {
      bytes += Buffer.byteLength(chunk); assert(bytes <= 64 * 1024);
      pending += chunk;
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const row = JSON.parse(pending.slice(0, end)) as Record<string, unknown>; pending = pending.slice(end + 1);
        assert.equal(row.version, 1); assert.equal(row.kind, 'owned-native-move-shared-holder');
        assert.equal(row.nonce, owned.nonce); assert.equal(row.workspaceId, input.room.expectedWorkspaceId);
        assert.equal(row.documentId, input.room.documentId); assert.equal(row.databaseOid, owned.databaseOid);
        assert(Number.isSafeInteger(row.pid) && Number(row.pid) > 0);
        assert(typeof row.backendStart === 'string' && /^[0-9]+(?:\.[0-9]+)?$/u.test(row.backendStart));
        assert(typeof row.key === 'string' && /^-?[0-9]+$/u.test(row.key));
        assert(Number.isSafeInteger(row.high) && Number(row.high) >= 0 && Number(row.high) <= 0xffffffff);
        assert(Number.isSafeInteger(row.low) && Number(row.low) >= 0 && Number(row.low) <= 0xffffffff);
        assert.equal(row.mode, 'ShareLock'); assert(typeof row.scopeProof === 'string' && /^[a-f0-9]{64}$/u.test(row.scopeProof));
        assert(Number.isSafeInteger(row.ownerEpoch) && Number(row.ownerEpoch) > 0);
        if (row.phase === 'held') {
          assert(!held && !final); assert.equal(row.lockCount, 1);
          held = Object.freeze(row) as OwnedNativeMoveSharedHolder['held']; clearTimeout(readinessTimeout); resolveReady();
        } else {
          assert.equal(row.phase, 'closed'); assert(held && !final);
          assert.deepEqual({ ...row, phase: 'held', lockCount: 1, backendAbsent: undefined, lockAbsent: undefined },
            { ...held, backendAbsent: undefined, lockAbsent: undefined });
          assert.equal(row.lockCount, 0); assert.equal(row.backendAbsent, true); assert.equal(row.lockAbsent, true);
          final = row;
        }
      }
    } catch (error) { fail(error); child.stdin.end(); }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errorBytes += chunk.length;
    if (errorBytes > 64 * 1024) { fail(new Error('Owned Move holder diagnostics exceeded their bound.')); child.stdin.end(); }
  });
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => releasing ??= (async () => {
    if (!didExit && !child.stdin.destroyed) child.stdin.end('release\n');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let kill: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        kill = setTimeout(() => { if (!didExit) child.kill('SIGTERM'); }, 15_000);
        timeout = setTimeout(() => { if (!didExit) child.kill('SIGKILL'); reject(new Error('Owned Move holder child exit remains unconfirmed.')); }, 20_000);
      })]);
      assert(didExit && exitCode === 0 && signal === null && held && final && !pending && !failure,
        'Owned Move shared-lock release and backend closure were not confirmed.');
    } finally { if (timeout) clearTimeout(timeout); if (kill) clearTimeout(kill); clearTimeout(readinessTimeout); clearTimeout(watchdog); }
  })();
  try { await ready; assert(held); return Object.freeze({ held, release }); }
  catch (error) {
    try { await release(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Owned Move holder failed before readiness and cleanup failed.'); }
    throw error;
  }
}
