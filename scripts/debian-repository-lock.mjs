import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchVerified } from './debian-package-fetch.mjs';

export const mirrorDirectory = '/usr/local/share/canvas-debian-snapshot';

export function mirrorRepository(repository, directory = mirrorDirectory) {
  const archive = repository.suite === 'bookworm-security' ? 'debian-security' : 'debian';
  return { ...repository, uri: `file://${path.resolve(directory)}/${archive}` };
}

export function releaseIndexes(release, algorithm = 'SHA256') {
  const section = release.match(new RegExp(`^${algorithm}:\\n((?:[ \\t]+[^\\n]+\\n)+)`, 'mu'))?.[1];
  assert(section, `Missing ${algorithm} metadata`);
  return new Map(section.trim().split('\n').map(line => {
    const [hash, size, filename] = line.trim().split(/\s+/u);
    assert.match(hash, algorithm === 'SHA256' ? /^[a-f0-9]{64}$/u : /^[a-f0-9]{40}$/u);
    assert.match(size, /^\d+$/u);
    return [filename, { hash, size: Number(size) }];
  }));
}

export function verifyRelease(repository, bytes, now = Date.now()) {
  const release = bytes.toString('utf8');
  assert(release.startsWith('-----BEGIN PGP SIGNED MESSAGE-----\n'), 'APT must retain signed InRelease metadata');
  const hashes = releaseIndexes(release);
  for (const [filename, expected] of Object.entries(repository.indexSha256)) {
    assert.equal(hashes.get(filename)?.hash, expected, `Debian repository changed: ${repository.suite}/${filename}; review the repository lock before building`);
  }
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), repository.inRelease.sha256, 'InRelease SHA256 differs from the frozen lock');
  assert.equal(bytes.length, repository.inRelease.size, 'InRelease size differs from the frozen lock');
  const date = Date.parse(release.match(/^Date: (.+)$/mu)?.[1]);
  assert(Number.isFinite(date) && date <= now + 10_000, 'InRelease Date is invalid or in the future');
  const expiry = release.match(/^Valid-Until: (.+)$/mu)?.[1];
  if (expiry) assert(Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) >= now, 'InRelease has expired');
  return hashes;
}

export function indexDownloadUrls(repository, filename) {
  const hash = repository.indexSha256[filename];
  assert.match(hash ?? '', /^[a-f0-9]{64}$/u);
  assert.match(repository.indexFileSha1[filename] ?? '', /^[a-f0-9]{40}$/u);
  assert(/^main\/(?:binary-(?:amd64|arm64)\/Packages|source\/Sources)\.xz$/u.test(filename));
  const archive = repository.suite === 'bookworm-security' ? 'debian-security' : 'debian';
  const byHash = `dists/${repository.suite}/${path.posix.dirname(filename)}/by-hash/SHA256/${hash}`;
  return [
    `https://deb.debian.org/${archive}/${byHash}`,
    `https://snapshot.debian.org/file/${repository.indexFileSha1[filename]}/${path.basename(filename)}`,
    `${repository.uri}/${byHash}`,
    `${repository.uri}/dists/${repository.suite}/${filename}`,
  ];
}

export async function prepareMirror(lock, directory = mirrorDirectory) {
  for (const repository of lockedRepositories(lock)) {
    const local = mirrorRepository(repository, directory);
    const suiteDirectory = fileURLToPath(`${local.uri}/dists/${repository.suite}/`);
    const releaseFile = path.join(suiteDirectory, 'InRelease');
    await fetchVerified({ urls: [`https://snapshot.debian.org/file/${repository.inRelease.fileSha1}/InRelease`, `${repository.uri}/dists/${repository.suite}/InRelease`], destination: releaseFile, ...repository.inRelease });
    const bytes = fs.readFileSync(releaseFile);
    const hashes = verifyRelease(repository, bytes);
    for (const filename of Object.keys(repository.indexSha256).filter(name => name.endsWith('.xz'))) {
      const entry = hashes.get(filename);
      const destination = path.join(suiteDirectory, filename);
      await fetchVerified({ urls: indexDownloadUrls(repository, filename), destination, sha256: entry.hash, size: entry.size });
      const byHash = path.join(path.dirname(destination), 'by-hash/SHA256', entry.hash);
      fs.mkdirSync(path.dirname(byHash), { recursive: true });
      if (!fs.existsSync(byHash)) fs.linkSync(destination, byHash);
    }
  }
}

function lockedRepositories(lock) {
  assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(lock.repositories.map(repository => repository.suite),
    ['bookworm', 'bookworm-updates', 'bookworm-security']);
  const cutoffs = new Set();
  for (const repository of lock.repositories) {
    const match = /^https:\/\/snapshot\.debian\.org\/archive\/(debian(?:-security)?)\/(\d{8}(?:T\d{6}Z)?)$/u.exec(repository.uri);
    assert(match, 'Repository must use an exact official Debian snapshot cutoff');
    assert.equal(match[1], repository.suite === 'bookworm-security' ? 'debian-security' : 'debian');
    const cutoff = match[2];
    const date = `${cutoff.slice(0, 4)}-${cutoff.slice(4, 6)}-${cutoff.slice(6, 8)}`;
    const time = cutoff.length === 8 ? '00:00:00' : `${cutoff.slice(9, 11)}:${cutoff.slice(11, 13)}:${cutoff.slice(13, 15)}`;
    const timestamp = new Date(`${date}T${time}Z`);
    assert.equal(timestamp.toISOString(), `${date}T${time}.000Z`, 'Snapshot cutoff must be a valid UTC date');
    assert(timestamp.getTime() <= Date.now(), 'Snapshot cutoff must not be in the future');
    cutoffs.add(cutoff);
  }
  assert.equal(cutoffs.size, 1, 'All repository suites must share one frozen cutoff');
  return lock.repositories;
}

export function repositoryReleaseFilename(repository) {
  const uri = new URL(repository.uri);
  return `${uri.host}${uri.pathname}/dists/${repository.suite}/InRelease`.replaceAll('/', '_');
}

export function verifyRepositoryLists(lock, listsDirectory, { mirror = false } = {}) {
  for (const repository of lockedRepositories(lock)) {
    for (const required of ['main/binary-amd64/Packages', 'main/binary-arm64/Packages', 'main/source/Sources']) {
      assert.match(repository.indexSha256[required] || '', /^[a-f0-9]{64}$/u);
    }
    const source = mirror ? mirrorRepository(repository) : repository;
    verifyRelease(repository, fs.readFileSync(path.join(listsDirectory, repositoryReleaseFilename(source))));
  }
}

export function configureRepositories(lock, aptDirectory, { mirror = false } = {}) {
  const sources = lockedRepositories(lock).map(repository => {
    const source = mirror ? mirrorRepository(repository) : repository;
    return `Types: deb deb-src\nURIs: ${source.uri}\nSuites: ${repository.suite}\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n`;
  }).join('\n');
  fs.writeFileSync(path.join(aptDirectory, 'sources.list.d/debian.sources'), sources);
  fs.rmSync(path.join(aptDirectory, 'sources.list'), { force: true });
  fs.writeFileSync(path.join(aptDirectory, 'apt.conf.d/99canvas-repository-lock'),
    'Acquire::Retries "2";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAPT::Update::Error-Mode "any";\n'
    + 'Acquire::CompressionTypes::Order { "xz"; };\n'
    + `APT::Update::Post-Invoke-Success { "/usr/local/bin/node /usr/local/libexec/canvas-debian/debian-repository-lock.mjs ${mirror ? 'verify-frozen' : 'verify'}"; };\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const lock = JSON.parse(fs.readFileSync('/usr/local/share/canvas-debian-repository-lock.json', 'utf8'));
  if (process.argv[2] === 'prepare') {
    await prepareMirror(lock);
    configureRepositories(lock, '/etc/apt', { mirror: true });
  }
  else if (process.argv[2] === 'configure') configureRepositories(lock, '/etc/apt');
  else {
    assert(['verify', 'verify-frozen'].includes(process.argv[2]));
    verifyRepositoryLists(lock, '/var/lib/apt/lists', { mirror: process.argv[2] === 'verify-frozen' });
  }
}
