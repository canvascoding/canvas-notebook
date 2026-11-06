import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchVerified } from './debian-package-fetch.mjs';
import { mirrorRepository, repositoryReleaseFilename, verifyRepositoryLists } from './debian-repository-lock.mjs';

export function parsePackagePlan(output, lock) {
  return output.split('\n').filter(line => line.startsWith("'")).map(line => {
    const match = /^'([^']+)' ([^\s/]+\.deb) (\d+) SHA256:([a-f0-9]{64})$/u.exec(line);
    assert(match, 'APT package plan must include SHA256 and a safe archive filename');
    const [, uri, filename, sizeText, sha256] = match;
    const url = new URL(uri);
    assert.equal(url.protocol, 'file:');
    assert(!url.host && !url.search && !url.hash, 'Unexpected package URI authority');
    const source = lock.repositories.find(repository => url.href.startsWith(`${mirrorRepository(repository).uri}/pool/`));
    assert(source, 'Package URI must belong to the frozen mirror');
    const pool = url.href.slice(mirrorRepository(source).uri.length + 1);
    assert(/^pool\/[a-zA-Z0-9/_.%+~-]+$/u.test(pool) && !decodeURIComponent(pool).split('/').some(part => part === '..' || part === '.'));
    const archive = source.suite === 'bookworm-security' ? 'debian-security' : 'debian';
    return { filename, sha256, size: Number(sizeText), mirrorFile: fileURLToPath(uri), urls: [
      `https://deb.debian.org/${archive}/${pool}`,
      `${source.uri}/${pool}`,
    ] };
  });
}

async function hashIndex(filename) {
  const child = spawn('/usr/lib/apt/apt-helper', ['cat-file', filename], { stdio: ['ignore', 'pipe', 'inherit'] });
  const hash = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => hash.update(bytes));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(hash.digest('hex')) : reject(new Error(`APT index decompression failed: ${code}`)));
  });
}

export async function installPackages(lock, packages) {
  assert(packages.length > 0 && packages.every(name => /^[a-z0-9][a-z0-9+.-]*(?::(?:amd64|arm64))?$/u.test(name)), 'Only explicit package names are allowed');
  const listsDirectory = '/var/lib/apt/lists';
  verifyRepositoryLists(lock, listsDirectory, { mirror: true });
  const architecture = execFileSync('dpkg', ['--print-architecture'], { encoding: 'utf8' }).trim();
  assert(['amd64', 'arm64'].includes(architecture));
  for (const repository of lock.repositories) {
    const release = path.join(listsDirectory, repositoryReleaseFilename(mirrorRepository(repository)));
    execFileSync('gpgv', ['--keyring', '/usr/share/keyrings/debian-archive-keyring.gpg', release], { stdio: 'inherit' });
    const prefix = release.replace(/InRelease$/u, `main_binary-${architecture}_Packages`);
    const files = [prefix, `${prefix}.lz4`, `${prefix}.xz`, `${prefix}.gz`].filter(file => fs.existsSync(file));
    assert.equal(files.length, 1, 'Expected exactly one authenticated APT package index');
    assert.equal(await hashIndex(files[0]), repository.indexSha256[`main/binary-${architecture}/Packages`], 'Cached APT package index changed');
  }
  const argumentsBase = ['-o', 'Acquire::ForceHash=SHA256', '--yes', '--no-install-recommends'];
  const plan = execFileSync('apt-get', [...argumentsBase, '--print-uris', '--download-only', 'install', ...packages], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const entries = parsePackagePlan(plan, lock);
  const owned = [];
  try {
    // Deliberately bounded concurrency: large build stages must not overload the
    // public mirror or buffer all package payloads in the Node heap.
    const pending = entries.values();
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, entries.length) }, async () => {
      for (const entry of pending) {
        const destination = path.join('/var/cache/apt/archives', entry.filename);
        const result = await fetchVerified({ ...entry, destination });
        if (!result.cached) owned.push(destination);
        fs.mkdirSync(path.dirname(entry.mirrorFile), { recursive: true });
        try { fs.linkSync(destination, entry.mirrorFile); owned.push(entry.mirrorFile); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    }));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Verified package staging failed');
    execFileSync('apt-get', [...argumentsBase, '--no-download', 'install', ...packages], { stdio: 'inherit' });
  } finally {
    for (const filename of owned) fs.rmSync(filename, { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const lock = JSON.parse(fs.readFileSync('/usr/local/share/canvas-debian-repository-lock.json', 'utf8'));
  await installPackages(lock, process.argv.slice(2).filter(value => !['-y', '--no-install-recommends'].includes(value)));
}
