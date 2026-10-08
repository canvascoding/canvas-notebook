import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ElectronApplication, Page } from 'playwright';

export type SharedMcpElectronDesktopPaths = { userData: string; sessionData: string; temp: string; logs: string; crashDumps: string };
export type OwnedSharedMcpElectronReceipt = {
  version: 1; nonce: string; actorId: string; processId: number;
  phase: 'initializing' | 'ready' | 'awaiting_os_consent' | 'finishing' | 'closed' | 'preserved';
  providerOrigin: string; shellAttempts: number; shellAcknowledged: number; shellFailures: number;
  blockedRequests: number; statusRequests: number; uncertain: boolean;
  openings: Array<{ origin: string; urlHash: string; stateHash: string }>;
  barrier: { armed: boolean; held: boolean; refHash?: string; stateHash?: string; workspaceHash?: string | null };
  barrierHistory: Array<{ sequence: number; held: boolean; release: 'pending' | 'entered' | 'acknowledged' | 'failed';
    terminal: 'pending' | 'completed' | 'failed'; heldToReleaseMs?: number; errorName?: 'Error' | 'TypeError' | 'RangeError' | 'UnknownError';
    operation?: 'persist_before' | 'callback' | 'persist_after';
    errorKind?: 'proof_changed' | 'proof_exists' | 'filesystem_missing' | 'filesystem_exists' | 'other';
    networkError?: 'aborted' | 'timed_out' | 'other' }>;
  desktopPaths: SharedMcpElectronDesktopPaths; desktopDirectoryProofs: Record<string, { device: string; inode: string }>;
};
export type OwnedSharedMcpElectron = Readonly<{
  application: ElectronApplication; page: Page; receiptPath: string; processId: number; processGroupId: number;
  desktopPaths: SharedMcpElectronDesktopPaths; nonce: string; fixturePath: string;
}>;
const BASE_URL = 'http://127.0.0.1:3001';
const PATH_NAMES = { userData: 'desktop-user-data', sessionData: 'desktop-session-data', temp: 'desktop-temp',
  logs: 'desktop-logs', crashDumps: 'desktop-crash-dumps' } as const;
const issued = new WeakMap<OwnedSharedMcpElectron, {
  process: ChildProcess; closed: Promise<void>; root: string; rootDevice: string; rootInode: string; actorId: string;
  providerOrigin: string; processGroupId: number; directoryProofs: Record<string, { device: string; inode: string }>;
}>();

/** Validation finishes before importing the runtime launcher or spawning any process. */
export async function launchOwnedSharedMcpElectron(input: { fixturePath: string; providerOrigin: string }): Promise<OwnedSharedMcpElectron> {
  assert.equal(process.env.CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN, '1');
  assert.equal(process.env.CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN, '1');
  assert.equal(process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN, '1');
  assert.equal(process.env.BASE_URL, BASE_URL);
  assert.equal(input.fixturePath, process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE);
  assert(path.isAbsolute(input.fixturePath) && path.basename(input.fixturePath) === 'recovery.json');
  assert.equal(await fs.realpath(input.fixturePath), input.fixturePath);
  const handle = await fs.open(input.fixturePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let fixture: { version: number; nonce: string; repo: string; fixtureRoot: string; tmpRoot: string; rootDevice: string; rootInode: string;
    ownerMarker: string; actorId: string; phase: string; createAcknowledged: boolean; listenerVerified: boolean; uncertain: boolean;
    databaseName: string; serverPid: number; desktopPaths: SharedMcpElectronDesktopPaths;
    desktopDirectoryProofs: Record<string, { device: string; inode: string }>;
    directoryProofs: Record<string, { device: string; inode: string }> };
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size > 1 && stat.size < 64 * 1024);
    fixture = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  assert.equal(fixture.version, 1); assert.match(fixture.nonce, /^[a-f0-9]{32}$/u);
  assert.equal(fixture.phase, 'browser'); assert.equal(fixture.createAcknowledged, true);
  assert.equal(fixture.listenerVerified, true); assert.equal(fixture.uncertain, false);
  assert.equal(fixture.databaseName, `canvas_connection_test_${fixture.nonce}`);
  assert(typeof fixture.actorId === 'string' && fixture.actorId.length > 0);
  assert(Number.isSafeInteger(fixture.serverPid) && fixture.serverPid > 0);
  assert.equal(await fs.realpath(process.cwd()), fixture.repo); assert.equal(path.dirname(input.fixturePath), fixture.fixtureRoot);
  const root = await fs.lstat(fixture.fixtureRoot), tmp = await fs.lstat(fixture.tmpRoot);
  assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(fixture.fixtureRoot), fixture.fixtureRoot);
  assert.equal(String(root.dev), fixture.rootDevice); assert.equal(String(root.ino), fixture.rootInode);
  assert.equal(fixture.tmpRoot, path.join(fixture.fixtureRoot, 'tmp'));
  assert(tmp.isDirectory() && !tmp.isSymbolicLink() && tmp.uid === root.uid && (tmp.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(fixture.tmpRoot), fixture.tmpRoot);
  assert.deepEqual({ device: String(tmp.dev), inode: String(tmp.ino) }, fixture.directoryProofs[fixture.tmpRoot]);
  const marker = await fs.open(path.join(fixture.fixtureRoot, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await marker.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === root.uid && (stat.mode & 0o777) === 0o600 && stat.size < 1024);
    assert.equal(await marker.readFile('utf8'), fixture.ownerMarker);
  } finally { await marker.close(); }
  const paths = JSON.parse(process.env.CANVAS_SHARED_MCP_DESKTOP_PATHS ?? 'null') as SharedMcpElectronDesktopPaths;
  assert.deepEqual(paths, fixture.desktopPaths); assert.equal(Object.keys(paths).length, 5);
  for (const [key, basename] of Object.entries(PATH_NAMES) as Array<[keyof SharedMcpElectronDesktopPaths, string]>) {
    assert.equal(paths[key], path.join(fixture.tmpRoot, basename));
    const stat = await fs.lstat(paths[key]);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === root.uid && (stat.mode & 0o777) === 0o700);
    assert.equal(await fs.realpath(paths[key]), paths[key]);
    assert.deepEqual({ device: String(stat.dev), inode: String(stat.ino) }, fixture.desktopDirectoryProofs[paths[key]]);
  }
  assert.equal(process.env.CANVAS_SHARED_MCP_DESKTOP_RECEIPT, path.join(fixture.fixtureRoot, 'desktop-receipt.json'));
  const provider = new URL(input.providerOrigin);
  assert.equal(provider.origin, input.providerOrigin); assert.equal(provider.protocol, 'https:');
  assert.equal(provider.hostname, '127.0.0.1'); assert(provider.port && provider.port !== '3001' && !provider.username && !provider.password);
  const receiptPath = path.join(fixture.fixtureRoot, 'electron-main-receipt.json');
  await assert.rejects(fs.lstat(receiptPath), { code: 'ENOENT' }, 'Existing native proof files cannot be adopted.');
  const entry = path.join(fixture.repo, 'tests/fixtures/shared-mcp-oauth-electron-main.mjs');
  assert.equal(await fs.realpath(entry), entry);
  const entryStat = await fs.lstat(entry); assert(entryStat.isFile() && !entryStat.isSymbolicLink());
  // Do not resolve require("electron"): that package can lazily install a missing binary.
  const electronRoot = path.join(fixture.repo, 'node_modules/electron');
  const relativeExecutable = (await fs.readFile(path.join(electronRoot, 'path.txt'), 'utf8')).trim();
  assert.equal(relativeExecutable, 'Electron.app/Contents/MacOS/Electron');
  const executablePath = path.join(electronRoot, 'dist', relativeExecutable);
  const executable = await fs.stat(executablePath); assert(executable.isFile());
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  Object.assign(env, { BASE_URL, TMPDIR: paths.temp, CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN: '1',
    CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN: '1', CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1',
    AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: input.fixturePath,
    CANVAS_SHARED_MCP_DESKTOP_PATHS: JSON.stringify(paths),
    CANVAS_SHARED_MCP_DESKTOP_RECEIPT: process.env.CANVAS_SHARED_MCP_DESKTOP_RECEIPT!,
    CANVAS_SHARED_MCP_ELECTRON_PROVIDER_ORIGIN: provider.origin });
  const { _electron } = await import('playwright');
  const application = await _electron.launch({ executablePath, args: [entry], cwd: fixture.repo, env,
    timeout: 60_000, artifactsDir: path.join(fixture.fixtureRoot, 'results'), chromiumSandbox: true });
  const child = application.process();
  assert(Number.isSafeInteger(child.pid) && child.pid! > 0);
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  let processGroupId = 0;
  let page: Page;
  try {
    const group = await new Promise<string>((resolve, reject) => {
      execFile('/bin/ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 },
        (error, stdout) => error ? reject(new Error('The own Electron group identity could not be read.')) : resolve(stdout));
    });
    assert.match(group, /^\s*\d+\s*$/u); processGroupId = Number(group.trim());
    assert(Number.isSafeInteger(processGroupId) && processGroupId > 0 && processGroupId === child.pid);
    page = await application.firstWindow({ timeout: 30_000 });
  } catch {
    let timer: ReturnType<typeof setTimeout> | undefined, closeAcknowledged = false;
    try {
      await Promise.race([Promise.all([application.close(), closed]), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned close unconfirmed.')), 30_000);
      })]);
      closeAcknowledged = true;
    } catch { /* Never force a reported PID or delete the unknown native fixture. */ }
    finally { if (timer) clearTimeout(timer); }
    await fs.writeFile(path.join(fixture.fixtureRoot, 'electron-helper-failure.json'), JSON.stringify({ version: 1,
      nonce: fixture.nonce, processId: child.pid, processGroupId, closeAcknowledged, phase: 'preserved' }), { mode: 0o600, flag: 'wx' });
    throw new Error('The owned Electron window or group did not become ready. Preserve its private failure receipt.');
  }
  const harness = Object.freeze({ application, page, receiptPath, processId: child.pid!, processGroupId, desktopPaths: Object.freeze({ ...paths }),
    nonce: fixture.nonce, fixturePath: input.fixturePath });
  issued.set(harness, { process: child, closed, root: fixture.fixtureRoot, rootDevice: fixture.rootDevice, rootInode: fixture.rootInode,
    actorId: fixture.actorId, providerOrigin: provider.origin, processGroupId, directoryProofs: structuredClone(fixture.desktopDirectoryProofs) });
  return harness;
}

/** The proof is a bounded private observation, never OAuth authority or an OS-tab closure acknowledgement. */
export async function readOwnedSharedMcpElectronReceipt(harness: OwnedSharedMcpElectron): Promise<OwnedSharedMcpElectronReceipt> {
  const receipt = issued.get(harness); assert(receipt, 'Only the issued own Electron process may be observed.');
  const root = await fs.lstat(receipt.root);
  assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(receipt.root), receipt.root);
  assert.equal(String(root.dev), receipt.rootDevice); assert.equal(String(root.ino), receipt.rootInode);
  assert.equal(harness.receiptPath, path.join(receipt.root, 'electron-main-receipt.json'));
  const handle = await fs.open(harness.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: OwnedSharedMcpElectronReceipt;
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === root.uid && (stat.mode & 0o777) === 0o600 && stat.size > 1 && stat.size < 64 * 1024);
    value = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  assert.equal(value.version, 1); assert.equal(value.nonce, harness.nonce); assert.equal(value.actorId, receipt.actorId);
  assert.equal(value.processId, harness.processId); assert.equal(receipt.process.pid, harness.processId);
  assert(['initializing', 'ready', 'awaiting_os_consent', 'finishing', 'closed', 'preserved'].includes(value.phase));
  assert.equal(value.providerOrigin, receipt.providerOrigin); assert.equal(typeof value.uncertain, 'boolean');
  for (const count of [value.shellAttempts, value.shellAcknowledged, value.shellFailures, value.blockedRequests, value.statusRequests]) {
    assert(Number.isSafeInteger(count) && count >= 0 && count <= 5000);
  }
  assert(value.shellAttempts <= 8 && value.shellAcknowledged + value.shellFailures <= value.shellAttempts);
  assert(Array.isArray(value.openings) && value.openings.length === value.shellAttempts);
  for (const opening of value.openings) {
    assert.deepEqual(Object.keys(opening).sort(), ['origin', 'stateHash', 'urlHash']); assert.equal(opening.origin, receipt.providerOrigin);
    assert.match(opening.urlHash, /^[a-f0-9]{64}$/u); assert.match(opening.stateHash, /^[a-f0-9]{64}$/u);
  }
  assert(typeof value.barrier?.armed === 'boolean' && typeof value.barrier.held === 'boolean');
  assert(Object.keys(value.barrier).every(key => ['armed', 'held', 'refHash', 'stateHash', 'workspaceHash'].includes(key)));
  if (value.barrier.refHash !== undefined) assert.match(value.barrier.refHash, /^[a-f0-9]{64}$/u);
  if (value.barrier.stateHash !== undefined) assert.match(value.barrier.stateHash, /^[a-f0-9]{64}$/u);
  if (value.barrier.workspaceHash !== undefined && value.barrier.workspaceHash !== null) assert.match(value.barrier.workspaceHash, /^[a-f0-9]{64}$/u);
  assert(Array.isArray(value.barrierHistory) && value.barrierHistory.length <= 8);
  for (const [index, observation] of value.barrierHistory.entries()) {
    assert(Object.keys(observation).every(key => ['sequence', 'held', 'release', 'terminal', 'heldToReleaseMs', 'errorName', 'networkError', 'operation', 'errorKind'].includes(key)));
    assert.equal(observation.sequence, index + 1); assert.equal(typeof observation.held, 'boolean');
    assert(['pending', 'entered', 'acknowledged', 'failed'].includes(observation.release)); assert(['pending', 'completed', 'failed'].includes(observation.terminal));
    if (observation.heldToReleaseMs !== undefined) assert(Number.isSafeInteger(observation.heldToReleaseMs) && observation.heldToReleaseMs >= 0 && observation.heldToReleaseMs <= 60_000);
    if (observation.errorName !== undefined) assert(['Error', 'TypeError', 'RangeError', 'UnknownError'].includes(observation.errorName));
    if (observation.networkError !== undefined) assert(['aborted', 'timed_out', 'other'].includes(observation.networkError));
    if (observation.operation !== undefined) assert(['persist_before', 'callback', 'persist_after'].includes(observation.operation));
    if (observation.errorKind !== undefined) assert(['proof_changed', 'proof_exists', 'filesystem_missing', 'filesystem_exists', 'other'].includes(observation.errorKind));
    if (observation.release === 'failed') assert.equal(value.uncertain, true);
  }
  assert.deepEqual(value.desktopPaths, harness.desktopPaths); assert.deepEqual(value.desktopDirectoryProofs, receipt.directoryProofs);
  // Whitelist the observation; an unexpected field cannot enter the public native receipt.
  return { version: 1, nonce: value.nonce, actorId: value.actorId, processId: value.processId, phase: value.phase,
    providerOrigin: value.providerOrigin, shellAttempts: value.shellAttempts, shellAcknowledged: value.shellAcknowledged,
    shellFailures: value.shellFailures, blockedRequests: value.blockedRequests, statusRequests: value.statusRequests,
    uncertain: value.uncertain, openings: value.openings, barrier: value.barrier, barrierHistory: value.barrierHistory,
    desktopPaths: value.desktopPaths, desktopDirectoryProofs: value.desktopDirectoryProofs };
}

/** A successful return confirms the owned child close event, not the independent macOS browser's tabs. */
export async function closeOwnedSharedMcpElectron(harness: OwnedSharedMcpElectron): Promise<{ processId: number; processGroupId: number; closed: true }> {
  const receipt = issued.get(harness); assert(receipt, 'Only the issued own Electron child may be closed.');
  assert(Number.isSafeInteger(harness.processId) && harness.processId > 0 && receipt.process.pid === harness.processId);
  assert.equal(harness.processGroupId, harness.processId); assert.equal(receipt.processGroupId, harness.processGroupId);
  await harness.application.evaluate(async () => {
    const control = (globalThis as typeof globalThis & { __canvasOwnedSharedMcpElectron?: { finishOwnedElectronHarness: () => Promise<boolean> } }).__canvasOwnedSharedMcpElectron;
    if (!control || await control.finishOwnedElectronHarness() !== true) throw new Error('The own Electron shutdown could not be acknowledged.');
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all([harness.application.close(), receipt.closed]), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The owned Electron child close is unconfirmed. Preserve the private fixture.')), 30_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
  const groupDeadline = Date.now() + 5_000;
  let groupAbsent = false;
  while (!groupAbsent && Date.now() < groupDeadline) {
    try { process.kill(-receipt.processGroupId, 0); }
    catch (error) { groupAbsent = (error as { code?: string }).code === 'ESRCH'; }
    if (!groupAbsent) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(groupAbsent, 'The exact owned Electron process group remains unconfirmed. Preserve the private fixture.');
  const proof = await readOwnedSharedMcpElectronReceipt(harness);
  assert.equal(proof.phase, 'closed'); assert.equal(proof.uncertain, false);
  assert.equal(proof.barrier.armed, false); assert.equal(proof.barrier.held, false);
  assert.equal(proof.shellAttempts, proof.shellAcknowledged + proof.shellFailures);
  return { processId: harness.processId, processGroupId: receipt.processGroupId, closed: true };
}
