import assert from 'node:assert/strict';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type MobileNativeTlsReuseInput = Readonly<{ sourceRoot: string; expectedFingerprint256: string }>;
export type MobileNativeTlsReuseProof = Readonly<{ sourceRoot: string; sourceNonce: string; fingerprint256: string }>;
const safeFailure = 'The owned Mobile Native TLS reuse request could not be verified.';
const fingerprintPattern = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u;

async function readOwnedTlsFile(file: string, limit: number,
  proof?: { path: string; device: string; inode: string }): Promise<{ bytes: Buffer; stat: Stats }> {
  assert(path.isAbsolute(file) && await fs.realpath(file) === file);
  const before = await fs.lstat(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
    && before.uid === process.getuid?.() && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= limit);
  if (proof) assert(proof.path === file && proof.device === String(before.dev) && proof.inode === String(before.ino));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) assert(held[key] === before[key]);
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length <= limit) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    assert(length === before.size && length <= limit);
    const after = await handle.stat(), current = await fs.lstat(file);
    for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) {
      assert(after[key] === before[key] && current[key] === before[key]);
    }
    assert(!current.isSymbolicLink() && await fs.realpath(file) === file);
    return { bytes: buffer.subarray(0, length), stat: before };
  } finally { await handle.close(); }
}

export async function readMobileNativeTlsReuseInput(file: string): Promise<MobileNativeTlsReuseInput> {
  try {
    const value = JSON.parse((await readOwnedTlsFile(file, 4096)).bytes.toString('utf8')) as Record<string, unknown>;
    assert(value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === 'expectedFingerprint256,sourceRoot');
    assert(typeof value.sourceRoot === 'string' && path.isAbsolute(value.sourceRoot) && value.sourceRoot.length <= 1024);
    assert(typeof value.expectedFingerprint256 === 'string' && fingerprintPattern.test(value.expectedFingerprint256));
    return Object.freeze({ sourceRoot: value.sourceRoot, expectedFingerprint256: value.expectedFingerprint256 });
  } catch { throw new Error(safeFailure); }
}

async function validateOwnedTlsRoot(root: string): Promise<Stats> {
  assert(path.isAbsolute(root) && await fs.realpath(root) === root
    && /^canvas-agent-settings-browser-[A-Za-z0-9]{6}$/u.test(path.basename(root)));
  const stat = await fs.lstat(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  return stat;
}

function assertStoppedTlsSource(recovery: { serverPid: number | null; issuerPid?: number | null }): void {
  for (const pid of [recovery.serverPid, recovery.issuerPid]) {
    if (pid === null || pid === undefined) continue;
    assert(Number.isSafeInteger(pid) && pid > 0);
    for (const target of [pid, -pid]) {
      let absent = false;
      try { process.kill(target, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      assert(absent);
    }
  }
}

function validateNativeTlsPair(key: Buffer, certificate: Buffer, fingerprint: string): void {
  const x509 = new X509Certificate(certificate), now = Date.now();
  assert(fingerprintPattern.test(fingerprint) && x509.fingerprint256 === fingerprint);
  assert(Number.isFinite(Date.parse(x509.validFrom)) && Number.isFinite(Date.parse(x509.validTo))
    && Date.parse(x509.validFrom) <= now && Date.parse(x509.validTo) - now >= 3 * 60 * 60 * 1000);
  assert(x509.subject === 'CN=localhost' && x509.issuer === x509.subject
    && x509.subjectAltName === 'DNS:localhost, IP Address:127.0.0.1' && x509.checkIssued(x509) && x509.verify(x509.publicKey));
  const actual = createPublicKey(key).export({ type: 'spki', format: 'der' });
  assert(actual.equals(x509.publicKey.export({ type: 'spki', format: 'der' })));
}

/** This opt-in test path reuses bytes only; it never adopts a process, database or acceptance result. */
export async function reuseOwnedMobileNativeTls(input: MobileNativeTlsReuseInput, destinationRoot: string,
  repo: string): Promise<MobileNativeTlsReuseProof> {
  try {
    const sourceStat = await validateOwnedTlsRoot(input.sourceRoot), destinationStat = await validateOwnedTlsRoot(destinationRoot);
    assert(input.sourceRoot !== destinationRoot && await fs.realpath(repo) === repo);
    const recoveryPath = path.join(input.sourceRoot, 'recovery.json');
    const original = await readOwnedTlsFile(recoveryPath, 64 * 1024);
    const recovery = JSON.parse(original.bytes.toString('utf8')) as {
      version: number; nonce: string; repo: string; fixtureRoot: string; rootDevice: string; rootInode: string;
      ownerMarker: string; databaseName: string; createAcknowledged: boolean; mobileNative: boolean; phase: string;
      dataRemoved: boolean; databaseDropped: boolean; serverPid: number | null; issuerPid?: number | null;
      mcpOAuthProviderClosed: boolean; mobilePackageProviderClosed: boolean;
      tlsFiles: { key: { path: string; device: string; inode: string }; certificate: { path: string; device: string; inode: string } };
    };
    assert(recovery.version === 1 && typeof recovery.nonce === 'string' && /^[a-f0-9]{32}$/u.test(recovery.nonce) && recovery.repo === repo
      && recovery.fixtureRoot === input.sourceRoot && recovery.rootDevice === String(sourceStat.dev)
      && recovery.rootInode === String(sourceStat.ino) && typeof recovery.ownerMarker === 'string' && /^[a-f0-9]{48}$/u.test(recovery.ownerMarker)
      && recovery.databaseName === `canvas_connection_test_${recovery.nonce}` && recovery.createAcknowledged === true
      && recovery.mobileNative === true && recovery.phase === 'preserved' && recovery.dataRemoved === false
      && recovery.databaseDropped === false && recovery.mcpOAuthProviderClosed === true && recovery.mobilePackageProviderClosed === true);
    assert(recovery.serverPid === null || Number.isSafeInteger(recovery.serverPid) && recovery.serverPid > 0);
    for (const proof of [recovery.tlsFiles?.key, recovery.tlsFiles?.certificate]) {
      assert(proof && typeof proof.path === 'string' && typeof proof.device === 'string' && /^[1-9]\d*$/u.test(proof.device)
        && typeof proof.inode === 'string' && /^[1-9]\d*$/u.test(proof.inode));
    }
    assert((await readOwnedTlsFile(path.join(input.sourceRoot, '.fixture-owner'), 128)).bytes.toString('utf8') === recovery.ownerMarker);
    const native = JSON.parse((await readOwnedTlsFile(path.join(input.sourceRoot, 'native-receipt.json'), 64 * 1024)).bytes.toString('utf8')) as Record<string, unknown>;
    assert(native.version === 1 && native.nonce === recovery.nonce && native.phase === 'preserved'
      && native.closedContexts === true && native.poolsClosed === true);
    assertStoppedTlsSource(recovery);
    const key = await readOwnedTlsFile(path.join(input.sourceRoot, 'tls-key.pem'), 32 * 1024, recovery.tlsFiles.key);
    const certificate = await readOwnedTlsFile(path.join(input.sourceRoot, 'tls-cert.pem'), 16 * 1024, recovery.tlsFiles.certificate);
    validateNativeTlsPair(key.bytes, certificate.bytes, input.expectedFingerprint256);
    const currentSource = await validateOwnedTlsRoot(input.sourceRoot), currentDestination = await validateOwnedTlsRoot(destinationRoot);
    assert(currentSource.dev === sourceStat.dev && currentSource.ino === sourceStat.ino
      && currentDestination.dev === destinationStat.dev && currentDestination.ino === destinationStat.ino);
    assert((await readOwnedTlsFile(recoveryPath, 64 * 1024)).bytes.equals(original.bytes));
    assert((await readOwnedTlsFile(path.join(input.sourceRoot, 'tls-key.pem'), 32 * 1024, recovery.tlsFiles.key)).bytes.equals(key.bytes));
    assert((await readOwnedTlsFile(path.join(input.sourceRoot, 'tls-cert.pem'), 16 * 1024, recovery.tlsFiles.certificate)).bytes.equals(certificate.bytes));
    assertStoppedTlsSource(recovery);
    for (const [name, bytes] of [['tls-key.pem', key.bytes], ['tls-cert.pem', certificate.bytes]] as const) {
      const destination = path.join(destinationRoot, name);
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      assert((await readOwnedTlsFile(destination, 32 * 1024)).bytes.equals(bytes));
    }
    const finalDestination = await validateOwnedTlsRoot(destinationRoot);
    assert(finalDestination.dev === destinationStat.dev && finalDestination.ino === destinationStat.ino);
    return Object.freeze({ sourceRoot: input.sourceRoot, sourceNonce: recovery.nonce, fingerprint256: input.expectedFingerprint256 });
  } catch { throw new Error(safeFailure); }
}
