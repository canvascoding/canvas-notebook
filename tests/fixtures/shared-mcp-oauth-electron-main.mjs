import { app, shell } from 'electron';
import fs, { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setServerUrl } from '../../electron/main/config-store.mjs';

const BASE_URL = 'http://127.0.0.1:3001';
const DESKTOP_STATE = /^desktop_[A-Za-z0-9_-]{32}$/u;
const REF = /^canvas-connection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PATH_NAMES = { userData: 'desktop-user-data', sessionData: 'desktop-session-data', temp: 'desktop-temp',
  logs: 'desktop-logs', crashDumps: 'desktop-crash-dumps' };

/** Synchronous validation keeps all Electron path changes before app readiness. */
function readOwnedElectronFixture() {
  if (process.env.CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN !== '1'
    || process.env.CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN !== '1'
    || process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN !== '1'
    || process.env.BASE_URL !== BASE_URL) throw new Error('The exact owned native fixture is required.');
  const receiptPath = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
  if (!receiptPath || !path.isAbsolute(receiptPath) || path.basename(receiptPath) !== 'recovery.json'
    || fs.realpathSync(receiptPath) !== receiptPath) throw new Error('The owned receipt path is invalid.');
  const handle = fs.openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let fixture;
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
      || stat.size < 2 || stat.size > 64 * 1024) throw new Error('The owned receipt file is invalid.');
    fixture = JSON.parse(fs.readFileSync(handle, 'utf8'));
  } finally { fs.closeSync(handle); }
  if (fixture.version !== 1 || !/^[0-9a-f]{32}$/u.test(fixture.nonce) || fixture.phase !== 'browser'
    || fixture.createAcknowledged !== true || fixture.listenerVerified !== true || fixture.uncertain !== false
    || fixture.databaseName !== `canvas_connection_test_${fixture.nonce}` || typeof fixture.actorId !== 'string' || !fixture.actorId
    || path.dirname(receiptPath) !== fixture.fixtureRoot || !Number.isSafeInteger(fixture.serverPid) || fixture.serverPid <= 0
    || fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url))) !== fixture.repo) throw new Error('The owned fixture identity is invalid.');
  const root = fs.lstatSync(fixture.fixtureRoot), tmp = fs.lstatSync(fixture.tmpRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700
    || fs.realpathSync(fixture.fixtureRoot) !== fixture.fixtureRoot || String(root.dev) !== fixture.rootDevice || String(root.ino) !== fixture.rootInode
    || fixture.tmpRoot !== path.join(fixture.fixtureRoot, 'tmp') || !tmp.isDirectory() || tmp.isSymbolicLink()
    || tmp.uid !== root.uid || (tmp.mode & 0o777) !== 0o700 || fs.realpathSync(fixture.tmpRoot) !== fixture.tmpRoot
    || String(tmp.dev) !== fixture.directoryProofs?.[fixture.tmpRoot]?.device || String(tmp.ino) !== fixture.directoryProofs?.[fixture.tmpRoot]?.inode) {
    throw new Error('The owned fixture directory proof is invalid.');
  }
  const markerHandle = fs.openSync(path.join(fixture.fixtureRoot, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const marker = fs.fstatSync(markerHandle);
    if (!marker.isFile() || marker.nlink !== 1 || marker.uid !== root.uid || (marker.mode & 0o777) !== 0o600
      || marker.size > 1024 || fs.readFileSync(markerHandle, 'utf8') !== fixture.ownerMarker) throw new Error('The owned marker is invalid.');
  } finally { fs.closeSync(markerHandle); }
  const paths = JSON.parse(process.env.CANVAS_SHARED_MCP_DESKTOP_PATHS ?? 'null');
  if (!paths || Object.keys(paths).length !== 5 || JSON.stringify(paths) !== JSON.stringify(fixture.desktopPaths)
    || process.env.CANVAS_SHARED_MCP_DESKTOP_RECEIPT !== path.join(fixture.fixtureRoot, 'desktop-receipt.json')) {
    throw new Error('The owned desktop path selection is invalid.');
  }
  for (const [key, basename] of Object.entries(PATH_NAMES)) {
    if (paths[key] !== path.join(fixture.tmpRoot, basename)) throw new Error('The desktop path is outside the owned fixture.');
    const stat = fs.lstatSync(paths[key]), proof = fixture.desktopDirectoryProofs?.[paths[key]];
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== root.uid || (stat.mode & 0o777) !== 0o700
      || fs.realpathSync(paths[key]) !== paths[key] || String(stat.dev) !== proof?.device || String(stat.ino) !== proof?.inode) {
      throw new Error('The owned desktop directory proof is invalid.');
    }
  }
  const origin = new URL(process.env.CANVAS_SHARED_MCP_ELECTRON_PROVIDER_ORIGIN ?? '');
  if (origin.origin !== process.env.CANVAS_SHARED_MCP_ELECTRON_PROVIDER_ORIGIN || origin.protocol !== 'https:'
    || origin.hostname !== '127.0.0.1' || !origin.port || origin.port === '3001' || origin.username || origin.password) {
    throw new Error('The exact owned HTTPS provider is required.');
  }
  return { fixture, paths, providerOrigin: origin.origin, receiptPath: path.join(fixture.fixtureRoot, 'electron-main-receipt.json') };
}

let owned;
try { owned = readOwnedElectronFixture(); }
catch { console.error('The owned Electron fixture failed validation before launch.'); app.exit(1); }
if (!owned) throw new Error('Owned Electron fixture validation failed.');

for (const key of ['userData', 'sessionData', 'temp', 'crashDumps']) app.setPath(key, owned.paths[key]);
app.setAppLogsPath(owned.paths.logs);
setServerUrl(app, BASE_URL);

const proof = { version: 1, nonce: owned.fixture.nonce, actorId: owned.fixture.actorId, processId: process.pid,
  phase: 'initializing', providerOrigin: owned.providerOrigin, shellAttempts: 0, shellAcknowledged: 0, shellFailures: 0,
  blockedRequests: 0, statusRequests: 0, uncertain: false, openings: [], barrier: { armed: false, held: false }, barrierHistory: [],
  desktopPaths: owned.paths, desktopDirectoryProofs: owned.fixture.desktopDirectoryProofs };
let proofIdentity = null, originalShell = null, closing = false, barrier = null;
const sessions = new Set();
const heldRequests = new Map();

function persistOwnedElectronProof() {
  if (proofIdentity) {
    const current = fs.lstatSync(owned.receiptPath);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid?.()
      || (current.mode & 0o777) !== 0o600 || String(current.dev) !== proofIdentity.device || String(current.ino) !== proofIdentity.inode) {
      throw new Error('The owned Electron proof changed.');
    }
  } else if (fs.existsSync(owned.receiptPath)) throw new Error('A pre-existing Electron proof cannot be adopted.');
  const temporary = `${owned.receiptPath}.tmp`;
  const file = fs.openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(file, JSON.stringify(proof)); fs.fsyncSync(file); } finally { fs.closeSync(file); }
  fs.renameSync(temporary, owned.receiptPath);
  const stat = fs.lstatSync(owned.receiptPath);
  proofIdentity = { device: String(stat.dev), inode: String(stat.ino) };
}

function releaseOwnedOAuthStatusBarrier() {
  const current = barrier;
  barrier = null;
  if (current?.timer) clearTimeout(current.timer);
  if (current?.callback) {
    const observation = proof.barrierHistory[current.historyIndex];
    observation.heldToReleaseMs = Math.max(0, Math.round(performance.now() - current.heldAt));
    observation.release = 'entered';
    observation.operation = 'persist_before';
    try {
      persistOwnedElectronProof();
      observation.operation = 'callback';
      current.callback({}); // Deliver the actual response without changing headers or status.
      observation.operation = 'persist_after';
      observation.release = 'acknowledged';
      proof.barrier = { armed: false, held: false };
      persistOwnedElectronProof();
    } catch (error) {
      observation.release = 'failed';
      observation.errorName = ['Error', 'TypeError', 'RangeError'].includes(error?.name) ? error.name : 'UnknownError';
      observation.errorKind = error?.message === 'The owned Electron proof changed.' ? 'proof_changed'
        : error?.message === 'A pre-existing Electron proof cannot be adopted.' ? 'proof_exists'
          : error?.code === 'ENOENT' ? 'filesystem_missing' : error?.code === 'EEXIST' ? 'filesystem_exists' : 'other';
      proof.uncertain = true;
      proof.phase = 'preserved';
      proof.barrier = { armed: false, held: false };
      try { persistOwnedElectronProof(); } catch { /* The sticky in-memory failure must also prevent a later closed receipt. */ }
      throw new Error('The owned native response barrier release failed.');
    }
    return;
  }
  proof.barrier = { armed: false, held: false };
  persistOwnedElectronProof();
}

function armOwnedOAuthStatusBarrier(input) {
  if (closing || barrier || proof.barrierHistory.length >= 8 || !input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['connectionRef', 'state', 'workspaceId'].includes(key))
    || typeof input.connectionRef !== 'string' || !REF.test(input.connectionRef)
    || typeof input.state !== 'string' || !DESKTOP_STATE.test(input.state)
    || (input.workspaceId !== null && (typeof input.workspaceId !== 'string' || !input.workspaceId
      || input.workspaceId !== input.workspaceId.trim() || input.workspaceId.length > 200
      || /[\x00-\x1f\x7f]/u.test(input.workspaceId)))) throw new Error('The native barrier selection is invalid.');
  const historyIndex = proof.barrierHistory.length;
  proof.barrierHistory.push({ sequence: historyIndex + 1, held: false, release: 'pending', terminal: 'pending' });
  barrier = { tuple: Object.freeze({ connectionRef: input.connectionRef, state: input.state, workspaceId: input.workspaceId }),
    callback: null, timer: null, historyIndex, heldAt: null };
  proof.barrier = { armed: true, held: false, refHash: createHash('sha256').update(input.connectionRef).digest('hex'),
    stateHash: createHash('sha256').update(input.state).digest('hex'),
    workspaceHash: input.workspaceId === null ? null : createHash('sha256').update(input.workspaceId).digest('hex') };
  // The launcher's own timeout is 10 seconds. The barrier never outlives it.
  barrier.timer = setTimeout(() => { proof.uncertain = true; proof.phase = 'preserved'; releaseOwnedOAuthStatusBarrier(); }, 8_000);
  persistOwnedElectronProof();
}

function installOwnedOAuthShellObservation() {
  originalShell = shell.openExternal.bind(shell);
  shell.openExternal = async value => {
    let url;
    try { url = new URL(value); } catch { throw new Error('The owned system-browser target is invalid.'); }
    if (closing || proof.shellAttempts >= 8 || url.origin !== owned.providerOrigin || url.pathname !== '/authorize' || !DESKTOP_STATE.test(url.searchParams.get('state') ?? '')
      || url.searchParams.get('redirect_uri') !== `${BASE_URL}/api/mcp/oauth/callback` || url.username || url.password) {
      proof.blockedRequests += 1; persistOwnedElectronProof(); throw new Error('The system-browser target is outside this fixture.');
    }
    proof.shellAttempts += 1;
    proof.openings.push({ origin: url.origin, urlHash: createHash('sha256').update(value).digest('hex'),
      stateHash: createHash('sha256').update(url.searchParams.get('state')).digest('hex') });
    proof.phase = 'awaiting_os_consent'; persistOwnedElectronProof();
    try {
      await originalShell(value); // Actual macOS default-browser dispatch; no fake opener or synthetic acknowledgement.
      proof.shellAcknowledged += 1; persistOwnedElectronProof();
    } catch {
      proof.shellFailures += 1; proof.uncertain = true; proof.phase = 'preserved'; persistOwnedElectronProof();
      throw new Error('The owned system-browser dispatch failed.');
    }
  };
  app.on('web-contents-created', (_event, contents) => {
    const session = contents.session;
    if (sessions.has(session)) return;
    sessions.add(session);
    heldRequests.set(session, new Map());
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        allowed = ['about:', 'data:', 'blob:', 'devtools:'].includes(url.protocol)
          || url.origin === BASE_URL || url.origin === owned.providerOrigin
          || url.origin === 'ws://127.0.0.1:3001';
      } catch { /* An unknown scheme is outside the isolated acceptance. */ }
      if (!allowed) { proof.blockedRequests += 1; persistOwnedElectronProof(); }
      callback({ cancel: !allowed });
    });
    session.webRequest.onHeadersReceived({ urls: [`${BASE_URL}/api/mcp/shared-connections/*/oauth/desktop*`] }, (details, callback) => {
      const url = new URL(details.url);
      proof.statusRequests += 1;
      if (barrier && !barrier.callback && details.method === 'GET' && details.statusCode === 200
        && url.pathname === `/api/mcp/shared-connections/${encodeURIComponent(barrier.tuple.connectionRef)}/oauth/desktop`
        && [...url.searchParams.keys()].every(key => key === 'state' || key === 'workspaceId')
        && url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === barrier.tuple.state
        && (barrier.tuple.workspaceId === null ? url.searchParams.getAll('workspaceId').length === 0
          : url.searchParams.getAll('workspaceId').length === 1 && url.searchParams.get('workspaceId') === barrier.tuple.workspaceId)) {
        if (!Number.isSafeInteger(details.id) || details.id < 0 || heldRequests.get(session).has(details.id)) {
          proof.uncertain = true; proof.phase = 'preserved'; persistOwnedElectronProof(); callback({ cancel: true }); return;
        }
        barrier.callback = callback;
        barrier.heldAt = performance.now();
        const observation = proof.barrierHistory[barrier.historyIndex];
        observation.held = true;
        heldRequests.get(session).set(details.id, { tuple: barrier.tuple, observation });
        proof.barrier = { ...proof.barrier, held: true, stateHash: createHash('sha256').update(url.searchParams.get('state')).digest('hex') };
        persistOwnedElectronProof(); return;
      }
      persistOwnedElectronProof(); callback({});
    });
    // Correlate only the held request's exact ID, native Session and URL tuple. No raw network error or URL enters the proof.
    const observeTerminal = (details, failed) => {
      const held = heldRequests.get(session).get(details.id);
      if (!held) return;
      const url = new URL(details.url);
      const query = new URLSearchParams({ state: held.tuple.state });
      if (held.tuple.workspaceId !== null) query.set('workspaceId', held.tuple.workspaceId);
      const expected = new URL(`/api/mcp/shared-connections/${encodeURIComponent(held.tuple.connectionRef)}/oauth/desktop?${query}`, BASE_URL);
      if (details.method !== 'GET' || url.origin !== expected.origin || url.pathname !== expected.pathname
        || [...url.searchParams.keys()].some(key => !['state', 'workspaceId'].includes(key))
        || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== held.tuple.state
        || (held.tuple.workspaceId === null ? url.searchParams.getAll('workspaceId').length !== 0
          : url.searchParams.getAll('workspaceId').length !== 1 || url.searchParams.get('workspaceId') !== held.tuple.workspaceId)) return;
      held.observation.terminal = failed ? 'failed' : 'completed';
      if (failed) held.observation.networkError = details.error === 'net::ERR_ABORTED' ? 'aborted'
        : details.error === 'net::ERR_TIMED_OUT' ? 'timed_out' : 'other';
      heldRequests.get(session).delete(details.id);
      persistOwnedElectronProof();
    };
    session.webRequest.onCompleted({ urls: [`${BASE_URL}/api/mcp/shared-connections/*/oauth/desktop*`] }, details => observeTerminal(details, false));
    session.webRequest.onErrorOccurred({ urls: [`${BASE_URL}/api/mcp/shared-connections/*/oauth/desktop*`] }, details => observeTerminal(details, true));
  });
}

function finishOwnedElectronHarness() {
  closing = true;
  releaseOwnedOAuthStatusBarrier();
  for (const session of sessions) {
    session.webRequest.onHeadersReceived(null);
  }
  proof.uncertain ||= proof.shellAttempts !== proof.shellAcknowledged + proof.shellFailures
    || proof.barrierHistory.some(observation => observation.held && observation.release !== 'acknowledged');
  proof.phase = proof.uncertain ? 'preserved' : 'finishing';
  persistOwnedElectronProof();
  return true;
}

persistOwnedElectronProof();
installOwnedOAuthShellObservation();
// Inspector evaluation can interrupt another main-stack operation. Run controls on the ordinary event loop,
// so an atomic proof write cannot be reentered while its exclusive temporary file is still open.
function runOwnedElectronControl(operation, input) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(operation(input)); } catch (error) { reject(error); }
    });
  });
}
globalThis.__canvasOwnedSharedMcpElectron = Object.freeze({
  armOwnedOAuthStatusBarrier: input => runOwnedElectronControl(armOwnedOAuthStatusBarrier, input),
  releaseOwnedOAuthStatusBarrier: () => runOwnedElectronControl(releaseOwnedOAuthStatusBarrier),
  finishOwnedElectronHarness: () => runOwnedElectronControl(finishOwnedElectronHarness),
});
app.on('will-quit', () => {
  releaseOwnedOAuthStatusBarrier();
  for (const session of sessions) {
    session.webRequest.onBeforeRequest(null);
    session.webRequest.onHeadersReceived(null);
    session.webRequest.onCompleted(null);
    session.webRequest.onErrorOccurred(null);
  }
  proof.uncertain ||= proof.barrierHistory.some(observation => observation.held && observation.release !== 'acknowledged');
  proof.phase = closing && !proof.uncertain ? 'closed' : 'preserved';
  persistOwnedElectronProof();
});
app.on('browser-window-created', () => { proof.phase = proof.uncertain ? 'preserved' : 'ready'; persistOwnedElectronProof(); });
process.on('uncaughtException', () => { proof.uncertain = true; proof.phase = 'preserved'; persistOwnedElectronProof(); app.exit(1); });
process.on('unhandledRejection', () => { proof.uncertain = true; proof.phase = 'preserved'; persistOwnedElectronProof(); app.exit(1); });

await import('../../electron/main/main.mjs');
