import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRepositoryLists } from './debian-repository-lock.mjs';
import { fetchVerified } from './debian-package-fetch.mjs';

// Versions and SHA-256 come exclusively from APT's signed, locked snapshot lists.
// The live mirror is an artifact transport, never a package-resolution source.
export function lockedDebianDownloads(output, lock) {
  const downloads = [];
  for (const line of output.split('\n').filter(line => line.startsWith("'"))) {
    const match = /^'(https:\/\/[^']+)' ([a-zA-Z0-9_.+~:%-]+\.deb) (\d+) SHA256:([a-f0-9]{64})$/u.exec(line);
    assert(match, 'APT must provide a canonical package filename, size and SHA256');
    const [, uri, filename, length, sha256] = match;
    const url = new URL(uri);
    assert(!url.username && !url.password && !url.port && !url.search && !url.hash);
    const repository = lock.repositories.find(entry => uri.startsWith(entry.uri + '/pool/'));
    assert(repository && /^https:\/\/snapshot\.debian\.org\/archive\/(debian(?:-security)?)\/\d{8}T\d{6}Z$/u.test(repository.uri),
      'APT package must belong to the reviewed frozen repository');
    const pool = uri.slice(repository.uri.length);
    assert(!decodeURIComponent(pool).split('/').some(part => ['.', '..'].includes(part)));
    const archive = repository.uri.split('/')[4];
    const mirror = 'https://deb.debian.org/' + archive + pool;
    const size = Number(length);
    assert(Number.isSafeInteger(size) && size > 0 && size <= 256 * 1024 * 1024);
    assert(!downloads.some(entry => entry.filename === filename), 'Duplicate APT archive filename');
    downloads.push({ filename, size, sha256, urls: [mirror, uri] });
  }
  return downloads;
}

export async function downloadLockedDebianPackages(downloads, directory, fetcher = fetch) {
  await fs.mkdir(directory, { recursive: true });
  assert.equal(await fs.realpath(directory), path.resolve(directory), 'APT cache must not be a symlink');
  let next = 0;
  const failures = [];
  const workers = Array.from({ length: Math.min(4, downloads.length) }, async () => {
    while (next < downloads.length && !failures.length) {
      const item = downloads[next++];
      try {
        const destination = path.join(directory, item.filename);
        await fetchVerified({ ...item, destination, fetchImpl: fetcher, timeoutMs: 30_000 });
      } catch (error) { failures.push(error); }
    }
  });
  await Promise.all(workers);
  if (failures.length) throw new AggregateError(failures, 'Locked Debian downloads failed; installation was not started');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const packages = process.argv.slice(2);
  assert(packages.length && packages.every(name => /^[a-z0-9][a-z0-9+.-]*$/u.test(name)), 'Supply package names only');
  const lock = JSON.parse(await fs.readFile('/usr/local/share/canvas-debian-repository-lock.json', 'utf8'));
  verifyRepositoryLists(lock, '/var/lib/apt/lists');
  const common = ['-y', '--no-install-recommends'];
  const manifest = execFileSync('apt-get', [...common, '--download-only', '--print-uris', '-o', 'Acquire::ForceHash=SHA256', 'install', ...packages],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  await downloadLockedDebianPackages(lockedDebianDownloads(manifest, lock), '/var/cache/apt/archives');
  execFileSync('apt-get', [...common, '--no-download', 'install', ...packages], { stdio: 'inherit', timeout: 15 * 60_000 });
}
