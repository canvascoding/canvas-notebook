import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { readMobileNativeTlsReuseInput, reuseOwnedMobileNativeTls } from './helpers/mobile-native-tls-reuse';

async function createTlsSource(repo: string): Promise<{ root: string; fingerprint: string; expiresAt: number; recovery: Record<string, unknown> }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-settings-browser-')));
  await fs.chmod(root, 0o700);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(root, 'tls-key.pem'),
    '-out', path.join(root, 'tls-cert.pem')], { timeout: 15_000, stdio: 'ignore' });
  const rootStat = await fs.lstat(root), nonce = randomBytes(16).toString('hex'), ownerMarker = randomBytes(24).toString('hex');
  const tlsFiles: Record<string, unknown> = {};
  for (const [name, file] of [['key', 'tls-key.pem'], ['certificate', 'tls-cert.pem']]) {
    const absolute = path.join(root, file); await fs.chmod(absolute, 0o600); const stat = await fs.lstat(absolute);
    tlsFiles[name] = { path: absolute, device: String(stat.dev), inode: String(stat.ino) };
  }
  const recovery = { version: 1, nonce, repo, fixtureRoot: root, rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino),
    ownerMarker, databaseName: `canvas_connection_test_${nonce}`, createAcknowledged: true, mobileNative: true,
    phase: 'preserved', dataRemoved: false, databaseDropped: false, serverPid: null, issuerPid: null,
    mcpOAuthProviderClosed: true, mobilePackageProviderClosed: true, tlsFiles };
  await fs.writeFile(path.join(root, '.fixture-owner'), ownerMarker, { mode: 0o600 });
  await fs.writeFile(path.join(root, 'recovery.json'), JSON.stringify(recovery), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'native-receipt.json'), JSON.stringify({ version: 1, nonce, phase: 'preserved', closedContexts: true, poolsClosed: true }), { mode: 0o600 });
  const certificate = new X509Certificate(await fs.readFile(path.join(root, 'tls-cert.pem')));
  return { root, fingerprint: certificate.fingerprint256, expiresAt: Date.parse(certificate.validTo), recovery };
}

async function main(): Promise<void> {
  const repo = await fs.realpath(process.cwd()), source = await createTlsSource(repo);
  const destinations: string[] = [];
  const inputFile = path.join(source.root, 'reuse-input.json');
  const input = { sourceRoot: source.root, expectedFingerprint256: source.fingerprint };
  const sourceKey = await fs.readFile(path.join(source.root, 'tls-key.pem'));
  const sourceCert = await fs.readFile(path.join(source.root, 'tls-cert.pem'));
  try {
    await fs.writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
    assert.deepEqual(await readMobileNativeTlsReuseInput(inputFile), input);
    const destination = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-settings-browser-')));
    await fs.chmod(destination, 0o700); destinations.push(destination);
    const proof = await reuseOwnedMobileNativeTls(await readMobileNativeTlsReuseInput(inputFile), destination, repo);
    assert.equal(proof.fingerprint256, source.fingerprint); assert.equal(proof.sourceNonce, source.recovery.nonce);
    for (const [name, original] of [['tls-key.pem', sourceKey], ['tls-cert.pem', sourceCert]] as const) {
      const file = path.join(destination, name), stat = await fs.lstat(file);
      assert((await fs.readFile(file)).equals(original)); assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(stat.uid, process.getuid?.()); assert.equal(stat.nlink, 1);
      assert.notEqual(stat.ino, (await fs.lstat(path.join(source.root, name))).ino);
    }
    await assert.rejects(reuseOwnedMobileNativeTls(input, destination, repo));
    assert((await fs.readFile(path.join(destination, 'tls-key.pem'))).equals(sourceKey));
    console.log('mobile-native-tls-reuse: exact issued pair copied privately, no overwrite PASS');

    const invalidDestination = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-settings-browser-')));
    await fs.chmod(invalidDestination, 0o700); destinations.push(invalidDestination);
    const wrongFingerprint = `${source.fingerprint.startsWith('00') ? '01' : '00'}${source.fingerprint.slice(2)}`;
    await assert.rejects(reuseOwnedMobileNativeTls({ ...input, expectedFingerprint256: wrongFingerprint }, invalidDestination, repo));
    const unrelated = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    await fs.writeFile(path.join(source.root, 'tls-key.pem'), unrelated);
    await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo));
    await fs.writeFile(path.join(source.root, 'tls-key.pem'), sourceKey);
    mock.timers.enable({ apis: ['Date'], now: source.expiresAt - 2 * 60 * 60 * 1000 });
    try { await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo)); }
    finally { mock.timers.reset(); }
    mock.timers.enable({ apis: ['Date'], now: source.expiresAt + 1 });
    try { await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo)); }
    finally { mock.timers.reset(); }
    await fs.writeFile(path.join(source.root, 'recovery.json'), JSON.stringify({ ...source.recovery, serverPid: process.pid }));
    await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo));
    await fs.writeFile(path.join(source.root, 'recovery.json'), JSON.stringify({ ...source.recovery, repo: path.dirname(repo) }));
    await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo));
    await fs.writeFile(path.join(source.root, 'recovery.json'), JSON.stringify(source.recovery));
    await fs.writeFile(path.join(source.root, '.fixture-owner'), 'changed-marker');
    await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo));
    await fs.writeFile(path.join(source.root, '.fixture-owner'), String(source.recovery.ownerMarker));
    const changedProof = structuredClone(source.recovery);
    (changedProof.tlsFiles as { certificate: { inode: string } }).certificate.inode = '0';
    await fs.writeFile(path.join(source.root, 'recovery.json'), JSON.stringify(changedProof));
    await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo));
    await fs.writeFile(path.join(source.root, 'recovery.json'), JSON.stringify({ ...source.recovery, tlsFiles: {} }));
    await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo));
    await fs.writeFile(path.join(source.root, 'recovery.json'), JSON.stringify({ ...source.recovery, serverPid: undefined }));
    await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo));
    await fs.writeFile(path.join(source.root, 'recovery.json'), JSON.stringify(source.recovery));
    const keyPath = path.join(source.root, 'tls-key.pem'), savedKeyPath = path.join(source.root, 'saved-key.pem');
    await fs.rename(keyPath, savedKeyPath); await fs.symlink(savedKeyPath, keyPath);
    await assert.rejects(reuseOwnedMobileNativeTls(input, invalidDestination, repo));
    assert.deepEqual(await fs.readdir(invalidDestination), [], 'Rejected reuse must not generate fallback TLS files.');
    console.log('mobile-native-tls-reuse: fingerprint/key/expiry/remaining lifetime/symlink/ownership/stopped/proof failures, no fallback PASS');

    await fs.writeFile(inputFile, JSON.stringify({ ...input, extra: true }));
    await assert.rejects(readMobileNativeTlsReuseInput(inputFile));
    await fs.writeFile(inputFile, JSON.stringify(input)); await fs.chmod(inputFile, 0o644);
    await assert.rejects(readMobileNativeTlsReuseInput(inputFile)); await fs.chmod(inputFile, 0o600);
    const linkedInput = path.join(source.root, 'linked-input.json'); await fs.symlink(inputFile, linkedInput);
    await assert.rejects(readMobileNativeTlsReuseInput(linkedInput));
    const runner = spawnSync(process.execPath, ['scripts/agent-settings-tools-browser-runner.cjs', 'run-workflow-oauth', inputFile],
      { cwd: repo, env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(runner.status, 1); assert.match(runner.stderr, /Choose a fixed isolated acceptance command/u);
    console.log('mobile-native-tls-reuse: bounded private closed input and MobileNative-only launcher option PASS');
  } finally {
    mock.timers.reset();
    for (const directory of destinations) await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(source.root, { recursive: true, force: true });
  }
}

main().catch(() => { console.error('mobile-native-tls-reuse: isolated regression failed.'); process.exitCode = 1; });
