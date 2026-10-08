import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { launchOwnedSharedComposioElectron, type SharedComposioElectronDesktopPaths } from '../tests/helpers/shared-composio-oauth-electron';

/** Intentionally invalid prelaunch fixtures only; no DB, host, Electron or browser starts. */
async function main(): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-electron-ownership-negative-')));
  await fs.chmod(root, 0o700); const initialRoot = await fs.lstat(root);
  const tmp = path.join(root, 'tmp'); await fs.mkdir(tmp, { mode: 0o700 });
  const paths: SharedComposioElectronDesktopPaths = { userData: path.join(tmp, 'desktop-user-data'),
    sessionData: path.join(tmp, 'desktop-session-data'), temp: path.join(tmp, 'desktop-temp'),
    logs: path.join(tmp, 'desktop-logs'), crashDumps: path.join(tmp, 'desktop-crash-dumps') };
  const directoryProofs: Record<string, { device: string; inode: string }> = {};
  for (const directory of [tmp, ...Object.values(paths)]) {
    if (directory !== tmp) await fs.mkdir(directory, { mode: 0o700 });
    const stat = await fs.lstat(directory); directoryProofs[directory] = { device: String(stat.dev), inode: String(stat.ino) };
  }
  const nonce = randomBytes(16).toString('hex'), marker = randomBytes(24).toString('hex');
  const markerPath = path.join(root, '.fixture-owner'); await fs.writeFile(markerPath, marker, { mode: 0o600 });
  const fixturePath = path.join(root, 'recovery.json');
  const fixture = { version: 1, nonce, repo: await fs.realpath(process.cwd()), fixtureRoot: root, tmpRoot: tmp,
    rootDevice: String(initialRoot.dev), rootInode: String(initialRoot.ino), ownerMarker: marker, actorId: 'synthetic-negative-actor',
    nativeProvider: 'composio', phase: 'browser', createAcknowledged: true, listenerVerified: true, uncertain: false,
    databaseName: `canvas_connection_test_${nonce}`, serverPid: process.pid, desktopPaths: paths,
    directoryProofs: { [tmp]: directoryProofs[tmp] }, desktopDirectoryProofs: directoryProofs };
  const variables: Record<string, string | undefined> = { CANVAS_SHARED_COMPOSIO_DESKTOP_OAUTH_BROWSER_RUN: '1',
    CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN: undefined, CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN: undefined,
    CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1', BASE_URL: 'http://127.0.0.1:3001',
    AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: fixturePath, CANVAS_SHARED_COMPOSIO_DESKTOP_PATHS: JSON.stringify(paths),
    CANVAS_SHARED_COMPOSIO_DESKTOP_RECEIPT: path.join(root, 'desktop-receipt.json') };
  const previous = new Map(Object.keys(variables).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(variables)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try {
    await fs.writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    delete process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_OAUTH_BROWSER_RUN;
    await assert.rejects(launchOwnedSharedComposioElectron({ fixturePath, providerOrigin: 'https://127.0.0.1:8444' }));
    process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_OAUTH_BROWSER_RUN = '1';
    process.env.CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN = '1';
    await assert.rejects(launchOwnedSharedComposioElectron({ fixturePath, providerOrigin: 'https://127.0.0.1:8444' }));
    delete process.env.CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN;
    await fs.writeFile(fixturePath, JSON.stringify({ ...fixture, nativeProvider: 'mcp' }), { mode: 0o600 });
    await assert.rejects(launchOwnedSharedComposioElectron({ fixturePath, providerOrigin: 'https://127.0.0.1:8444' }));
    await fs.writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    await fs.writeFile(markerPath, 'different-marker', { mode: 0o600 });
    await assert.rejects(launchOwnedSharedComposioElectron({ fixturePath, providerOrigin: 'https://127.0.0.1:8444' }));
    await fs.writeFile(markerPath, marker, { mode: 0o600 });
    const foreign = { ...paths, userData: path.join(root, 'outside-profile-boundary') };
    process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_PATHS = JSON.stringify(foreign);
    await fs.writeFile(fixturePath, JSON.stringify({ ...fixture, desktopPaths: foreign }), { mode: 0o600 });
    await assert.rejects(launchOwnedSharedComposioElectron({ fixturePath, providerOrigin: 'https://127.0.0.1:8444' }));
    process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_PATHS = JSON.stringify(paths);
    await fs.writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    const originalProfile = `${paths.userData}.original`; await fs.rename(paths.userData, originalProfile);
    await fs.mkdir(paths.userData, { mode: 0o700 });
    await assert.rejects(launchOwnedSharedComposioElectron({ fixturePath, providerOrigin: 'https://127.0.0.1:8444' }));
    await fs.rmdir(paths.userData); await fs.rename(originalProfile, paths.userData);
    // Every request below has an invalid origin, after all path proofs pass.
    // The real validator must stop before its lazy runtime import/launch.
    for (const providerOrigin of ['http://127.0.0.1:8444', 'https://example.invalid', 'https://127.0.0.1:3001',
      'https://127.0.0.1:8444/path', 'https://127.0.0.1:8444/?unrecognized=1']) {
      await assert.rejects(launchOwnedSharedComposioElectron({ fixturePath, providerOrigin }));
    }
    await assert.rejects(fs.lstat(path.join(root, 'electron-main-receipt.json')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'electron-helper-failure.json')), { code: 'ENOENT' });
    console.info('OWN_COMPOSIO_ELECTRON_PRELAUNCH_REJECTION_PASS provider/flags/marker/foreign-profile/replaced-inode/origins; no native acceptance');
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const current = await fs.lstat(root);
    assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === initialRoot.dev && current.ino === initialRoot.ino);
    assert.equal(await fs.realpath(root), root); assert.equal(current.uid, process.getuid?.());
    await fs.rm(root, { recursive: true });
  }
}

main().catch(() => { console.error('OWN_COMPOSIO_ELECTRON_PRELAUNCH_REJECTION_FAIL'); process.exitCode = 1; });
