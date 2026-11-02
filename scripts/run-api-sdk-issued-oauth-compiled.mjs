import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium, request, expect } from '@playwright/test';
import {
  acceptanceOrigin as origin, assertCompiledAcceptanceUnchanged, digest, git,
  inspectAcceptanceContainer as inspect, loadCompiledAcceptance,
  observeOwnedCompiledOAuthConnection, otherAcceptanceContainers as others,
  repository as repo, snapshotProtectedCompiledFixture,
} from './helpers/compiled-api-sdk-acceptance.mjs';

let acceptance, python, wheel;
try {
  assert.equal(process.platform, 'darwin', 'This actual Keychain acceptance requires macOS.');
  acceptance = loadCompiledAcceptance(process.argv[2], process.argv[3]);
  assert(process.argv[4] && process.argv[5], 'Supply the fresh installed-wheel interpreter and wheel.');
  python = path.resolve(process.argv[4]); wheel = path.resolve(process.argv[5]);
  assert(fs.statSync(python).isFile()); fs.accessSync(python, fs.constants.X_OK);
  const file = fs.lstatSync(wheel); assert(file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid?.() && file.size <= 2 * 1024 * 1024);
} catch (error) {
  console.error(JSON.stringify({ suite: 'compiled-issued-oauth-keychain', passed: false, phase: 'preflight',
    errorType: error instanceof Error ? error.name : 'UnknownError' })); process.exit(1);
}
const { root, runtime, sourceSha, runtimePath: runtimeProof } = acceptance;
const nonce = crypto.randomUUID(), seedRequestId = crypto.randomUUID();
const helper = path.join(repo, 'scripts/helpers/python_sdk_issued_oauth_keychain_probe.py');
const sdkSource = path.join(repo, 'packages/canvas-notebook-python/src/canvas_notebook');
const runtimeSourceHashes = Object.fromEntries(fs.readdirSync(sdkSource).filter(name => name.endsWith('.py') || name === 'py.typed')
  .map(name => [name, digest(fs.readFileSync(path.join(sdkSource, name)))]));
assert(Object.keys(runtimeSourceHashes).length > 0 && Object.keys(runtimeSourceHashes).length <= 64);
const prefix = path.join(root, 'issued-oauth-keychain-refresh-' + Date.now());
const proof = { sourceSha, runtimeProof, result: prefix + '-result.json', startedAt: new Date().toISOString(),
  helperSha256: digest(fs.readFileSync(helper)), wheelSha256: digest(fs.readFileSync(wheel)), runtimeSourceHashes,
  preservationFixture: acceptance.fixturePath, passed: false,
  actualTokenExpiryWait: true, events: [], phase: 'preflight' };
const save = () => fs.writeFileSync(proof.result, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
const stage = phase => { proof.phase = phase; save(); console.log(JSON.stringify({ phase, result: proof.result })); };
let browser, context, rest, child, closed = false, exitCode, exitSignal, sdkConnectionId, integration, issuedCredential, restore, workspace;
let stderrBytes = 0, queued = [], buffered = '', waiting, streamFailure = false, interrupted = false, cleaning = false;
const interrupt = () => { interrupted = true; streamFailure = true; child?.kill('SIGTERM'); waiting?.(); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const pages = [], errors = []; let ownerUserId, expectedClientId, seedRequestAttempted = false;
const permittedEvents = new Set(['wheel_verified', 'authorize', 'authenticated', 'searched_and_read', 'created', 'edited',
  'issued_bearer', 'expired_bearer', 'issued_keychain', 'expiry_wait', 'refreshed', 'independent_readback', 'keychain_cleaned', 'complete', 'failed']);
async function ok(response, label) {
  if (interrupted && !cleaning) throw new Error('Owned SDK acceptance interrupted.');
  if (!response.ok()) { const body = await response.json().catch(() => ({})); proof.httpFailure = {label, status: response.status(), code: typeof body.code === 'string' && /^[A-Z_]{1,80}$/.test(body.code) ? body.code : null}; save(); throw new Error(label + ': HTTP ' + response.status()); }
  return response.json();
}
async function next(expected, timeout = 100000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (streamFailure) throw new Error('Private SDK protocol exceeded its bounds.');
    if (queued.length) {
      const value = queued.shift();
      if (value.event === 'failed') {
        proof.sdkFailure = { stage: /^[a-z_]{1,40}$/.test(value.stage) ? value.stage : 'unknown', errorType: /^[A-Za-z]{1,80}$/.test(value.errorType) ? value.errorType : 'unknown' }; save();
        throw new Error('Private SDK probe reported a failure.');
      }
      if (value.event === 'expiry_wait') { proof.secondsRemaining = value.secondsRemaining; save(); console.log(JSON.stringify({ phase: 'waiting-for-actual-server-token-expiry', secondsRemaining: value.secondsRemaining })); continue; }
      if (value.event !== expected) throw new Error('Unexpected bounded SDK protocol event.');
      if (value.event !== 'authorize') { proof.events.push(value); save(); }
      return value;
    }
    if (closed) throw new Error('SDK process ended before its expected event.');
    await new Promise(resolve => { const timer = setTimeout(() => { waiting = undefined; resolve(); }, 1000); waiting = () => { clearTimeout(timer); waiting = undefined; resolve(); }; });
  }
  throw new Error('SDK protocol exceeded its bounded phase deadline.');
}
const send = value => new Promise((resolve, reject) => child.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(new Error('Private SDK input failed.')) : resolve()));
async function connections() { return (await ok(await context.request.get('/api/integrations/mcp-server/connections'), 'Connections')).data.connections; }
(async () => {
  assert(runtime.passed && runtime.originalRowsXminBytesAndAnchorProofsPreserved); assert.equal(runtime.sourceSha, sourceSha);
  assert.equal(git('rev-parse', 'HEAD'), sourceSha); assert.equal(git('status', '--porcelain'), '');
  const container = inspect(); assert.equal(container.Id, runtime.containerId); assert.equal(container.Image, runtime.imageId); assert.equal(container.State.Health.Status, 'healthy');
  proof.containerId = container.Id; proof.imageId = container.Image; proof.otherContainers = others();
  proof.originalBefore = prefix + '-original-before.json'; await snapshotProtectedCompiledFixture(acceptance, proof.originalBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(proof.originalBefore)), JSON.parse(fs.readFileSync(runtime.afterOriginalUpload)));
  const env = acceptance.environment;
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } });
  await ok(await context.request.post('/api/auth/sign-in/email', { headers: { Origin: origin }, data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD } }), 'Bootstrap sign-in');
  const session = await ok(await context.request.get('/api/auth/get-session'), 'Session identity');
  assert.equal(session.user.email, env.BOOTSTRAP_ADMIN_EMAIL); ownerUserId = session.user.id;
  const settings = (await ok(await context.request.get('/api/server-settings'), 'Review setting')).data; assert.equal(settings.documentReviewEnabled, false);
  const current = (await ok(await context.request.get('/api/integrations/mcp-server'), 'MCP settings')).data;
  restore = { enabled: current.desiredEnabled === true, tools: current.capabilities.filter(value => value.enabled).map(value => value.id) };
  const tools = [...new Set([...restore.tools, 'auth_probe', 'list_workspaces', 'search_knowledge', 'read_knowledge_source', 'create_knowledge_source', 'edit_knowledge_source'])];
  await ok(await context.request.patch('/api/integrations/mcp-server', { data: { enabled: true, tools } }), 'Enable needed test capabilities');
  workspace = (await ok(await context.request.post('/api/workspaces', { data: { type: 'personal', name: 'Issued SDK OAuth ' + nonce } }), 'Own isolated workspace')).workspace;
  proof.workspaceId = workspace.id;
  await ok(await context.request.put('/api/integrations/mcp-server/workspaces', { data: { workspaceId: workspace.id, enabled: true } }), 'Opt in only own workspace');
  seedRequestAttempted = true;
  const issued = (await ok(await context.request.post('/api/api-access/integrations', { headers: { Origin: origin }, data: { requestId: seedRequestId, name: 'SDK OAuth seed ' + nonce, workspaceIds: [workspace.id], actions: ['read', 'create'], expiresAt: Date.now() + 86400000 } }), 'Issue actual seed key')).data;
  integration = issued.integration; issuedCredential = issued.credential;
  rest = await request.newContext({ baseURL: origin, extraHTTPHeaders: { 'X-Canvas-API-Key': issued.key }, storageState: { cookies: [], origins: [] } }); issued.key = '';
  const query = 'IssuedOAuth' + nonce.replaceAll('-', '');
  proof.actualKeyDifferential = [];
  for (const [label, response] of [
    ['workspace-key', await rest.get('/api/workspaces')],
    ['browse-key', await rest.post('/api/documents/browse', {data:{apiVersion:1,workspaceId:workspace.id}})],
    ['mcp-key', await rest.post('/mcp', {headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_workspaces',arguments:{}}}})],
  ]) { const body=await response.json().catch(()=>({})); proof.actualKeyDifferential.push({label,status:response.status(),code:body.code ?? body.result?.structuredContent?.code ?? null,mcpError:body.result?.isError===true,hasResult:!!body.result}); }
  save();
  assert.equal(proof.actualKeyDifferential.find(value => value.label === 'workspace-key').status, 200);
  assert.equal(proof.actualKeyDifferential.find(value => value.label === 'mcp-key').mcpError, false);
  const seed = await ok(await rest.post('/api/documents/create', { data: { apiVersion: 1, workspaceId: workspace.id, path: 'seed.md', content: '# Issued OAuth seed\n\n' + query + '\n\n' + 'Persisted paging content 🧪.\n\n'.repeat(25), idempotencyKey: 'oauth-seed-' + nonce } }), 'Actual seed document');
  assert.equal(seed.outcome, 'created');
  const priorIds = new Set((await connections()).map(value => value.connectionId));
  const metadata = await ok(await context.request.get('/.well-known/oauth-authorization-server/api/auth'), 'OAuth metadata');
  const resource = await ok(await context.request.get('/.well-known/oauth-protected-resource/mcp'), 'Resource metadata'); assert.equal(resource.resource, origin + '/mcp');
  assert.equal(metadata.issuer, origin + '/api/auth'); assert.deepEqual(resource.authorization_servers, [metadata.issuer]);
  for (const key of ['authorization_endpoint', 'registration_endpoint', 'token_endpoint']) {
    const endpoint = new URL(metadata[key]); assert.equal(endpoint.origin, origin); assert(endpoint.pathname.startsWith('/api/auth/'));
    assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  }
  const port = net.createServer(); await new Promise((resolve, reject) => { port.once('error', reject); port.listen(0, '127.0.0.1', resolve); });
  const callbackPort = port.address().port; await new Promise((resolve, reject) => port.close(error => error ? reject(error) : resolve()));
  const redirectUri = `http://127.0.0.1:${callbackPort}/canvas-sdk-oauth/${nonce}`;
  const oldText = 'Issued SDK original target 😀', newText = 'Issued SDK changed target 🧪';
  const config = { event: 'configure', endpoint: origin + '/mcp', issuer: metadata.issuer, authorizationEndpoint: metadata.authorization_endpoint,
    workspaceId: workspace.id, userId: session.user.id, sessionId: session.session.id, redirectUri,
    seedDocumentId: seed.document.documentId, seedVersion: seed.document.version, query,
    createPath: 'oauth-sdk.md', source: '# Issued OAuth SDK\n\n' + oldText + '.\n\nStable final tail.\n', oldText, newText,
    createKey: 'sdk-create-' + nonce, editKey: 'sdk-edit-' + nonce, profile: 'issued-' + nonce,
    runtimeSourceHashes, wheelUri: pathToFileURL(wheel).href, wheelSha256: crypto.createHash('sha256').update(fs.readFileSync(wheel)).digest('hex'),
    effectiveScopes: [...new Set([...resource.scopes_supported, ...(metadata.scopes_supported.includes('offline_access') ? ['offline_access'] : [])])] };
  stage('genuine-browser-oauth-current-installed-wheel-and-macos-keychain');
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  child = spawn(python, ['-I', '-B', helper], { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }); proof.childPid = child.pid; save();
  child.stdout.on('data', chunk => { buffered += chunk; if (buffered.length > 256 * 1024) streamFailure = true;
    for (;;) { const end = buffered.indexOf('\n'); if (end < 0) break; const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try { const value = JSON.parse(line); if (line.length > 65536 || !permittedEvents.has(value.event)) streamFailure = true; else queued.push(value); } catch { streamFailure = true; }
    } if (queued.length > 32) streamFailure = true; waiting?.(); });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16384) streamFailure = true; });
  child.stdin.on('error', () => { streamFailure = true; waiting?.(); }); child.once('error', () => { streamFailure = true; waiting?.(); });
  child.once('close', (code, signal) => { closed = true; exitCode = code; exitSignal = signal; waiting?.(); });
  await send(config); await next('wheel_verified'); const authorization = await next('authorize');
  const consent = await context.newPage(); pages.push(consent);
  try {
    const target = new URL(authorization.url), declared = new URL(metadata.authorization_endpoint); assert.equal(target.origin, declared.origin); assert.equal(target.pathname, declared.pathname);
    expectedClientId = target.searchParams.get('client_id'); assert(expectedClientId);
    assert.equal(target.searchParams.get('redirect_uri'), redirectUri); assert.equal(target.searchParams.get('resource'), origin + '/mcp'); assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    const expected = new URL(redirectUri); const callback = consent.waitForResponse(response => { const actual = new URL(response.url()); return actual.origin === expected.origin && actual.pathname === expected.pathname; }, { timeout: 75000 });
    await consent.goto(authorization.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const accept = consent.locator('button[name="accept"][value="true"]'); await expect(accept).toBeVisible({ timeout: 45000 }); await accept.click();
    const received = await callback; assert.equal(received.status(), 200); await received.finished();
    await expect(consent.getByText('Authorization received. You may close this window.', { exact: true })).toBeVisible();
    const own = await observeOwnedCompiledOAuthConnection(acceptance, ownerUserId, expectedClientId, await connections());
    assert(own && !priorIds.has(own.connectionId) && own.clientName === 'Canvas Notebook Python'); sdkConnectionId = own.connectionId;
    await ok(await context.request.put('/api/integrations/mcp-server/connections/workspaces', { data: { connectionId: sdkConnectionId, workspaceIds: [workspace.id] } }), 'Grant owned SDK workspace');
  } catch { throw new Error('Actual SDK browser consent/callback or workspace grant failed.'); }
  finally { authorization.url = undefined; await consent.close(); }
  await send({ event: 'authorized' }); await next('authenticated'); await next('searched_and_read'); const created = await next('created');
  for (let i = 0; i < 2; i++) {
    const page = await context.newPage(); pages.push(page);
    await page.addInitScript(({ id, host }) => { if (location.origin === host) { localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false'); } }, { id: workspace.id, host: origin });
    await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(created.result.document.path)}`, { waitUntil: 'domcontentloaded' });
    const editor = page.locator('.tiptap-editor-shell .ProseMirror'); await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45000 }); await expect(editor).toContainText(oldText);
  }
  await send({ event: 'editor_open' }); const edited = await next('edited'); proof.operationId = edited.result.operationId;
  for (const page of pages.filter(page => !page.isClosed())) {
    let editor = page.locator('.tiptap-editor-shell .ProseMirror'); await expect(editor).toContainText(newText); await expect(editor).not.toContainText(oldText);
    await page.reload({ waitUntil: 'domcontentloaded' }); editor = page.locator('.tiptap-editor-shell .ProseMirror'); await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45000 });
    await expect(editor).toContainText(newText); await expect(editor).not.toContainText(oldText);
  }
  proof.actualTwoOpenEditorsAndReload = true; await send({ event: 'editor_verified' });
  await next('issued_bearer'); await next('issued_keychain'); stage('waiting-for-actual-server-token-expiry-and-official-sdk-refresh');
  await next('expired_bearer', 1100000); await next('refreshed'); await next('independent_readback'); await next('keychain_cleaned'); await next('complete');
  child.stdin.end(); for (let i = 0; !closed && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(closed); assert.equal(exitCode, 0); assert.equal(exitSignal, null); assert.equal(stderrBytes, 0); assert.equal(buffered.length, 0); assert.equal(queued.length, 0);
  proof.actualIssuedOAuthMacOSAutomaticRefreshAndProcessReopen = true;
})().catch(error => { errors.push(error); proof.errorType = error instanceof Error ? error.name : 'UnknownError'; const safeMessage = error instanceof Error ? error.message : ''; proof.error = error instanceof assert.AssertionError ? 'A strict compiled SDK acceptance assertion failed.' : safeMessage.startsWith('Private SDK') || safeMessage.startsWith('SDK ') || safeMessage.startsWith('Actual SDK') ? safeMessage : 'Compiled SDK acceptance failed; no credential-bearing error was printed.'; }).finally(async () => {
  cleaning = true; stage('cleanup-only-owned-sdk-resources');
  if (interrupted) errors.push(new Error('Owned SDK acceptance was interrupted.'));
  if (child && !closed) { child.stdin.end(); child.kill('SIGTERM'); for (let i = 0; !closed && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 100)); if (!closed) { child.kill('SIGKILL'); for (let i = 0; !closed && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 100)); } }
  if (child && !closed) errors.push(new Error('Owned Python process closure unconfirmed.'));
  for (const page of pages) if (!page.isClosed()) try { await page.close(); } catch { errors.push(new Error('Own page closure unconfirmed.')); }
  if (child && closed) try {
    const cleaned = execFileSync(python, ['-I', '-B', helper, '--cleanup-profile'], {cwd:root,
      input:JSON.stringify({endpoint:origin+'/mcp',profile:'issued-'+nonce}),encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']});
    assert.deepEqual(JSON.parse(cleaned),{onlyOwnRecordsRemoved:true}); proof.ownOSRecordsRemovalVerified=true;
  } catch { errors.push(new Error('Owned OS credential cleanup unconfirmed.')); }
  if (context) {
    if (!sdkConnectionId && ownerUserId && expectedClientId) try {
      sdkConnectionId = (await observeOwnedCompiledOAuthConnection(acceptance, ownerUserId, expectedClientId, await connections()))?.connectionId;
    } catch { errors.push(new Error('Own failed-flow consent identity remained unconfirmed.')); }
    if (!integration && seedRequestAttempted) try {
      const found = (await ok(await context.request.get('/api/api-access/integrations?creationRequestId=' + seedRequestId), 'Reconcile own seed issuance')).data.integrations;
      assert(Array.isArray(found) && found.length <= 1);
      if (found.length) {
        assert.equal(found[0].name, 'SDK OAuth seed ' + nonce); assert.deepEqual(found[0].workspaceIds, [workspace.id]); integration = found[0];
        const history = (await ok(await context.request.get(`/api/api-access/integrations/${integration.id}/credentials?issuanceRequestId=${seedRequestId}`), 'Reconcile own seed credential')).data;
        assert.equal(history.credentials.length, 1); issuedCredential = history.credentials[0];
      }
    } catch { errors.push(new Error('Own seed issuance reconciliation remained unconfirmed.')); }
    if (sdkConnectionId) try { await ok(await context.request.delete('/api/integrations/mcp-server/connections', { data: { connectionId: sdkConnectionId } }), 'Revoke owned SDK grant'); assert(!(await connections()).some(value => value.connectionId === sdkConnectionId)); proof.ownOAuthGrantRevoked = true; } catch { errors.push(new Error('Owned SDK grant cleanup unconfirmed.')); }
    if (integration && issuedCredential) try { const current = (await ok(await context.request.get(`/api/api-access/integrations/${integration.id}/credentials`), 'Own seed key metadata')).data;
      await ok(await context.request.delete(`/api/api-access/integrations/${integration.id}/credentials`, { headers: { Origin: origin }, data: { expectedRevision: current.integration.revision, credentialId: issuedCredential.id } }), 'Revoke seed key'); proof.ownSeedKeyRevoked = true;
    } catch { errors.push(new Error('Owned seed credential cleanup unconfirmed.')); }
    if (restore) try { for (let i = 0; i < 2; i++) await ok(await context.request.patch('/api/integrations/mcp-server', { data: restore }), 'Restore exact MCP settings'); proof.mcpSettingsRestored = true; } catch { errors.push(new Error('Original MCP settings restore unconfirmed.')); }
    if (ownerUserId) try {
      const signed = await ok(await context.request.post('/api/auth/sign-out', {headers:{Origin:origin},data:{}}), 'Close only owned bootstrap session');
      assert.equal(signed.success, true); const current = await ok(await context.request.get('/api/auth/get-session'), 'Verify own session ended');
      assert(!current?.user && !current?.session); proof.ownBootstrapSessionSignedOut=true;
    } catch { errors.push(new Error('Own bootstrap session sign-out remained unconfirmed.')); }
    try { await context.close(); } catch { errors.push(new Error('Own browser context closure unconfirmed.')); }
  }
  if (rest) try { await rest.dispose(); } catch { errors.push(new Error('Own API context closure unconfirmed.')); }
  if (browser) try { await browser.close(); } catch { errors.push(new Error('Own browser closure unconfirmed.')); }
  try {
    proof.originalAfter = prefix + '-original-after.json'; await snapshotProtectedCompiledFixture(acceptance, proof.originalAfter);
    assert.deepEqual(JSON.parse(fs.readFileSync(proof.originalAfter)), JSON.parse(fs.readFileSync(proof.originalBefore)));
    const after = inspect(); assert.equal(after.Id, runtime.containerId); assert.equal(after.Image, runtime.imageId); assert.equal(after.State.Health.Status, 'healthy');
    assertCompiledAcceptanceUnchanged(acceptance); assert.equal(digest(fs.readFileSync(helper)), proof.helperSha256);
    assert.equal(digest(fs.readFileSync(wheel)), proof.wheelSha256); proof.originalsAndRuntimePreserved = true;
  } catch { errors.push(new Error('Final preservation verification failed.')); }
  proof.ownWorkspaceRetainedForEvidence = workspace?.id; proof.processExit = { closed, code: exitCode, signal: exitSignal, stderrBytes }; proof.cleanupErrorCount = errors.length;
  proof.passed = errors.length === 0 && proof.actualIssuedOAuthMacOSAutomaticRefreshAndProcessReopen === true;
  proof.finishedAt = new Date().toISOString(); proof.phase = proof.passed ? 'complete' : 'failed-evidence-retained'; save();
  console.log(JSON.stringify({ passed: proof.passed, result: proof.result, phase: proof.phase, error: proof.error, sdkFailure: proof.sdkFailure, processExit: proof.processExit, cleanupErrorCount: proof.cleanupErrorCount }));
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  if (!proof.passed) process.exitCode = 1;
});
