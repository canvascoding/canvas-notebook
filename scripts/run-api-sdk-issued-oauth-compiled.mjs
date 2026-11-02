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
  readPrivateJson, repository as repo, snapshotProtectedCompiledFixture,
  withCompiledFixtureReadOnly,
} from './helpers/compiled-api-sdk-acceptance.mjs';
import { validateCompiledOperationJournal } from './helpers/compiled-operation-journal.mjs';

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
const operationHelper = path.join(repo, 'scripts/helpers/python_sdk_compiled_operations_probe.py');
const sdkSource = path.join(repo, 'packages/canvas-notebook-python/src/canvas_notebook');
const runtimeSourceHashes = Object.fromEntries(fs.readdirSync(sdkSource).filter(name => name.endsWith('.py') || name === 'py.typed')
  .map(name => [name, digest(fs.readFileSync(path.join(sdkSource, name)))]));
assert(Object.keys(runtimeSourceHashes).length > 0 && Object.keys(runtimeSourceHashes).length <= 64);
const prefix = path.join(root, 'issued-oauth-keychain-refresh-' + Date.now());
const proof = { sourceSha, runtimeProof, result: prefix + '-result.json', startedAt: new Date().toISOString(),
  helperSha256: digest(fs.readFileSync(helper)), wheelSha256: digest(fs.readFileSync(wheel)), runtimeSourceHashes,
  preservationFixture: acceptance.fixturePath, passed: false,
  actualTokenExpiryWait: true, events: [], editorChecks: [], phase: 'preflight', editorCycles: 6,
  operationHelperSha256: digest(fs.readFileSync(operationHelper)), requestsFile: prefix + '-requests-private.json' };
fs.writeFileSync(proof.requestsFile, '[]\n', { mode: 0o600, flag: 'wx' });
const save = () => fs.writeFileSync(proof.result, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
const stage = phase => { proof.phase = phase; save(); console.log(JSON.stringify({ phase, result: proof.result })); };
let browser, context, rest, child, closed = false, exitCode, exitSignal, sdkConnectionId, integration, issuedCredential, restore, workspace, destinationWorkspace;
const ownWorkspaceOptIns = new Set();
let stderrBytes = 0, queued = [], buffered = '', waiting, streamFailure = false, interrupted = false, cleaning = false;
const interrupt = () => { interrupted = true; streamFailure = true; child?.kill('SIGTERM'); waiting?.(); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const pages = [], errors = []; let ownerUserId, expectedClientId, seedRequestAttempted = false;
const permittedEvents = new Set(['wheel_verified', 'authorize', 'authenticated', 'searched_and_read', 'created', 'edited',
  'copy_busy', 'operation_checked', 'refreshed_operation_checked', 'refreshed_edit_status', 'tool_failure',
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
      if (value.event === 'tool_failure') {
        proof.sdkToolFailure = { stage: /^[a-z_]{1,40}$/.test(value.stage) ? value.stage : 'unknown',
          code: typeof value.code === 'string' && /^[A-Z_]{1,100}$/.test(value.code) ? value.code : null }; save();
        throw new Error('Private SDK probe reported a tool failure.');
      }
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
async function verifyEditor(page, cycle, phase, expected, previous) {
  const editor = page.locator('.tiptap-editor-shell .ProseMirror');
  const checking = assertion => { proof.editorCheck = { cycle, page: pages.indexOf(page), phase, assertion }; save(); };
  checking('editable'); await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45000 });
  checking('current-text'); await expect(editor).toContainText(expected);
  checking('previous-text-absent'); await expect(editor).not.toContainText(previous);
  proof.editorChecks.push({ cycle, page: pages.indexOf(page), phase, currentTextVisible: true, previousTextAbsent: true });
  delete proof.editorCheck; save();
}
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
  const tools = [...new Set([...restore.tools, 'auth_probe', 'list_workspaces', 'get_knowledge_manifest', 'search_knowledge',
    'read_knowledge_source', 'create_knowledge_source', 'edit_knowledge_source', 'copy_knowledge_source', 'move_knowledge_source', 'delete_knowledge_source'])];
  await ok(await context.request.patch('/api/integrations/mcp-server', { data: { enabled: true, tools } }), 'Enable needed test capabilities');
  workspace = (await ok(await context.request.post('/api/workspaces', { data: { type: 'personal', name: 'Issued SDK OAuth ' + nonce } }), 'Own isolated workspace')).workspace;
  proof.workspaceId = workspace.id;
  ownWorkspaceOptIns.add(workspace.id);
  await ok(await context.request.put('/api/integrations/mcp-server/workspaces', { data: { workspaceId: workspace.id, enabled: true } }), 'Opt in only own workspace');
  destinationWorkspace = (await ok(await context.request.post('/api/workspaces', { data: { type: 'personal', name: 'Issued SDK OAuth operations ' + nonce } }), 'Own isolated destination workspace')).workspace;
  assert.notEqual(destinationWorkspace.id, workspace.id); proof.destinationWorkspaceId = destinationWorkspace.id;
  ownWorkspaceOptIns.add(destinationWorkspace.id);
  await ok(await context.request.put('/api/integrations/mcp-server/workspaces', { data: { workspaceId: destinationWorkspace.id, enabled: true } }), 'Opt in only own destination workspace');
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
    workspaceId: workspace.id, destinationWorkspaceId: destinationWorkspace.id, userId: session.user.id, sessionId: session.session.id, redirectUri,
    seedDocumentId: seed.document.documentId, seedVersion: seed.document.version, query,
    createPath: 'source-ü😀.md', source: '# Issued OAuth SDK\n\n' + oldText + '.\n\nStable final tail.\n', oldText, newText,
    createKey: 'sdk-create-' + nonce, editKey: 'sdk-edit-' + nonce, profile: 'issued-' + nonce,
    nonce, editorCycles: proof.editorCycles, requestsFile: proof.requestsFile,
    operationJournalHelper: operationHelper, operationJournalHelperSha256: proof.operationHelperSha256,
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
    await ok(await context.request.put('/api/integrations/mcp-server/connections/workspaces', { data: { connectionId: sdkConnectionId, workspaceIds: [workspace.id, destinationWorkspace.id] } }), 'Grant only both owned SDK workspaces');
  } catch { throw new Error('Actual SDK browser consent/callback or workspace grant failed.'); }
  finally { authorization.url = undefined; await consent.close(); }
  await send({ event: 'authorized' }); await next('authenticated'); await next('searched_and_read'); const created = await next('created');
  for (let i = 0; i < 2; i++) {
    const page = await context.newPage(); pages.push(page);
    await page.addInitScript(({ id, host }) => { if (location.origin === host) { localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false'); } }, { id: workspace.id, host: origin });
    await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(created.result.document.path)}`, { waitUntil: 'domcontentloaded' });
    const editor = page.locator('.tiptap-editor-shell .ProseMirror'); await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45000 }); await expect(editor).toContainText(oldText);
  }
  proof.editOperationIds = []; let lastEdited;
  for (let cycle = 0; cycle < proof.editorCycles; cycle++) {
    await send({ event: 'editor_open' }); const edited = await next('edited'); assert.equal(edited.index, cycle);
    lastEdited = edited;
    proof.operationId = edited.result.operationId; proof.editOperationIds.push(edited.result.operationId);
    for (const page of pages.filter(page => !page.isClosed())) {
      const expected = `${newText} [${cycle + 1}]`, previous = cycle === 0 ? oldText : `${newText} [${cycle}]`;
      await verifyEditor(page, cycle, 'live', expected, previous);
      proof.editorCheck = { cycle, page: pages.indexOf(page), phase: 'reload', assertion: 'navigation' }; save();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await verifyEditor(page, cycle, 'reload', expected, previous);
    }
    await send({ event: 'editor_verified' });
  }
  assert.equal(new Set(proof.editOperationIds).size, proof.editorCycles);
  assert.equal(proof.editorChecks.length, proof.editorCycles * 4); proof.actualTwoOpenEditorsAndReload = true;
  stage('copy-with-open-source-must-report-busy-and-retain-original');
  const blocked = await next('copy_busy');
  const copyOperationId = `compiled-copy-sdk-${nonce}`;
  assert.deepEqual(blocked.result, { apiVersion: 1, success: false, code: 'COPY_BUSY', operationId: copyOperationId });
  const pendingJournal = validateCompiledOperationJournal(readPrivateJson(proof.requestsFile, root),
    { workspaces: [workspace.id, destinationWorkspace.id], nonce });
  assert.equal(pendingJournal.length, 1); assert.equal(pendingJournal[0].kind, 'copy'); assert.equal(pendingJournal[0].mode, 'sdk');
  const documentId = created.result.document.documentId;
  const keyHex = crypto.createHash('sha256').update(`canvas.collaboration.room-owner.v1\0${documentId}`).digest('hex').slice(0, 16);
  const lockParts = [Number.parseInt(keyHex.slice(0, 8), 16), Number.parseInt(keyHex.slice(8), 16)];
  const observeSource = () => withCompiledFixtureReadOnly(acceptance, async database => {
    const rows = (await database.query(`SELECT yjs_state,document_sequence,room_owner_token,room_owner_backend_pid,room_owner_backend_start
      FROM public.collaboration_yjs_states WHERE document_id=$1 AND workspace_id=$2 AND path=$3 AND status='active'`,
    [documentId, workspace.id, created.result.document.path])).rows;
    assert.equal(rows.length, 1); const row = rows[0]; assert(Buffer.isBuffer(row.yjs_state));
    const held = (await database.query(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
      AND granted AND mode='ExclusiveLock' AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
      AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=1) AS held`, lockParts)).rows[0].held;
    return { nativeSha256: digest(row.yjs_state), sequence: Number(row.document_sequence),
      ownerReleased: row.room_owner_token === null && row.room_owner_backend_pid === null && row.room_owner_backend_start === null && held === false };
  });
  const activeSource = await observeSource(); assert.equal(activeSource.sequence, proof.editorCycles); assert.equal(activeSource.ownerReleased, false);
  const pending = await withCompiledFixtureReadOnly(acceptance, async database => {
    const operations = (await database.query(`SELECT status,plan_id,error_code FROM public.workspace_file_operations
      WHERE operation_id=$1 AND source_workspace_id=$2 AND destination_workspace_id=$3`,
    [copyOperationId, workspace.id, destinationWorkspace.id])).rows;
    const steps = (await database.query('SELECT step_key FROM public.workspace_file_operation_steps WHERE operation_id=$1', [copyOperationId])).rows;
    const native = (await database.query('SELECT operation_id FROM public.collaboration_native_copy_receipts WHERE operation_id=$1', [copyOperationId])).rows;
    const scenes = (await database.query('SELECT operation_id FROM public.collaboration_excalidraw_copy_receipts WHERE operation_id=$1', [copyOperationId])).rows;
    const target = (await database.query('SELECT id FROM public.collaboration_documents WHERE workspace_id=$1 AND path=$2',
    [destinationWorkspace.id, 'sdk-copied.md'])).rows;
    assert.deepEqual(operations, [{ status: 'prepared', plan_id: pendingJournal[0].sdk.plan_id, error_code: null }]);
    assert.deepEqual(steps, []); assert.deepEqual(native, []); assert.deepEqual(scenes, []); assert.deepEqual(target, []);
    return { originalPreparedHeader: true, recordedSteps: 0, nativeBirths: 0, sceneBirths: 0, destinationDocuments: 0 };
  });
  proof.openSourceCopyBusy = { ...pending, operationId: copyOperationId, source: activeSource }; save();
  for (const page of pages.filter(page => !page.isClosed())) await page.close();
  await expect.poll(observeSource, { timeout: 45000, intervals: [100, 250, 500, 1000] })
    .toEqual({ ...activeSource, ownerReleased: true });
  const reread = await ok(await context.request.post('/api/documents/read', { data: {
    apiVersion: 1, workspaceId: workspace.id, documentId, format: 'native', maxBytes: 16384,
  } }), 'Released source readback');
  assert.equal(reread.complete, true); assert.equal(reread.fragment, lastEdited.body); assert.equal(reread.document.version, lastEdited.document.version);
  proof.ownSourceOwnerReleaseVerified = true; proof.copyUsesExplicitOriginalRecovery = true; save();
  await send({ event: 'source_released' });
  for (const kind of ['copy', 'move', 'delete']) {
    const checked = await next('operation_checked'); assert.equal(checked.kind, kind); assert.equal(checked.operationId, `compiled-${kind}-sdk-${nonce}`); assert.equal(checked.completed, true);
  }
  const journalContext = { workspaces: [workspace.id, destinationWorkspace.id], nonce };
  const journal = validateCompiledOperationJournal(readPrivateJson(proof.requestsFile, root), journalContext);
  assert.equal(journal.length, 3); assert(journal.every(row => row.mode === 'sdk')); proof.ownOperationJournalVerified = true;
  await next('issued_bearer'); await next('issued_keychain'); stage('waiting-for-actual-server-token-expiry-and-official-sdk-refresh');
  await next('expired_bearer', 1100000); await next('refreshed');
  const edits = await next('refreshed_edit_status'); assert.equal(edits.groups, proof.editorCycles); assert.equal(edits.historicalOwnershipPreserved, true);
  for (const kind of ['copy', 'move', 'delete']) {
    const checked = await next('refreshed_operation_checked'); assert.equal(checked.kind, kind); assert.equal(checked.operationId, `compiled-${kind}-sdk-${nonce}`); assert.equal(checked.historicalOwnershipPreserved, true);
  }
  await next('independent_readback'); await next('keychain_cleaned'); const complete = await next('complete');
  assert.equal(complete.editCycles, proof.editorCycles); assert.equal(complete.pathOperations, 3);
  assert.equal(complete.historicalEditStatusesAfterRefresh, proof.editorCycles); assert.equal(complete.historicalPathStatusesAndRecoveryAfterRefresh, 3); assert.equal(complete.authorizations, 1);
  child.stdin.end(); for (let i = 0; !closed && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(closed); assert.equal(exitCode, 0); assert.equal(exitSignal, null); assert.equal(stderrBytes, 0); assert.equal(buffered.length, 0); assert.equal(queued.length, 0);
  proof.actualIssuedOAuthMacOSAutomaticRefreshAndProcessReopen = true;
})().catch(async error => {
  errors.push(error); proof.errorType = error instanceof Error ? error.name : 'UnknownError';
  if (proof.editorCheck) {
    proof.failedEditorCheck = { ...proof.editorCheck }; proof.failedEditorObservations = [];
    for (const page of pages.filter(page => !page.isClosed())) try {
      const editor = page.locator('.tiptap-editor-shell .ProseMirror'), count = await editor.count();
      const text = count === 1 ? await editor.textContent({ timeout: 1000 }) : null;
      const cycle = proof.failedEditorCheck.cycle;
      proof.failedEditorObservations.push({ page: pages.indexOf(page), count,
        currentTextVisible: typeof text === 'string' && text.includes(`Issued SDK changed target 🧪 [${cycle + 1}]`),
        previousTextVisible: typeof text === 'string' && text.includes(cycle === 0 ? 'Issued SDK original target 😀' : `Issued SDK changed target 🧪 [${cycle}]`) });
    } catch { proof.failedEditorObservations.push({ page: pages.indexOf(page), observationUnavailable: true }); }
  }
  const safeMessage = error instanceof Error ? error.message : ''; proof.error = error instanceof assert.AssertionError ? 'A strict compiled SDK acceptance assertion failed.' : safeMessage.startsWith('Private SDK') || safeMessage.startsWith('SDK ') || safeMessage.startsWith('Actual SDK') ? safeMessage : 'Compiled SDK acceptance failed; no credential-bearing error was printed.';
}).finally(async () => {
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
    let ownOptOutsVerified = true;
    for (const workspaceId of ownWorkspaceOptIns) try {
      assert.equal((await ok(await context.request.put('/api/integrations/mcp-server/workspaces', { data: { workspaceId, enabled: false } }), 'Remove only own workspace opt-in')).data.enabled, false);
      const actual = (await ok(await context.request.get('/api/integrations/mcp-server/workspaces?workspace_id=' + workspaceId), 'Verify own workspace opt-out')).data.workspace;
      assert.equal(actual.workspaceId, workspaceId); assert.equal(actual.enabled, false);
    } catch { ownOptOutsVerified = false; errors.push(new Error('Owned workspace opt-out unconfirmed.')); }
    proof.ownWorkspaceOptInsDisabled = ownOptOutsVerified;
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
    assert.equal(digest(fs.readFileSync(operationHelper)), proof.operationHelperSha256);
    const journal = readPrivateJson(proof.requestsFile, root);
    if (workspace && destinationWorkspace) validateCompiledOperationJournal(journal, { workspaces: [workspace.id, destinationWorkspace.id], nonce });
    else assert.deepEqual(journal, []);
    proof.retainedOperationRequests = journal.map(row => ({ kind: row.kind, operationId: row.sdk.operation_id }));
    assert.equal(digest(fs.readFileSync(wheel)), proof.wheelSha256); proof.originalsAndRuntimePreserved = true;
  } catch { errors.push(new Error('Final preservation verification failed.')); }
  proof.ownWorkspaceRetainedForEvidence = workspace?.id; proof.ownDestinationWorkspaceRetainedForEvidence = destinationWorkspace?.id;
  proof.processExit = { closed, code: exitCode, signal: exitSignal, stderrBytes }; proof.cleanupErrorCount = errors.length;
  proof.passed = errors.length === 0 && proof.actualIssuedOAuthMacOSAutomaticRefreshAndProcessReopen === true;
  proof.finishedAt = new Date().toISOString(); proof.phase = proof.passed ? 'complete' : 'failed-evidence-retained'; save();
  console.log(JSON.stringify({ passed: proof.passed, result: proof.result, phase: proof.phase, error: proof.error, sdkFailure: proof.sdkFailure, processExit: proof.processExit, cleanupErrorCount: proof.cleanupErrorCount }));
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  if (!proof.passed) process.exitCode = 1;
});
