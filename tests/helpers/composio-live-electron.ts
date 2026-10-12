import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ElectronApplication, Page } from 'playwright';

export type ComposioLiveElectron = Readonly<{ application: ElectronApplication; page: Page; processId: number; processGroupId: number; receiptPath: string; nonce: string }>;
export type ComposioLiveMainReceipt = { version: 1; nonce: string; processId: number; phase: string; shellAttempts: number; shellAcknowledged: number; blockedRequests: number; uncertain: boolean; openings: Array<{ origin: string; urlHash: string; stateHash: string }> };
const issued = new WeakMap<ComposioLiveElectron, { child: ChildProcess; closed: Promise<void> }>();
export async function launchComposioLiveElectron(input: { fixturePath: string }): Promise<ComposioLiveElectron> {
  assert.equal(process.env.CANVAS_COMPOSIO_LIVE_BROWSER_RUN, '1'); assert.equal(process.env.BASE_URL, 'http://127.0.0.1:3001');
  assert.equal(input.fixturePath, process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE); assert(path.isAbsolute(input.fixturePath));
  assert.equal(await fs.realpath(input.fixturePath), input.fixturePath);
  const file = await fs.open(input.fixturePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let fixture: { nonce: string; fixtureRoot: string; repo: string; liveProvider: string; nativeProvider: string; desktopPaths: Record<string, string>; desktopDirectoryProofs: Record<string, { device: string; inode: string }> };
  try { const stat = await file.stat(); assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 65536); fixture = JSON.parse(await file.readFile('utf8')); }
  finally { await file.close(); }
  assert.match(fixture.nonce, /^[a-f0-9]{32}$/u); assert.equal(fixture.liveProvider, 'composio'); assert.equal(fixture.nativeProvider, 'composio');
  assert.equal(fixture.repo, await fs.realpath(process.cwd())); assert.equal(path.dirname(input.fixturePath), fixture.fixtureRoot);
  assert.deepEqual(JSON.parse(process.env.CANVAS_COMPOSIO_LIVE_DESKTOP_PATHS ?? 'null'), fixture.desktopPaths);
  const names = { userData: 'desktop-user-data', sessionData: 'desktop-session-data', temp: 'desktop-temp', logs: 'desktop-logs', crashDumps: 'desktop-crash-dumps' };
  assert.equal(Object.keys(fixture.desktopPaths).length, 5);
  for (const [key, basename] of Object.entries(names)) {
    const directory = fixture.desktopPaths[key]; assert.equal(directory, path.join(fixture.fixtureRoot, 'tmp', basename));
    const stat = await fs.lstat(directory); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
    assert.equal(await fs.realpath(directory), directory); assert.deepEqual({ device: String(stat.dev), inode: String(stat.ino) }, fixture.desktopDirectoryProofs[directory]);
  }
  const receiptPath = path.join(fixture.fixtureRoot, 'composio-live-main-receipt.json'); await assert.rejects(fs.lstat(receiptPath), { code: 'ENOENT' });
  const electronRoot = path.join(fixture.repo, 'node_modules/electron');
  assert.equal((await fs.readFile(path.join(electronRoot, 'path.txt'), 'utf8')).trim(), 'Electron.app/Contents/MacOS/Electron');
  const executablePath = path.join(electronRoot, 'dist/Electron.app/Contents/MacOS/Electron'); assert((await fs.stat(executablePath)).isFile());
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  Object.assign(env, { BASE_URL: process.env.BASE_URL, CANVAS_COMPOSIO_LIVE_BROWSER_RUN: '1', TMPDIR: fixture.desktopPaths.temp,
    AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: input.fixturePath, CANVAS_COMPOSIO_LIVE_DESKTOP_PATHS: JSON.stringify(fixture.desktopPaths) });
  const { _electron } = await import('playwright');
  const application = await _electron.launch({ executablePath, args: [path.join(fixture.repo, 'tests/fixtures/composio-live-electron-main.mjs')],
    cwd: fixture.repo, env, chromiumSandbox: true, timeout: 60_000 });
  const child = application.process(); assert(Number.isSafeInteger(child.pid) && child.pid! > 0);
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let processGroupId = 0;
  let page: Page;
  try {
    const group = await new Promise<string>((resolve, reject) => execFile('/bin/ps', ['-o', 'pgid=', '-p', String(child.pid)],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 }, (error, output) => error ? reject(new Error('Owned group unavailable.')) : resolve(output)));
    assert.match(group, /^\s*\d+\s*$/u); processGroupId = Number(group.trim()); assert.equal(processGroupId, child.pid);
    page = await application.firstWindow({ timeout: 30_000 });
  } catch {
    let timer: ReturnType<typeof setTimeout> | undefined, acknowledged = false;
    try { await Promise.race([Promise.all([application.close(), closed]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Unconfirmed close.')), 30_000); })]); acknowledged = true; }
    catch { /* Preserve all own data when closure is unknown. */ }
    finally { if (timer) clearTimeout(timer); }
    await fs.writeFile(path.join(fixture.fixtureRoot, 'composio-live-launch-failure.json'), JSON.stringify({ version: 1, nonce: fixture.nonce, processId: child.pid, processGroupId, closeAcknowledged: acknowledged }), { mode: 0o600, flag: 'wx' });
    throw new Error('The own live Electron did not become ready; preserve the fixture.');
  }
  const result = Object.freeze({ application, page, processId: child.pid!, processGroupId, receiptPath, nonce: fixture.nonce }); issued.set(result, { child, closed }); return result;
}
export async function readComposioLiveElectronReceipt(harness: ComposioLiveElectron): Promise<ComposioLiveMainReceipt> {
  const own = issued.get(harness); assert(own && own.child.pid === harness.processId);
  const file = await fs.open(harness.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 65536);
    const value = JSON.parse(await file.readFile('utf8')) as ComposioLiveMainReceipt;
    assert.equal(value.version, 1); assert.equal(value.nonce, harness.nonce); assert.equal(value.processId, harness.processId);
    assert.equal(typeof value.uncertain, 'boolean'); assert(['initializing', 'ready', 'finishing', 'closed'].includes(value.phase));
    for (const count of [value.shellAttempts, value.shellAcknowledged, value.blockedRequests]) assert(Number.isSafeInteger(count) && count >= 0);
    assert(value.shellAttempts <= 2 && value.shellAcknowledged <= value.shellAttempts); assert.equal(value.openings.length, value.shellAttempts);
    for (const opening of value.openings) { assert.deepEqual(Object.keys(opening).sort(), ['origin', 'stateHash', 'urlHash']); assert(['https://app.composio.dev', 'https://connect.composio.dev'].includes(opening.origin)); assert.match(opening.urlHash, /^[a-f0-9]{64}$/u); assert.match(opening.stateHash, /^[a-f0-9]{64}$/u); }
    return value;
  } finally { await file.close(); }
}
export async function closeComposioLiveElectron(harness: ComposioLiveElectron): Promise<void> {
  const own = issued.get(harness); assert(own && own.child.pid === harness.processId && harness.processId > 0 && harness.processGroupId === harness.processId);
  await harness.application.evaluate(async () => { const api = Reflect.get(globalThis, '__canvasComposioLiveElectron') as { finishLiveElectronHarness(): Promise<boolean> }; if (await api.finishLiveElectronHarness() !== true) throw new Error('Unconfirmed finish.'); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.all([harness.application.close(), own.closed]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Own Electron close unconfirmed.')), 30_000); })]); }
  finally { if (timer) clearTimeout(timer); }
  const deadline = Date.now() + 5000; let absent = false;
  while (!absent && Date.now() < deadline) { try { process.kill(-harness.processGroupId, 0); } catch (error) { absent = (error as { code?: string }).code === 'ESRCH'; } if (!absent) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(absent, 'The own native group is not closed.'); const receipt = await readComposioLiveElectronReceipt(harness); assert.equal(receipt.phase, 'closed'); assert.equal(receipt.uncertain, false);
}
