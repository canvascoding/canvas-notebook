import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyRepositoryLists(lock, listsDirectory) {
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.repositories.length, 3);
  for (const repository of lock.repositories) {
    assert.match(repository.uri, /^https:\/\/deb\.debian\.org\/debian(?:-security)?$/u);
    assert.match(repository.suite, /^bookworm(?:-updates|-security)?$/u);
    const prefix = `${new URL(repository.uri).host}${new URL(repository.uri).pathname}/dists/${repository.suite}`.replaceAll('/', '_');
    const release = fs.readFileSync(path.join(listsDirectory, `${prefix}_InRelease`), 'utf8');
    assert(release.startsWith('-----BEGIN PGP SIGNED MESSAGE-----\n'), 'APT must retain signed InRelease metadata');
    const section = release.match(/^SHA256:\n((?:[ \t]+[^\n]+\n)+)/mu)?.[1];
    assert(section, `Missing SHA256 metadata for ${repository.suite}`);
    const hashes = new Map(section.trim().split('\n').map(line => {
      const [hash, size, filename] = line.trim().split(/\s+/u);
      assert.match(hash, /^[a-f0-9]{64}$/u);
      assert.match(size, /^\d+$/u);
      return [filename, hash];
    }));
    for (const required of ['main/binary-amd64/Packages', 'main/binary-arm64/Packages', 'main/source/Sources']) {
      assert.match(repository.indexSha256[required] || '', /^[a-f0-9]{64}$/u);
    }
    for (const [filename, expected] of Object.entries(repository.indexSha256)) {
      assert.equal(hashes.get(filename), expected, `Debian repository changed: ${repository.suite}/${filename}; refresh and review the repository lock before building`);
    }
  }
}

export function configureRepositories(lock, aptDirectory) {
  assert.equal(lock.schemaVersion, 1);
  const sources = lock.repositories.map(repository => {
    assert.match(repository.uri, /^https:\/\/deb\.debian\.org\/debian(?:-security)?$/u);
    assert.match(repository.suite, /^bookworm(?:-updates|-security)?$/u);
    return `Types: deb deb-src\nURIs: ${repository.uri.replace('https:', 'http:')}\nSuites: ${repository.suite}\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n`;
  }).join('\n');
  fs.writeFileSync(path.join(aptDirectory, 'sources.list.d/debian.sources'), sources);
  fs.rmSync(path.join(aptDirectory, 'sources.list'), { force: true });
  fs.writeFileSync(path.join(aptDirectory, 'apt.conf.d/99canvas-repository-lock'),
    'Acquire::Retries "2";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAPT::Update::Error-Mode "any";\n'
    + 'APT::Update::Post-Invoke-Success { "/usr/local/bin/node /usr/local/libexec/canvas-debian-repository-lock.mjs verify"; };\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const lock = JSON.parse(fs.readFileSync('/usr/local/share/canvas-debian-repository-lock.json', 'utf8'));
  if (process.argv[2] === 'configure') configureRepositories(lock, '/etc/apt');
  else {
    assert.equal(process.argv[2], 'verify');
    verifyRepositoryLists(lock, '/var/lib/apt/lists');
  }
}
