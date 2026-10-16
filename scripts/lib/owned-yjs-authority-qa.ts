/** Test-only isolation contracts. Application code must not import this module. */
import assert from 'node:assert/strict';
import { createHash, type Hash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';

export type OwnedYjsReceipt = {
  version: 1; nonce: string; fixtureRoot: string; repo: string; head: string; buildId: string;
  sourceFingerprint: string; buildFingerprint: string; ownerMarker: string; rootDevice: string; rootInode: string;
  dataRoot: string; dataDevice: string; dataInode: string; databaseName: string; databaseOid: string | null;
  databaseOwner: string | null; createAcknowledged: boolean; phase: string; actorId: string | null; uncertain: boolean;
  parentPid: number; parentStart: string; serverPid: number | null; serverStart: string | null; issuerPid: number | null;
  issuerDatabaseOid: string | null; issuerDatabaseOwner: string | null; issuerDatabaseMarker: string | null;
  restartCount: number; port: number; databaseDropped: boolean; dataRemoved: boolean;
  controlPlaneRoot: string; controlPlaneHead: string; passed: boolean;
  selectedSpecs: string[]; completedSpecs: string[]; activeSpec: string | null; failurePhase: string | null;
};
export type OwnedYjsBuildProof = { version: 1; repo: string; head: string; sourceFingerprint: string;
  buildFingerprint: string; buildId: string; createdAt: string };
export type DatabaseIdentity = { name: string; oid: string; owner: string; role: string; marker: string | null };
export type OwnedYjsBrowserReport = { version: 1; status: string; declared: number; passed: number; failed: number;
  skipped: number; timedOut: number; interrupted: number };
export function assertCompletedYjsBrowserGate(report: OwnedYjsBrowserReport): void {
  assert.equal(report.version, 1); assert.equal(report.status, 'passed');
  for (const key of ['declared', 'passed', 'failed', 'skipped', 'timedOut', 'interrupted'] as const) assert(Number.isSafeInteger(report[key]) && report[key] >= 0);
  assert(report.declared > 0 && report.passed === report.declared, 'Every selected acceptance case must actually pass.');
  assert.equal(report.failed + report.skipped + report.timedOut + report.interrupted, 0, 'Skipped or incomplete cases cannot certify acceptance.');
}
export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const buildProofName = 'yjs-authority-build-proof.json';

export async function privateBytes(filename: string, max = 64 * 1024): Promise<Buffer> {
  assert(path.isAbsolute(filename));
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    assert(held.isFile() && held.nlink === 1 && held.uid === process.getuid?.() && (held.mode & 0o777) === 0o600);
    assert(held.size <= max);
    const bytes = await handle.readFile();
    const after = await fs.lstat(filename);
    assert.equal(await fs.realpath(filename), filename);
    for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(after[key], held[key]);
    assert.equal(bytes.length, held.size);
    return bytes;
  } finally { await handle.close(); }
}

export async function writePrivateJson(filename: string, value: unknown, exclusive = false): Promise<void> {
  if (exclusive) { await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); return; }
  await privateBytes(filename);
  const temp = `${filename}.writing`;
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, filename);
}

export function assertOrigin(value: string, port?: number): URL {
  const url = new URL(value);
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash);
  const actual = Number(url.port);
  assert(Number.isInteger(actual) && actual >= 1024 && actual <= 65535);
  assert(![3000, 3100, 4001, 4004, 55433, 55434].includes(actual), 'A shared/foreign service port cannot be adopted.');
  if (port !== undefined) assert.equal(actual, port);
  return url;
}

export function assertDatabaseOwnership(receipt: OwnedYjsReceipt, identity: DatabaseIdentity): void {
  assert(receipt.createAcknowledged && /^canvas_yjs_e2e_[a-f0-9]{32}$/u.test(receipt.databaseName));
  assert.equal(receipt.databaseName, `canvas_yjs_e2e_${receipt.nonce}`);
  assert(receipt.databaseOid && /^\d+$/u.test(receipt.databaseOid));
  assert.equal(identity.name, receipt.databaseName); assert.equal(identity.oid, receipt.databaseOid);
  assert.equal(identity.owner, receipt.databaseOwner); assert.equal(identity.role, receipt.databaseOwner);
  assert.equal(identity.marker, receipt.ownerMarker);
}

export async function assertOwnedRoot(receipt: OwnedYjsReceipt): Promise<void> {
  assert.equal(receipt.version, 1); assert.match(receipt.nonce, /^[a-f0-9]{32}$/u); assert.match(receipt.ownerMarker, /^[a-f0-9]{48}$/u);
  const root = await fs.lstat(receipt.fixtureRoot);
  assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(receipt.fixtureRoot), receipt.fixtureRoot);
  assert.equal(String(root.dev), receipt.rootDevice); assert.equal(String(root.ino), receipt.rootInode);
  assert.equal((await privateBytes(path.join(receipt.fixtureRoot, '.fixture-owner'))).toString(), receipt.ownerMarker);
  assert.equal(receipt.dataRoot, path.join(receipt.fixtureRoot, 'data'));
  const data = await fs.lstat(receipt.dataRoot);
  assert(data.isDirectory() && !data.isSymbolicLink() && data.uid === root.uid && (data.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(receipt.dataRoot), receipt.dataRoot);
  assert.equal(String(data.dev), receipt.dataDevice); assert.equal(String(data.ino), receipt.dataInode);
}

const fingerprintWindow = 8;
const fingerprintChunkBytes = 64 * 1024;
type FingerprintEntry = { prefix: string; filename?: string };
type FingerprintRead = { entry: FingerprintEntry; handle?: FileHandle; buffer?: Buffer; bytesRead?: number };
type FingerprintResult = { ok: true; value: FingerprintRead } | { ok: false; error: unknown; cleanupFailed?: true };

/** Prefetch only one small batch; consume metadata and its errors in the original order. */
async function* orderedFingerprintStats(directory: string, names: string[], beforeRead?: () => void) {
  for (let offset = 0; offset < names.length; offset += fingerprintWindow) {
    const pending = names.slice(offset, offset + fingerprintWindow).map(async name => {
      const filename = path.join(directory, name);
      try { return { ok: true as const, name, filename, stat: await fs.lstat(filename) }; }
      catch (error) { return { ok: false as const, error }; }
    });
    // Finish this batch before descending, so nested directories cannot multiply live metadata reads.
    const results = await Promise.all(pending);
    try {
      for (const result of results) {
        beforeRead?.();
        if (!result.ok) throw result.error;
        yield result;
      }
    } finally { await Promise.all(pending); }
  }
}

async function closeFingerprintHandle(handle: FileHandle): Promise<void> {
  try { await handle.close(); }
  catch (error) {
    // A failed close is still an error; make one bounded retry before releasing the read window.
    try { await handle.close(); }
    catch (retryError) { throw new AggregateError([error, retryError], 'Fingerprint close and retry failed.'); }
    throw error;
  }
}

async function prepareFingerprintRead(entry: FingerprintEntry): Promise<FingerprintResult> {
  let handle: FileHandle | undefined;
  try {
    if (!entry.filename) return { ok: true, value: { entry } };
    handle = await fs.open(entry.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    assert((await handle.stat()).isFile());
    const buffer = Buffer.allocUnsafe(fingerprintChunkBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    return { ok: true, value: { entry, handle, buffer, bytesRead } };
  } catch (error) {
    if (handle) {
      try { await closeFingerprintHandle(handle); }
      catch (closeError) { return { ok: false, cleanupFailed: true, error: new AggregateError([error, closeError], 'Fingerprint read and close failed.') }; }
    }
    return { ok: false, error };
  }
}

/** Hash the exact ordered bytes, with at most eight open files and eight 64 KiB buffers. */
async function hashFingerprintEntries(digest: Hash, entries: AsyncIterable<FingerprintEntry>): Promise<void> {
  const iterator = entries[Symbol.asyncIterator]();
  const pending: Array<Promise<FingerprintResult>> = [];
  let ended = false, failed = false, primaryError: unknown;
  const fill = async () => {
    while (!ended && pending.length < fingerprintWindow) {
      const next = await iterator.next();
      if (next.done) ended = true;
      else pending.push(prepareFingerprintRead(next.value));
    }
  };
  try {
    await fill();
    while (pending.length) {
      const result = await pending.shift()!;
      if (!result.ok) throw result.error;
      const { entry, handle, buffer } = result.value;
      let readFailed = false, readError: unknown;
      try {
        digest.update(entry.prefix);
        if (handle && buffer) {
          let bytesRead = result.value.bytesRead!;
          while (bytesRead) {
            digest.update(buffer.subarray(0, bytesRead));
            ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null));
          }
          digest.update('\0');
        }
      } catch (error) { readFailed = true; readError = error; throw error; }
      finally {
        if (handle) {
          try { await closeFingerprintHandle(handle); }
          catch (closeError) { throw readFailed ? new AggregateError([readError, closeError], 'Fingerprint read and close failed.') : closeError; }
        }
      }
      await fill();
    }
  } catch (error) { failed = true; primaryError = error; throw error; }
  finally {
    const cleanup = await Promise.allSettled([
      ...pending.map(async read => {
        const result = await read;
        if (result.ok && result.value.handle) await closeFingerprintHandle(result.value.handle);
        else if (!result.ok && result.cleanupFailed) throw result.error;
      }),
      iterator.return?.(),
    ]);
    const errors = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(failed ? [primaryError, ...errors] : errors, 'Fingerprint cleanup failed.');
  }
}

export async function sourceFingerprint(repo: string): Promise<{ head: string; fingerprint: string }> {
  assert.equal(await fs.realpath(repo), repo);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.match(head, /^[a-f0-9]{40}$/u);
  const names = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], { cwd: repo }).toString().split('\0')
    .filter(name => /^(?:app|components|server|scripts|tests|packages|i18n|messages|public)\//u.test(name)
      || name === 'tools/native-fs/fd-publication.c'
      || /^(?:package(?:-lock)?\.json|tsconfig\.json|next\.config\.[cm]?[jt]s|server\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s)$/u.test(name));
  const digest = createHash('sha256').update(head);
  async function* entries(): AsyncGenerator<FingerprintEntry> {
    for await (const { name, filename, stat } of orderedFingerprintStats(repo, [...new Set(names)].sort())) {
      assert(stat.isFile() && !stat.isSymbolicLink(), `Build source must be a regular file (${name}).`);
      yield { prefix: `${name}\0`, filename };
    }
  }
  await hashFingerprintEntries(digest, entries());
  return { head, fingerprint: digest.digest('hex') };
}

const nativeDescriptorSource = 'tools/native-fs/fd-publication.c';
const nativeDescriptorMaxBytes = 2 * 1024 * 1024;

async function nativeFingerprintFile(repo: string, relative: string): Promise<Buffer> {
  const parts = relative.split('/');
  const parents: Array<{ directory: string; info: Awaited<ReturnType<typeof fs.lstat>> }> = [];
  assert.equal(await fs.realpath(repo), repo);
  for (let count = 1; count < parts.length; count++) {
    const directory = path.join(repo, ...parts.slice(0, count)), info = await fs.lstat(directory);
    assert(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o022), 'Unsafe native artifact parent.');
    assert.equal(await fs.realpath(directory), directory);
    parents.push({ directory, info });
  }
  const filename = path.join(repo, relative);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    assert(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= nativeDescriptorMaxBytes
      && !(before.mode & 0o022), 'Unsafe native artifact file.');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      assert(bytesRead > 0, 'Native artifact changed during read.'); offset += bytesRead;
    }
    const after = await handle.stat(), named = await fs.lstat(filename);
    for (const observed of [after, named]) {
      assert(observed.isFile() && !observed.isSymbolicLink());
      for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(observed[key], before[key]);
    }
    assert.equal(await fs.realpath(filename), filename);
    for (const { directory, info } of parents) {
      const current = await fs.lstat(directory);
      assert(current.isDirectory() && !current.isSymbolicLink());
      for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'] as const) assert.equal(current[key], info[key]);
      assert.equal(await fs.realpath(directory), directory);
    }
    return bytes;
  } finally { await handle.close(); }
}

async function appendNativeDescriptorFingerprint(repo: string, digest: Hash): Promise<void> {
  try { await fs.lstat(path.join(repo, nativeDescriptorSource)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Existing synthetic build fixtures without this backend retain their original digest.
    // A deleted tracked production source must never turn the native binding off.
    let tracked = '';
    try { tracked = execFileSync('git', ['ls-files', '--cached', '-z', '--', nativeDescriptorSource],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (gitError) { if ((gitError as { status?: number }).status !== 128) throw gitError; }
    assert(!tracked, 'The tracked native descriptor source is missing.');
    return;
  }
  const source = await nativeFingerprintFile(repo, nativeDescriptorSource);
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    digest.update(`native-descriptor-unsupported\0${process.platform}\0${process.arch}\0`); return;
  }
  const directory = `native/fd-publication/${process.platform}-${process.arch}`;
  const names = ['manifest.json', 'source.c', 'fd-publication.node'] as const;
  const artifacts: Buffer[] = [];
  for (const name of names) artifacts.push(await nativeFingerprintFile(repo, `${directory}/${name}`));
  const [manifestBytes, packagedSource, binary] = artifacts;
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  const keys = ['version', 'apiVersion', 'napiVersion', 'platform', 'arch', 'sourceSha256', 'binarySha256', 'nodeVersion', 'compiler'];
  assert(manifest && Object.getPrototypeOf(manifest) === Object.prototype);
  assert.deepEqual(Object.keys(manifest), keys);
  assert.equal(JSON.stringify(manifest, null, 2) + '\n', manifestBytes.toString('utf8'));
  assert.equal(manifest.version, 1); assert.equal(manifest.apiVersion, 2); assert.equal(manifest.napiVersion, 8);
  assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch);
  assert.equal(typeof manifest.nodeVersion, 'string'); assert.equal(typeof manifest.compiler, 'string');
  assert.equal(manifest.sourceSha256, hash(source)); assert.equal(manifest.sourceSha256, hash(packagedSource));
  assert.equal(manifest.binarySha256, hash(binary));
  for (let index = 0; index < names.length; index++) {
    digest.update(`native-artifact\0${directory}/${names[index]}\0${artifacts[index].length}\0`).update(artifacts[index]).update('\0');
  }
}

export async function buildFingerprint(repo: string): Promise<{ buildId: string; fingerprint: string }> {
  const root = path.join(repo, '.next'), digest = createHash('sha256');
  const stat = await fs.lstat(root); assert(stat.isDirectory() && !stat.isSymbolicLink());
  const buildId = (await fs.readFile(path.join(root, 'BUILD_ID'), 'utf8')).trim(); assert(buildId && buildId.length < 256);
  let visited = 0;
  async function* visit(directory: string, logical = '', linkedPackage = false): AsyncGenerator<FingerprintEntry> {
    const names = (await fs.readdir(directory)).sort().filter(name => {
      const relative = path.posix.join(logical, name);
      if (!linkedPackage && (relative === 'cache' || relative.startsWith('cache/') || name === buildProofName || name === `${buildProofName}.writing`
        || /^trace(?:-|$)/u.test(name))) return false;
      return true;
    });
    for await (const { name, filename: file, stat: current } of orderedFingerprintStats(directory, names, () => { assert(++visited < 100_000); })) {
      const relative = path.posix.join(logical, name);
      if (current.isSymbolicLink()) {
        // Turbopack external packages use these exact aliases. Bind both their
        // canonical link text and all target bytes; never skip or follow arbitrary links.
        const alias = !linkedPackage && relative.match(/^node_modules\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)-[a-f0-9]{16}$/u);
        assert(alias, 'Unexpected compiled artifact symlink.');
        const dependencies = path.join(repo, 'node_modules'), target = path.join(dependencies, alias[1]);
        const dependencyStat = await fs.lstat(dependencies), targetStat = await fs.lstat(target);
        assert(dependencyStat.isDirectory() && !dependencyStat.isSymbolicLink());
        assert(targetStat.isDirectory() && !targetStat.isSymbolicLink());
        assert.equal(await fs.realpath(dependencies), dependencies); assert.equal(await fs.realpath(target), target);
        const link = await fs.readlink(file);
        assert.equal(link, path.relative(path.dirname(file), target));
        const manifest = path.join(target, 'package.json'), manifestStat = await fs.lstat(manifest);
        assert(manifestStat.isFile() && !manifestStat.isSymbolicLink());
        assert.equal(JSON.parse(await fs.readFile(manifest, 'utf8')).name, alias[1]);
        yield { prefix: `link\0${relative}\0${link}\0${alias[1]}\0` };
        yield* visit(target, relative, true);
      } else if (current.isDirectory()) yield* visit(file, relative, linkedPackage);
      else if (linkedPackage || /\.(?:[cm]?js|json|map|wasm|node)$/u.test(name) || relative === 'BUILD_ID') {
        assert(current.isFile()); yield { prefix: `${relative}\0`, filename: file };
      }
    }
  }
  await hashFingerprintEntries(digest, visit(root));
  await appendNativeDescriptorFingerprint(repo, digest);
  return { buildId, fingerprint: digest.digest('hex') };
}

export async function assertBuildProof(repo: string): Promise<OwnedYjsBuildProof> {
  const proof = JSON.parse((await privateBytes(path.join(repo, '.next', buildProofName))).toString()) as OwnedYjsBuildProof;
  const source = await sourceFingerprint(repo), built = await buildFingerprint(repo);
  assert.equal(proof.version, 1); assert.equal(proof.repo, repo); assert.equal(proof.head, source.head);
  assert.equal(proof.sourceFingerprint, source.fingerprint, 'Sources changed after the successful production build.');
  assert.equal(proof.buildFingerprint, built.fingerprint, 'Compiled application artifacts changed after the build.');
  assert.equal(proof.buildId, built.buildId);
  return proof;
}

export function redactBoundedOutput(raw: string, secrets: string[], maxBytes = 1024 * 1024): string {
  let text = secrets.filter(Boolean).sort((a, b) => b.length - a.length).reduce((value, secret) => value.replaceAll(secret, '[redacted]'), raw)
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[redacted-postgres-url]')
    .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted-jwt]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[redacted-private-key]')
    .replace(/((?:password|secret|token|authorization|cookie|code_verifier)\s*[=:]\s*)[^\r\n]+/giu, '$1[redacted]')
    .replace(/((?:https?:\/\/)[^\s?#"'<>]+)[?#][^\s"'<>]*/gu, '$1?[redacted]');
  if (Buffer.byteLength(text) > maxBytes) {
    text = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
    text = text.slice(0, Math.max(0, text.lastIndexOf('\n'))) + '\n[bounded output truncated]\n';
  }
  return text;
}

/** Read-only guard used before a selected browser suite contacts the owned host. */
export async function requireOwnedYjsQaTarget(env: NodeJS.ProcessEnv = process.env): Promise<OwnedYjsReceipt> {
  assert.equal(env.CANVAS_YJS_AUTHORITY_E2E, '1'); assert.equal(env.E2E_EXTERNAL_SERVER, '1'); assert.equal(env.NODE_ENV, 'production');
  const receiptPath = env.CANVAS_YJS_QA_RECEIPT ?? '';
  const receipt = JSON.parse((await privateBytes(receiptPath)).toString()) as OwnedYjsReceipt;
  assert.equal(receiptPath, path.join(receipt.fixtureRoot, 'recovery.json')); await assertOwnedRoot(receipt);
  const outputRoot = env.CANVAS_YJS_QA_RESULTS ?? '', relativeOutput = path.relative(path.join(receipt.fixtureRoot, 'results'), outputRoot);
  assert(path.isAbsolute(outputRoot) && !path.isAbsolute(relativeOutput) && !relativeOutput.split(path.sep).includes('..'));
  assert.equal(await fs.realpath(outputRoot), outputRoot);
  const outputStat = await fs.lstat(outputRoot);
  assert(outputStat.isDirectory() && !outputStat.isSymbolicLink() && outputStat.uid === process.getuid?.() && (outputStat.mode & 0o777) === 0o700);
  assert.equal(receipt.repo, await fs.realpath(process.cwd()));
  const proof = await assertBuildProof(receipt.repo);
  assert.equal(receipt.head, proof.head); assert.equal(receipt.sourceFingerprint, proof.sourceFingerprint); assert.equal(receipt.buildFingerprint, proof.buildFingerprint);
  const published = parse(await privateBytes(path.join(receipt.fixtureRoot, 'runtime.env')));
  const origin = assertOrigin(env.BASE_URL ?? '', receipt.port);
  for (const key of ['BASE_URL', 'BETTER_AUTH_BASE_URL', 'DATABASE_URL', 'DATA', 'CANVAS_DATA_ROOT', 'CANVAS_INSTANCE_ID', 'CANVAS_ORGANIZATION_ID',
    'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD', 'TEST_LOGIN_EMAIL', 'TEST_LOGIN_PASSWORD', 'TEST_SECONDARY_EMAIL', 'TEST_SECONDARY_PASSWORD',
    'CANVAS_YJS_QA_RESTART_URL', 'CANVAS_YJS_QA_RESTART_TOKEN']) {
    assert(env[key] && env[key] === published[key], `Owned runtime configuration mismatch (${key}).`);
  }
  assert.equal(env.TEST_LOGIN_EMAIL, env.BOOTSTRAP_ADMIN_EMAIL); assert.equal(env.TEST_LOGIN_PASSWORD, env.BOOTSTRAP_ADMIN_PASSWORD);
  assert.notEqual(env.TEST_LOGIN_EMAIL, env.TEST_SECONDARY_EMAIL);
  assert.equal(origin.origin, published.BASE_URL); assert.equal(env.DATA, receipt.dataRoot);
  assert.equal(env.CANVAS_DATABASE_PROVIDER, 'postgres'); assert.equal(env.CANVAS_POSTGRES_MODE, 'external');
  assert.equal(env.CANVAS_DEPLOYMENT_MODE, 'team'); assert.equal(env.CANVAS_TEAM_FEATURES_ENABLED, 'true');
  const url = new URL(published.DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === '55433' && !url.search && !url.hash);
  assert.equal(url.pathname, `/${receipt.databaseName}`);
  const database = new Client({ connectionString: url.href, connectionTimeoutMillis: 5_000, statement_timeout: 10_000, query_timeout: 10_000 });
  try {
    await database.connect(); await database.query('BEGIN READ ONLY');
    const identity = (await database.query(`SELECT current_database() AS name,d.oid::text,pg_get_userbyid(d.datdba) AS owner,
      current_user AS role,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0] as DatabaseIdentity;
    assertDatabaseOwnership(receipt, identity);
  } finally { await database.end(); }
  assert(receipt.serverPid && receipt.serverStart && receipt.phase === 'browser' && !receipt.uncertain);
  assert.equal(execFileSync('ps', ['-p', String(receipt.parentPid), '-o', 'lstart='], { encoding: 'utf8' }).trim(), receipt.parentStart);
  const started = execFileSync('ps', ['-p', String(receipt.serverPid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  assert.equal(started, receipt.serverStart);
  const listeners = execFileSync('lsof', ['-nP', '-a', '-p', String(receipt.serverPid), '-iTCP:' + receipt.port, '-sTCP:LISTEN', '-Ftn'], { encoding: 'utf8' });
  assert(listeners.split('\n').includes(`n127.0.0.1:${receipt.port}`));
  const cwd = execFileSync('lsof', ['-a', '-p', String(receipt.serverPid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  assert(cwd.split('\n').includes(`n${receipt.repo}`));
  return receipt;
}
