import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { request } from '@playwright/test';
import {
  acceptanceOrigin as origin, assertCompiledAcceptanceUnchanged, digest,
  loadCompiledAcceptance, readPrivateJson, redactAcceptanceText,
  repository, snapshotProtectedCompiledFixture,
} from './helpers/compiled-api-sdk-acceptance.mjs';
import {
  compiledOperationCases, compiledOperationStatusRequests, validateCompiledOperationJournal,
} from './helpers/compiled-operation-journal.mjs';

let acceptance, python, wheel;
try {
  assert(process.argv.slice(2).length === 4 && process.argv.slice(2).every(Boolean),
    'Supply runtime proof, preservation fixture, installed-wheel interpreter and wheel.');
  acceptance = loadCompiledAcceptance(process.argv[2], process.argv[3]);
  python = path.resolve(process.argv[4]); wheel = path.resolve(process.argv[5]);
  assert(fs.statSync(python).isFile()); fs.accessSync(python, fs.constants.X_OK);
  const stat = fs.lstatSync(wheel);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.uid === process.getuid?.() && stat.size > 0 && stat.size <= 2 * 1024 * 1024);
} catch (error) {
  console.error(JSON.stringify({ suite: 'compiled-rest-installed-sdk-operations', passed: false,
    phase: 'preflight', errorType: error instanceof Error ? error.name : 'UnknownError' }));
  process.exit(1);
}

const nonce = crypto.randomUUID(), prefix = path.join(acceptance.root, 'compiled-api-sdk-operations-' + Date.now());
const helper = path.join(repository, 'scripts/helpers/python_sdk_compiled_operations_probe.py');
const verificationHelper = path.join(repository, 'scripts/helpers/python_sdk_issued_oauth_keychain_probe.py');
const sources = ['scripts/run-api-sdk-operations-compiled.mjs', 'scripts/helpers/compiled-api-sdk-acceptance.mjs',
  'scripts/helpers/compiled-operation-journal.mjs', 'scripts/helpers/python_sdk_compiled_operations_probe.py',
  'scripts/helpers/python_sdk_issued_oauth_keychain_probe.py'];
const helperHashes = Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(repository, file)))]));
const sdkSource = path.join(repository, 'packages/canvas-notebook-python/src/canvas_notebook');
const runtimeSourceHashes = Object.fromEntries(fs.readdirSync(sdkSource)
  .filter(name => name.endsWith('.py') || name === 'py.typed')
  .map(name => [name, digest(fs.readFileSync(path.join(sdkSource, name)))]));
assert(Object.keys(runtimeSourceHashes).length > 0 && Object.keys(runtimeSourceHashes).length <= 64);
const proof = { suite: 'compiled-rest-installed-sdk-operations', sourceSha: acceptance.sourceSha,
  runtimeProof: acceptance.runtimePath, preservationFixture: acceptance.fixturePath,
  nonce, result: prefix + '-result.json', requestsFile: prefix + '-requests.json',
  helperHashes, wheelSha256: digest(fs.readFileSync(wheel)), runtimeSourceHashes,
  startedAt: new Date().toISOString(), workspaces: [], issuanceAttempts: [], events: [], phase: 'preflight', passed: false };
const sensitive = [...acceptance.sensitive], contexts = [], failures = [];
const save = () => fs.writeFileSync(proof.result,
  redactAcceptanceText(JSON.stringify(proof, null, 2) + '\n', sensitive), { mode: 0o600 });
const stage = phase => { proof.phase = phase; save(); console.log(JSON.stringify({ phase, result: proof.result })); };
let manager, restore, ownerId, child, closed = false, exitCode, exitSignal, latestKey;
let stderrBytes = 0, stdoutBytes = 0, buffered = '', queued = [], waiting, protocolFailed = false;
let interrupted = false, cleaning = false, deadline;
const allowedEvents = new Set(['wheel_verified', 'auth_denied', 'readonly_denied', 'http_operation',
  'operation_checked', 'ready_rotate', 'old_key_denied', 'rotated_operation_checked', 'complete',
  'tool_failure', 'http_failure', 'failed']);
const interrupt = () => { interrupted = true; protocolFailed = true; child?.kill('SIGTERM'); waiting?.(); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

async function ok(response, label) {
  if (interrupted && !cleaning) throw new Error('Owned operation acceptance interrupted.');
  const body = await response.json();
  if (!response.ok()) {
    proof.httpFailure = { label, status: response.status(),
      code: typeof body?.code === 'string' && /^[A-Z_]{1,100}$/u.test(body.code) ? body.code : null };
    save(); throw new Error('Actual operation HTTP request failed.');
  }
  return body;
}

async function signIn() {
  await ok(await manager.post('/api/auth/sign-in/email', { data: {
    email: acceptance.environment.BOOTSTRAP_ADMIN_EMAIL, password: acceptance.environment.BOOTSTRAP_ADMIN_PASSWORD,
  } }), 'Sign in own management session');
  const current = await ok(await manager.get('/api/auth/get-session'), 'Own session identity');
  assert.equal(current.user.email, acceptance.environment.BOOTSTRAP_ADMIN_EMAIL);
  if (ownerId) assert.equal(current.user.id, ownerId);
  ownerId = current.user.id;
  return current;
}

async function issue(name, workspaceIds, actions) {
  const attempt = { requestId: crypto.randomUUID(), name, workspaceIds, actions };
  proof.issuanceAttempts.push(attempt); save();
  const issued = (await ok(await manager.post('/api/api-access/integrations', {
    data: { ...attempt, expiresAt: Date.now() + 86400000 },
  }), 'Issue nonce-owned key')).data;
  assert.equal(issued.integration.name, name);
  assert.deepEqual([...issued.integration.workspaceIds].sort(), [...workspaceIds].sort());
  assert(typeof issued.key === 'string' && issued.key.startsWith('cnk_')); sensitive.push(issued.key);
  return issued;
}

async function next(expected) {
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    if (protocolFailed) throw new Error('Bounded private operation protocol failed.');
    if (queued.length) {
      const event = queued.shift(); proof.events.push(event); save();
      if (['failed', 'http_failure', 'tool_failure'].includes(event.event)) {
        proof.operationFailure = event; throw new Error('Actual compiled operation failed.');
      }
      if (event.event === expected) return event;
      assert(!['ready_rotate', 'complete'].includes(event.event), 'Unexpected operation protocol phase.');
      continue;
    }
    assert(!closed, 'Owned Python process ended before its expected event.');
    await new Promise(resolve => {
      const timer = setTimeout(() => { waiting = undefined; resolve(); }, 500);
      waiting = () => { clearTimeout(timer); waiting = undefined; resolve(); };
    });
  }
  throw new Error('Bounded operation phase deadline exceeded.');
}

function checkCases(name) {
  const events = proof.events.filter(value => value.event === name);
  assert.equal(events.length, 6);
  assert.deepEqual(events.map(value => value.kind + ':' + value.mode).sort(),
    compiledOperationCases.map(value => value.kind + ':' + value.mode).sort());
  for (const event of events) {
    assert.equal(event.operationId, `compiled-${event.kind}-${event.mode}-${nonce}`);
    if (name === 'operation_checked') {
      assert.equal(event.completed, true);
      if (event.kind !== 'copy') assert.equal(event.incomingLinksUpdated, true);
      else assert.notEqual(event.sourceDocumentId, event.destinationDocumentId);
    } else assert.equal(event.historicalStatusPreserved, true);
  }
}

async function reconcileStatuses(requireComplete) {
  assert(latestKey && proof.workspaces.length === 2);
  validateCompiledOperationJournal(readPrivateJson(proof.requestsFile, acceptance.root),
    { nonce, workspaces: proof.workspaces }, requireComplete);
  const rest = await request.newContext({ baseURL: origin, timeout: 90_000,
    extraHTTPHeaders: { 'X-Canvas-API-Key': latestKey }, storageState: { cookies: [], origins: [] } });
  contexts.push(rest); proof.independentRestStatuses = [];
  for (const item of compiledOperationStatusRequests({ nonce, workspaces: proof.workspaces })) {
    const response = await rest.post(item.route, { data: item.body });
    const body = await response.json();
    const fact = { kind: item.kind, mode: item.mode, actualStatus: response.status(),
      completion: body?.operation?.completion?.status ?? null,
      code: typeof body?.code === 'string' && /^[A-Z_]{1,100}$/u.test(body.code) ? body.code : null };
    proof.independentRestStatuses.push(fact); save();
    if (requireComplete) { assert.equal(fact.actualStatus, 200); assert.equal(fact.completion, 'confirmed'); }
  }
  proof.independentRestStatusesComplete = proof.independentRestStatuses.every(value =>
    value.actualStatus === 200 && value.completion === 'confirmed');
}

async function stopChild() {
  if (!child || closed) return;
  child.stdin.end(); child.kill('SIGTERM');
  for (let i = 0; !closed && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!closed) {
    child.kill('SIGKILL');
    for (let i = 0; !closed && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(closed, 'Owned operation process closure unconfirmed.');
}

try {
  proof.originalBefore = prefix + '-original-before.json';
  await snapshotProtectedCompiledFixture(acceptance, proof.originalBefore);
  manager = await request.newContext({ baseURL: origin, timeout: 90_000,
    extraHTTPHeaders: { Origin: origin }, storageState: { cookies: [], origins: [] } }); contexts.push(manager);
  const issuingSession = await signIn();
  assert.equal((await ok(await manager.get('/api/server-settings'), 'Review setting')).data.documentReviewEnabled, false);
  const settings = (await ok(await manager.get('/api/integrations/mcp-server'), 'Prior MCP settings')).data;
  restore = { enabled: settings.desiredEnabled === true, tools: settings.capabilities.filter(value => value.enabled).map(value => value.id) };
  await ok(await manager.patch('/api/integrations/mcp-server', { data: { enabled: true,
    tools: [...new Set([...restore.tools, 'auth_probe', 'list_workspaces', 'get_knowledge_manifest',
      'read_knowledge_source', 'create_knowledge_source', 'copy_knowledge_source', 'move_knowledge_source', 'delete_knowledge_source'])],
  } }), 'Enable only required operation capabilities');
  for (const label of ['A', 'B']) {
    const workspace = (await ok(await manager.post('/api/workspaces', {
      data: { type: 'personal', name: 'Compiled operation ' + label + ' ' + nonce },
    }), 'Create nonce-owned workspace')).workspace;
    assert.match(workspace.id, /^ws_[a-f0-9-]{36}$/u); proof.workspaces.push(workspace.id); save();
    await ok(await manager.put('/api/integrations/mcp-server/workspaces',
      { data: { workspaceId: workspace.id, enabled: true } }), 'Opt in own workspace');
  }
  const issued = await issue('Compiled operations ' + nonce, proof.workspaces,
    ['read', 'create', 'copy', 'move', 'delete', 'status', 'recover']); latestKey = issued.key;
  const readonly = await issue('Compiled read only ' + nonce, [proof.workspaces[0]], ['read']);
  assert.equal((await ok(await manager.post('/api/auth/sign-out', { data: {} }), 'End issuing session')).success, true);
  const ended = await ok(await manager.get('/api/auth/get-session'), 'Verify issuing session ended');
  assert(!ended?.user && !ended?.session); proof.issuingSessionEndedBeforeKeyOperations = true;
  const fresh = await signIn(); assert.notEqual(fresh.session.id, issuingSession.session.id);
  proof.newManagementSessionVerified = true;
  fs.writeFileSync(proof.requestsFile, '[]\n', { flag: 'wx', mode: 0o600 });
  stage('actual-rest-and-installed-sdk-copy-move-delete-and-links');
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ']
    .flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  child = spawn(python, ['-I', '-B', helper], { cwd: acceptance.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  proof.childPid = child.pid;
  const decoder = new StringDecoder('utf8');
  const rejectProtocol = () => { protocolFailed = true; child.kill('SIGTERM'); waiting?.(); };
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length; buffered += decoder.write(chunk);
    if (stdoutBytes > 256 * 1024 || Buffer.byteLength(buffered) > 65536) { rejectProtocol(); return; }
    for (;;) {
      const end = buffered.indexOf('\n'); if (end < 0) break;
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || !allowedEvents.has(event.event) || queued.length >= 64) rejectProtocol();
        else queued.push(event);
      } catch { rejectProtocol(); }
    }
    waiting?.();
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16384) rejectProtocol(); });
  child.stdin.on('error', rejectProtocol); child.once('error', rejectProtocol);
  child.once('close', (code, signal) => { buffered += decoder.end(); closed = true; exitCode = code; exitSignal = signal; waiting?.(); });
  deadline = setTimeout(() => { proof.deadlineExceeded = true; rejectProtocol(); }, 20 * 60_000);
  const send = value => new Promise((resolve, reject) => child.stdin.write(JSON.stringify(value) + '\n',
    error => error ? reject(new Error('Private operation input failed.')) : resolve()));
  await send({ event: 'configure', origin, nonce, workspaces: proof.workspaces, apiKey: issued.key, readKey: readonly.key,
    requestsFile: proof.requestsFile, runtimeSourceHashes, verificationHelper,
    wheelUri: pathToFileURL(wheel).href, wheelSha256: proof.wheelSha256 }); issued.key = ''; readonly.key = '';
  assert.equal((await next('ready_rotate')).operationCount, 6); checkCases('operation_checked');
  const verifiedWheel = proof.events.filter(value => value.event === 'wheel_verified');
  assert.equal(verifiedWheel.length, 1); assert.equal(verifiedWheel[0].sha256, proof.wheelSha256);
  assert.equal(verifiedWheel[0].runtimeFiles, Object.keys(runtimeSourceHashes).length);
  assert.deepEqual(proof.events.filter(value => value.event === 'auth_denied')
    .map(value => [value.route, value.actualStatus]).sort(),
  [['/api/api-access/integrations', 401], ['/api/integrations/env', 401]].sort());
  assert.deepEqual(proof.events.filter(value => value.event === 'readonly_denied').map(value => value.actualStatus), [403]);
  stage('rotate-key-before-historical-sdk-status-and-explicit-recover');
  const history = (await ok(await manager.get(`/api/api-access/integrations/${issued.integration.id}/credentials`), 'Own rotation revision')).data;
  proof.rotationRequestId = crypto.randomUUID(); save();
  const rotated = (await ok(await manager.post(`/api/api-access/integrations/${issued.integration.id}/credentials`, {
    data: { requestId: proof.rotationRequestId, expectedRevision: history.integration.revision, expiresAt: Date.now() + 86400000 },
  }), 'Rotate actual owned key')).data;
  assert.equal(rotated.integration.id, issued.integration.id); assert(typeof rotated.key === 'string');
  latestKey = rotated.key; sensitive.push(latestKey);
  await send({ event: 'rotated', apiKey: latestKey }); rotated.key = '';
  const complete = await next('complete');
  assert.equal(complete.groups, 6); assert.equal(complete.rotatedOwnershipGroups, 6);
  assert.equal(complete.incomingLinkGroups, 4); assert.equal(complete.compiledNext, true); assert.equal(complete.oauthIssuance, false);
  checkCases('rotated_operation_checked');
  assert.deepEqual(proof.events.filter(value => value.event === 'old_key_denied').map(value => value.actualStatus), [401]);
  child.stdin.end();
  for (let i = 0; !closed && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(closed && exitCode === 0 && exitSignal === null && stderrBytes === 0 && buffered === '' && queued.length === 0 && !protocolFailed);
  await reconcileStatuses(true); proof.actualCompiledOperationsPassed = true;
} catch (error) {
  proof.errorType = error instanceof Error ? error.name : 'UnknownError'; failures.push('OperationAcceptanceFailed');
} finally {
  cleaning = true; clearTimeout(deadline); stage('reconcile-and-clean-up-only-owned-resources');
  try { await stopChild(); } catch { failures.push('ChildClosureUnconfirmed'); }
  if (latestKey && proof.workspaces.length === 2 && fs.existsSync(proof.requestsFile) && !proof.independentRestStatusesComplete) {
    try { await reconcileStatuses(false); } catch { failures.push('ReadOnlyStatusReconciliationUnconfirmed'); }
  }
  if (manager) {
    let cleanupSessionVerified = false;
    try {
      const current = await ok(await manager.get('/api/auth/get-session'), 'Cleanup session identity');
      if (!current?.session) await signIn(); else assert.equal(current.user.id, ownerId);
      cleanupSessionVerified = true;
    } catch { failures.push('OwnCleanupSessionUnconfirmed'); }
    for (const attempt of proof.issuanceAttempts) try {
      assert(cleanupSessionVerified);
      const matches = (await ok(await manager.get('/api/api-access/integrations?creationRequestId=' + attempt.requestId), 'Reconcile original issuance')).data.integrations;
      assert(Array.isArray(matches) && matches.length <= 1);
      if (!matches.length) continue;
      const owned = matches[0]; assert.equal(owned.name, attempt.name);
      assert.deepEqual([...owned.workspaceIds].sort(), [...attempt.workspaceIds].sort());
      const history = (await ok(await manager.get(`/api/api-access/integrations/${owned.id}/credentials`), 'Own credential history')).data;
      let revision = history.integration.revision;
      for (const credential of history.credentials) if (credential.revokedAt == null) {
        revision = (await ok(await manager.delete(`/api/api-access/integrations/${owned.id}/credentials`,
          { data: { expectedRevision: revision, credentialId: credential.id } }), 'Revoke only own credential')).data.integration.revision;
      }
      const verified = (await ok(await manager.get(`/api/api-access/integrations/${owned.id}/credentials`), 'Verify own revocation')).data;
      assert(verified.credentials.every(value => value.revokedAt != null));
    } catch { failures.push('OwnCredentialCleanupUnconfirmed'); }
    proof.ownCredentialsRevoked = cleanupSessionVerified && !failures.includes('OwnCredentialCleanupUnconfirmed');
    for (const workspaceId of proof.workspaces) try {
      assert(cleanupSessionVerified);
      assert.equal((await ok(await manager.put('/api/integrations/mcp-server/workspaces',
        { data: { workspaceId, enabled: false } }), 'Remove own workspace opt-in')).data.enabled, false);
      const actual = (await ok(await manager.get('/api/integrations/mcp-server/workspaces?workspace_id=' + workspaceId),
        'Verify own workspace opt-out')).data.workspace;
      assert.equal(actual.workspaceId, workspaceId); assert.equal(actual.enabled, false);
    } catch { failures.push('OwnWorkspaceOptOutUnconfirmed'); }
    if (restore) try {
      await ok(await manager.patch('/api/integrations/mcp-server', { data: restore }), 'Restore prior MCP settings');
      const actual = (await ok(await manager.get('/api/integrations/mcp-server'), 'Verify restored MCP settings')).data;
      assert.equal(actual.desiredEnabled === true, restore.enabled);
      assert.deepEqual(actual.capabilities.filter(value => value.enabled).map(value => value.id).sort(), [...restore.tools].sort());
      proof.mcpSettingsRestored = true;
    } catch { failures.push('PriorSettingsRestoreUnconfirmed'); }
    if (ownerId) try {
      assert.equal((await ok(await manager.post('/api/auth/sign-out', { data: {} }), 'Close own management session')).success, true);
      const current = await ok(await manager.get('/api/auth/get-session'), 'Verify own session ended');
      assert(!current?.user && !current?.session); proof.ownSessionSignedOut = true;
    } catch { failures.push('OwnSessionClosureUnconfirmed'); }
  }
  for (const context of contexts) try { await context.dispose(); } catch { failures.push('APIContextClosureUnconfirmed'); }
  try {
    proof.originalAfter = prefix + '-original-after.json';
    await snapshotProtectedCompiledFixture(acceptance, proof.originalAfter);
    assertCompiledAcceptanceUnchanged(acceptance);
    for (const [file, hash] of Object.entries(helperHashes)) assert.equal(digest(fs.readFileSync(path.join(repository, file))), hash);
    assert.equal(digest(fs.readFileSync(wheel)), proof.wheelSha256);
    if (fs.existsSync(proof.requestsFile)) {
      validateCompiledOperationJournal(readPrivateJson(proof.requestsFile, acceptance.root),
        { nonce, workspaces: proof.workspaces }, proof.actualCompiledOperationsPassed === true);
      proof.requestsSha256 = digest(fs.readFileSync(proof.requestsFile));
    }
    proof.originalRowsXminBytesAndAnchorsPreserved = true;
  } catch { failures.push('PreservationVerificationFailed'); }
  proof.workspacesRetainedForEvidence = true; proof.failures = failures;
  proof.processExit = { closed, code: exitCode, signal: exitSignal, stderrBytes, stdoutBytes };
  proof.passed = proof.actualCompiledOperationsPassed === true && failures.length === 0;
  proof.finishedAt = new Date().toISOString(); proof.phase = proof.passed ? 'complete' : 'failed-evidence-retained'; save();
  console.log(JSON.stringify({ passed: proof.passed, result: proof.result, phase: proof.phase,
    failures, processExit: proof.processExit }));
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  if (!proof.passed) process.exitCode = 1;
}
