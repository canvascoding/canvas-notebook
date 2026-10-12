import { app, shell } from 'electron';
import fs, { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setServerUrl } from '../../electron/main/config-store.mjs';

const BASE = 'http://127.0.0.1:3001';
function readLiveElectronFixture() {
  if (process.env.CANVAS_COMPOSIO_LIVE_BROWSER_RUN !== '1' || process.env.BASE_URL !== BASE) throw new Error('Live fixture required.');
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
  if (!file || !path.isAbsolute(file) || path.basename(file) !== 'recovery.json' || fs.realpathSync(file) !== file) throw new Error('Invalid fixture.');
  const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value;
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536) throw new Error('Invalid fixture.'); value = JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
  if (value.version !== 1 || !/^[a-f0-9]{32}$/u.test(value.nonce) || value.liveProvider !== 'composio'
    || value.nativeProvider !== 'composio' || value.phase !== 'browser' || !value.listenerVerified || value.uncertain
    || !value.createAcknowledged || value.databaseName !== `canvas_connection_test_${value.nonce}`
    || path.dirname(file) !== value.fixtureRoot || fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url))) !== value.repo) throw new Error('Invalid live ownership.');
  const root = fs.lstatSync(value.fixtureRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700
    || String(root.dev) !== value.rootDevice || String(root.ino) !== value.rootInode || fs.realpathSync(value.fixtureRoot) !== value.fixtureRoot) throw new Error('Invalid root.');
  const marker = fs.openSync(path.join(value.fixtureRoot, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(marker); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 || fs.readFileSync(marker, 'utf8') !== value.ownerMarker) throw new Error('Invalid owner.'); }
  finally { fs.closeSync(marker); }
  const names = { userData: 'desktop-user-data', sessionData: 'desktop-session-data', temp: 'desktop-temp', logs: 'desktop-logs', crashDumps: 'desktop-crash-dumps' };
  const paths = JSON.parse(process.env.CANVAS_COMPOSIO_LIVE_DESKTOP_PATHS ?? 'null');
  if (!paths || Object.keys(paths).length !== 5 || JSON.stringify(paths) !== JSON.stringify(value.desktopPaths)) throw new Error('Invalid desktop paths.');
  for (const [key, name] of Object.entries(names)) {
    if (paths[key] !== path.join(value.fixtureRoot, 'tmp', name)) throw new Error('Foreign desktop path.');
    const stat = fs.lstatSync(paths[key]), proof = value.desktopDirectoryProofs?.[paths[key]];
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== root.uid || (stat.mode & 0o777) !== 0o700
      || fs.realpathSync(paths[key]) !== paths[key] || String(stat.dev) !== proof?.device || String(stat.ino) !== proof?.inode) throw new Error('Desktop proof changed.');
  }
  return { value, paths, receiptPath: path.join(value.fixtureRoot, 'composio-live-main-receipt.json') };
}
const owned = readLiveElectronFixture();
for (const key of ['userData', 'sessionData', 'temp', 'crashDumps']) app.setPath(key, owned.paths[key]);
app.setAppLogsPath(owned.paths.logs); setServerUrl(app, BASE);
const proof = { version: 1, nonce: owned.value.nonce, processId: process.pid, phase: 'initializing',
  shellAttempts: 0, shellAcknowledged: 0, blockedRequests: 0, uncertain: false, openings: [] };
let identity = null, closing = false;
const targets = new Map(), sessions = new Set();
function persistLiveElectronProof() {
  if (identity) { const stat = fs.lstatSync(owned.receiptPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino) throw new Error('Live proof changed.'); }
  else if (fs.existsSync(owned.receiptPath)) throw new Error('Existing proof.');
  const tmp = `${owned.receiptPath}.tmp`, fd = fs.openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(proof)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, owned.receiptPath); const stat = fs.lstatSync(owned.receiptPath); identity = { dev: String(stat.dev), ino: String(stat.ino) };
}
function armLiveAuthorizationTarget(input) {
  if (closing || targets.size >= 2 || !input || Object.keys(input).sort().join(',') !== 'origin,stateHash,urlHash'
    || !/^[a-f0-9]{64}$/u.test(input.urlHash) || !/^[a-f0-9]{64}$/u.test(input.stateHash)
    || !['https://app.composio.dev', 'https://connect.composio.dev'].includes(input.origin)
    || targets.has(input.urlHash)) throw new Error('Invalid genuine live target.');
  targets.set(input.urlHash, Object.freeze({ ...input }));
}
function finishLiveElectronHarness() { closing = true; proof.phase = 'finishing'; persistLiveElectronProof(); return true; }
function runLiveElectronControl(operation, input) { return new Promise((resolve, reject) => setImmediate(() => { try { resolve(operation(input)); } catch (error) { reject(error); } })); }
globalThis.__canvasComposioLiveElectron = Object.freeze({ armLiveAuthorizationTarget: input => runLiveElectronControl(armLiveAuthorizationTarget, input),
  finishLiveElectronHarness: () => runLiveElectronControl(finishLiveElectronHarness) });
const originalShell = shell.openExternal.bind(shell);
shell.openExternal = async value => {
  const url = new URL(value), urlHash = createHash('sha256').update(value).digest('hex'), target = targets.get(urlHash);
  if (closing || proof.shellAttempts >= 2 || !target || url.origin !== target.origin || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    proof.uncertain = true; proof.blockedRequests++; persistLiveElectronProof(); throw new Error('Unissued live target.');
  }
  targets.delete(urlHash); proof.shellAttempts++; proof.openings.push({ origin: url.origin, urlHash, stateHash: target.stateHash }); persistLiveElectronProof();
  try { await originalShell(value); proof.shellAcknowledged++; persistLiveElectronProof(); }
  catch { proof.uncertain = true; persistLiveElectronProof(); throw new Error('Live system opener failed.'); }
};
app.on('web-contents-created', (_event, contents) => {
  if (sessions.has(contents.session)) return; sessions.add(contents.session);
  contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let allowed = false;
    try { const url = new URL(details.url); allowed = ['about:', 'data:', 'blob:', 'devtools:'].includes(url.protocol) || url.origin === BASE || url.origin === 'ws://127.0.0.1:3001'; } catch { /* Fail closed. */ }
    if (!allowed) { proof.blockedRequests++; persistLiveElectronProof(); } callback({ cancel: !allowed });
  });
});
app.on('browser-window-created', () => { proof.phase = 'ready'; persistLiveElectronProof(); });
app.on('will-quit', () => { for (const session of sessions) session.webRequest.onBeforeRequest(null); proof.uncertain ||= proof.shellAttempts !== proof.shellAcknowledged; proof.phase = 'closed'; persistLiveElectronProof(); });
persistLiveElectronProof();
await import('../../electron/main/main.mjs');
