import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const repository = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
export const acceptanceOrigin = 'http://127.0.0.1:3100';
const containerName = 'canvas-local-prod-notebook';
const requiredSources = ['app/api/workspaces/route.ts', 'app/lib/api-keys/authentication.ts',
  'app/lib/api-keys/management.ts', 'app/lib/documents/create-http.ts',
  'app/lib/documents/copy-http.ts', 'app/lib/documents/path-http.ts',
  'app/lib/markdown/workspace-source-authority-stage.ts',
  'app/lib/files/workspace-operation-mcp-path-service.ts',
  'app/components/settings/ApiAccessSettingsPanel.tsx'];
const anchorNames = ['canvas-upload-live-anchor.json', 'canvas-markdown-upload-attempts-anchor.json',
  'canvas-markdown-create-births-anchor.json'];
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
export const docker = args => execFileSync('docker', args, {
  cwd: repository, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

export function readPrivateJson(file, root) {
  const absolute = path.resolve(file);
  if (root) assert(fs.realpathSync(path.dirname(absolute)).startsWith(root + path.sep)
    || fs.realpathSync(path.dirname(absolute)) === root, 'Private evidence must stay in its owned directory.');
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.()
      && (stat.mode & 0o077) === 0 && stat.size <= 16 * 1024 * 1024, 'Expected bounded private evidence.');
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally { fs.closeSync(descriptor); }
}

export function inspectAcceptanceContainer() {
  const container = JSON.parse(docker(['inspect', containerName]))[0];
  assert.equal(container.Name, '/' + containerName);
  assert.equal(container.Config.Labels['io.canvas.local-prod'], 'true');
  assert.equal(container.Config.Labels['com.docker.compose.project'], 'canvas-local-prod');
  assert.equal(container.State.Running, true); assert.equal(container.State.Health?.Status, 'healthy');
  const ports = container.NetworkSettings.Ports['3000/tcp'];
  assert(Array.isArray(ports) && ports.length === 1);
  assert.deepEqual(ports[0], { HostIp: '127.0.0.1', HostPort: '3100' });
  return container;
}

export function otherAcceptanceContainers() {
  return docker(['ps', '--format', '{{.Names}}|{{.ID}}']).trim().split('\n')
    .filter(line => !line.startsWith(containerName + '|')).sort();
}

export function loadCompiledAcceptance(runtimeFile, fixtureFile) {
  assert(runtimeFile && fixtureFile, 'Supply the current runtime proof and private preservation fixture.');
  const runtimePath = path.resolve(runtimeFile), fixturePath = path.resolve(fixtureFile);
  const root = fs.realpathSync(path.dirname(runtimePath)), stat = fs.lstatSync(root);
  assert(stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
  const runtime = readPrivateJson(runtimePath, root), fixture = readPrivateJson(fixturePath, root);
  const sourceSha = git('rev-parse', 'HEAD');
  assert.equal(git('status', '--porcelain'), '', 'Build and test a clean committed source.');
  assert(runtime.passed && runtime.originalRowsXminBytesAndAnchorProofsPreserved);
  assert.equal(runtime.sourceSha, sourceSha); assert.match(sourceSha, /^[a-f0-9]{40}$/u);
  assert.equal(fixture.version, 1); assert.match(fixture.databaseName, /^canvas_document_qa_[a-f0-9]{12}$/u);
  const suffix = fixture.databaseName.slice('canvas_document_qa_'.length);
  assert.equal(fixture.dataVolume, `canvas-local-prod-document-qa-${suffix}-data`);
  assert.match(fixture.sourceAttemptDigest, /^[a-f0-9]{64}$/u);
  assert(typeof fixture.protectedRootRelativePath === 'string' && fixture.protectedRootRelativePath.startsWith('workspaces/')
    && fixture.protectedRootRelativePath.length <= 1024 && !fixture.protectedRootRelativePath.split('/').includes('..'));
  assert(typeof fixture.workspaceName === 'string' && fixture.workspaceName.length > 0 && fixture.workspaceName.length <= 100);
  const baseline = readPrivateJson(runtime.afterOriginalUpload, root);
  assert.equal(baseline.databaseName, fixture.databaseName); assert.equal(baseline.dataVolume, fixture.dataVolume);
  assert.equal(baseline.documentId, baseline.birth.value.document_id);
  assert.equal(baseline.document.value.id, baseline.documentId);
  const container = inspectAcceptanceContainer();
  assert.equal(container.Id, runtime.containerId); assert.equal(container.Image, runtime.imageId);
  assert.equal(container.Config.Labels['org.opencontainers.image.revision'], sourceSha);
  assert.equal(container.Mounts.find(value => value.Destination === '/data')?.Name, fixture.dataVolume);
  const environment = Object.fromEntries(container.Config.Env.map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  assert.equal(environment.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.equal(environment.CANVAS_POSTGRES_MODE, 'external');
  assert(['', 'off'].includes(environment.FILE_VERSION_CENTER_MODE?.trim() ?? ''), 'Optional history must remain off.');
  assert(environment.BOOTSTRAP_ADMIN_EMAIL && environment.BOOTSTRAP_ADMIN_PASSWORD);
  const database = new URL(environment.DATABASE_URL);
  assert.equal(database.hostname, 'postgres'); assert.equal(database.username, 'canvas');
  assert.equal(database.pathname, '/' + fixture.databaseName); assert.equal(database.search, ''); assert.equal(database.hash, '');
  for (const file of requiredSources) assert.match(runtime.productSourceHashes[file] ?? '', /^[a-f0-9]{64}$/u);
  for (const [file, hash] of Object.entries(runtime.productSourceHashes)) {
    assert(!path.isAbsolute(file) && !file.split('/').includes('..') && /^(?:app\/|server\/|messages\/|package\.json$)/u.test(file));
    assert.equal(digest(fs.readFileSync(path.join(repository, file))), hash, 'Runtime source differs from the checkout.');
  }
  const actualHashes = JSON.parse(execFileSync('docker', ['exec', '-i', containerName, 'node', '-e',
    "const fs=require('fs'),c=require('crypto');const keys=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(Object.fromEntries(keys.map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))));"],
  { input: JSON.stringify(Object.keys(runtime.productSourceHashes)), encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.deepEqual(actualHashes, runtime.productSourceHashes);
  const sensitive = Object.entries(environment).filter(([name, value]) => /PASSWORD|SECRET|TOKEN|KEY/u.test(name) && value.length >= 12).map(([, value]) => value);
  return { root, sourceSha, runtime, runtimePath, fixture, fixturePath, baseline, container, environment,
    others: otherAcceptanceContainers(), sensitive, evidenceDigests: { runtime: digest(fs.readFileSync(runtimePath)), fixture: digest(fs.readFileSync(fixturePath)) } };
}

export function redactAcceptanceText(value, sensitive = []) {
  let result = value.replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]')
    .replace(/((?:__Host-|__Secure-)?better-auth\.session_token=)[^;\s"'<>\\]+/gu, '$1[redacted-session]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+/gu, '$1[redacted-bearer]');
  for (const secret of sensitive) result = result.split(secret).join('[redacted-runtime-secret]');
  return result;
}

function fileFingerprint(file) {
  assert(file.startsWith('/data/') && !file.split('/').includes('..') && !file.includes('\u0000'));
  const observed = docker(['exec', containerName, 'node', '-e',
    "const fs=require('fs'),c=require('crypto'),p=process.argv[1];const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>5000000)throw Error('Invalid protected file');const b=fs.readFileSync(fd);console.log(JSON.stringify({bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')}));}finally{fs.closeSync(fd);}", file]);
  return JSON.parse(observed);
}

/** Reads only from the verified QA database; observations confer no app authority. */
export async function withCompiledFixtureReadOnly(context, observe) {
  const connection = new URL(context.environment.DATABASE_URL);
  connection.hostname = '127.0.0.1'; connection.port = '55433';
  const database = new pg.Client({ connectionString: connection.toString(), connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c application_name=compiled-api-sdk-preservation' });
  let asynchronousError, closed = false;
  database.on('error', error => { asynchronousError ??= error; }); database.once('end', () => { closed = true; });
  try {
    await database.connect(); await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const identity = (await database.query('SELECT current_database() AS name,current_setting(\'transaction_read_only\') AS read_only')).rows[0];
    assert.equal(identity.name, context.fixture.databaseName); assert.equal(identity.read_only, 'on');
    const result = await observe(database);
    assert.equal((await database.query('SELECT pg_current_xact_id_if_assigned() IS NULL AS unassigned')).rows[0].unassigned, true);
    await database.query('ROLLBACK');
    return result;
  } finally { await database.end(); assert(closed && !asynchronousError, 'Read-only preservation connection did not close cleanly.'); }
}

/** Four known original rows/xmin and their actual files, through read-only PG. */
export async function snapshotProtectedCompiledFixture(context, output) {
  assert(path.dirname(path.resolve(output)) === context.root);
  return withCompiledFixtureReadOnly(context, async database => {
    const read = async (table, column, id) => {
      const rows = (await database.query(`SELECT row_to_json(t) AS value,xmin::text AS xmin FROM public.${table} t WHERE ${column}=$1`, [id])).rows;
      assert.equal(rows.length, 1); return rows[0];
    };
    const operationId = context.baseline.operationId, documentId = context.baseline.documentId;
    const receipt = await read('collaboration_markdown_file_import_receipts', 'operation_id', operationId);
    const birth = await read('collaboration_markdown_create_births', 'operation_id', operationId);
    const document = await read('collaboration_documents', 'id', documentId);
    const nativeState = await read('collaboration_yjs_states', 'document_id', documentId);
    assert.equal(birth.value.document_id, documentId);
    const workspaces = (await database.query('SELECT root_relative_path FROM public.canvas_workspaces WHERE id=$1', [document.value.workspace_id])).rows;
    assert.equal(workspaces.length, 1); const root = workspaces[0].root_relative_path;
    assert.equal(root, context.fixture.protectedRootRelativePath, 'Protected original workspace root changed.');
    assert(typeof root === 'string' && !path.posix.isAbsolute(root) && !root.split('/').includes('..'));
    assert(typeof document.value.path === 'string' && !path.posix.isAbsolute(document.value.path) && !document.value.path.split('/').includes('..'));
    const target = fileFingerprint(path.posix.join('/data', root, document.value.path));
    const attempt = '/data/canvas-markdown-upload-attempts/' + context.fixture.sourceAttemptDigest;
    const source = fileFingerprint(attempt + '/source.bin'), attemptRecord = fileFingerprint(attempt + '/record.json');
    const anchors = Object.fromEntries(anchorNames.map(name => [name, fileFingerprint('/data/' + name)]));
    const snapshot = { operationId, documentId, databaseName: context.fixture.databaseName, dataVolume: context.fixture.dataVolume,
      receipt, birth, document, nativeState, target, source, attemptRecord, anchors };
    assert.deepEqual(snapshot, context.baseline, 'Protected original differs from the fresh runtime baseline.');
    fs.writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return snapshot;
  });
}

/** Match only this actual registered client's consent. The returned signed
 * reference is unmodified server data; DELETE still performs real session/HMAC checks. */
export async function observeOwnedCompiledOAuthConnection(context, userId, clientId, connections) {
  assert(typeof userId === 'string' && userId.length > 0 && userId.length <= 256);
  assert(typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 256);
  assert(Array.isArray(connections) && connections.length <= 1000);
  return withCompiledFixtureReadOnly(context, async database => {
    const rows = (await database.query('SELECT id FROM public.oauth_consent WHERE user_id=$1 AND client_id=$2 LIMIT 2', [userId, clientId])).rows;
    assert(rows.length <= 1, 'Unexpected ambiguous consent identity.');
    if (!rows.length) return null;
    const matched = connections.filter(value => {
      if (typeof value.connectionId !== 'string' || value.connectionId.length > 2048) return false;
      const parts = value.connectionId.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
      try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        return payload.version === 1 && payload.userId === userId && payload.consentId === rows[0].id;
      } catch { return false; }
    });
    assert.equal(matched.length, 1, 'The actual consent has no unique current server reference.');
    return matched[0];
  });
}

export function assertCompiledAcceptanceUnchanged(context) {
  const current = inspectAcceptanceContainer();
  assert.equal(current.Id, context.container.Id); assert.equal(current.Image, context.container.Image);
  assert.deepEqual(otherAcceptanceContainers(), context.others);
  assert.equal(git('rev-parse', 'HEAD'), context.sourceSha); assert.equal(git('status', '--porcelain'), '');
  assert.equal(digest(fs.readFileSync(context.runtimePath)), context.evidenceDigests.runtime);
  assert.equal(digest(fs.readFileSync(context.fixturePath)), context.evidenceDigests.fixture);
}
