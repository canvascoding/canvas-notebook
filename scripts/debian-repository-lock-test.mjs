import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { configureRepositories, verifyRepositoryLists } from './debian-repository-lock.mjs';

const policy = JSON.parse(fs.readFileSync('docs/compliance/docker-native-distribution-policy.json', 'utf8'));
const bytes = fs.readFileSync(policy.debianRepositories.lockFile);
const lock = JSON.parse(bytes);

test('repository policy identifies the exact checked-in lock', () => {
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), policy.debianRepositories.lockSha256);
  assert.deepEqual(lock.repositories.map(entry => entry.suite), ['bookworm', 'bookworm-updates', 'bookworm-security']);
  for (const repository of lock.repositories) assert.match(repository.uri, /\/\d{8}T\d{6}Z$/u, 'Reviewed sources must use full UTC cutoff addresses');
});

test('sources reject live mirrors, invalid cutoffs and mixed archive states before writing configuration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-apt-invalid-'));
  try {
    fs.mkdirSync(path.join(directory, 'sources.list.d'));
    fs.mkdirSync(path.join(directory, 'apt.conf.d'));
    const changed = callback => { const candidate = structuredClone(lock); callback(candidate); return candidate; };
    const future = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10).replaceAll('-', '');
    const invalid = [
      changed(value => { value.repositories[0].uri = 'https://deb.debian.org/debian'; }),
      changed(value => { value.repositories[0].uri = 'http://snapshot.debian.org/archive/debian/20261105'; }),
      changed(value => { value.repositories[0].uri = 'https://snapshot.debian.org.evil/archive/debian/20261105'; }),
      changed(value => { value.repositories[0].uri += '?mirror=live'; }),
      changed(value => { value.repositories[2].uri = value.repositories[0].uri; }),
      changed(value => { value.repositories[0].uri = 'https://snapshot.debian.org/archive/debian/20260230'; }),
      changed(value => { value.repositories[0].uri = `https://snapshot.debian.org/archive/debian/${future}`; }),
      changed(value => { value.repositories[1].uri = 'https://snapshot.debian.org/archive/debian/20261104'; }),
      changed(value => { value.repositories[2].suite = 'bookworm'; }),
      changed(value => { value.repositories.pop(); }),
    ];
    for (const candidate of invalid) {
      assert.throws(() => configureRepositories(candidate, directory));
      assert.throws(() => verifyRepositoryLists(candidate, directory));
      assert(!fs.existsSync(path.join(directory, 'sources.list.d/debian.sources')));
    }
    const precise = structuredClone(lock);
    for (const repository of precise.repositories) repository.uri = repository.uri.replace(/T\d{6}Z$/u, '') + 'T000000Z';
    configureRepositories(precise, directory);
    assert.match(fs.readFileSync(path.join(directory, 'sources.list.d/debian.sources'), 'utf8'), /20261105T000000Z/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('locked metadata accepts unchanged lists and rejects drift, missing data and unsigned metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-debian-lock-'));
  try {
    const files = lock.repositories.map(repository => {
      const prefix = `${new URL(repository.uri).host}${new URL(repository.uri).pathname}/dists/${repository.suite}`.replaceAll('/', '_');
      const filename = path.join(directory, `${prefix}_InRelease`);
      const text = '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nSHA256:\n'
        + Object.entries(repository.indexSha256).map(([name, hash]) => ` ${hash} 100 ${name}\n`).join('')
        + '-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n';
      fs.writeFileSync(filename, text);
      return { filename, text, repository };
    });
    verifyRepositoryLists(lock, directory);
    for (const { filename, text, repository } of files) {
      for (const key of ['main/binary-amd64/Packages', 'main/binary-arm64/Packages', 'main/source/Sources']) {
        fs.writeFileSync(filename, text.replace(repository.indexSha256[key], '0'.repeat(64)));
        assert.throws(() => verifyRepositoryLists(lock, directory), /Debian repository changed/u);
      }
      fs.writeFileSync(filename, text.replace(/^SHA256:[\s\S]*?-----BEGIN PGP SIGNATURE-----/mu, '-----BEGIN PGP SIGNATURE-----'));
      assert.throws(() => verifyRepositoryLists(lock, directory), /Missing SHA256 metadata/u);
      fs.writeFileSync(filename, text.replace('-----BEGIN PGP SIGNED MESSAGE-----\n', ''));
      assert.throws(() => verifyRepositoryLists(lock, directory), /signed InRelease/u);
      fs.rmSync(filename);
      assert.throws(() => verifyRepositoryLists(lock, directory), /ENOENT/u);
      fs.writeFileSync(filename, text);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('APT configuration retains signature verification, expiry checks and a mandatory lock hook', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-apt-config-'));
  try {
    fs.mkdirSync(path.join(directory, 'sources.list.d'));
    fs.mkdirSync(path.join(directory, 'apt.conf.d'));
    fs.writeFileSync(path.join(directory, 'sources.list'), 'old sources');
    configureRepositories(lock, directory);
    const sources = fs.readFileSync(path.join(directory, 'sources.list.d/debian.sources'), 'utf8');
    const configuration = fs.readFileSync(path.join(directory, 'apt.conf.d/99canvas-repository-lock'), 'utf8');
    assert.equal((sources.match(/URIs: https:\/\/snapshot\.debian\.org\//gu) || []).length, 3);
    assert.doesNotMatch(sources, /URIs: http:/u);
    assert.equal((sources.match(/Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring.gpg/gu) || []).length, 3);
    assert.doesNotMatch(sources + configuration, /trusted=yes|Check-Valid-Until|AllowInsecure|AllowUnauthenticated/iu);
    assert.match(configuration, /Post-Invoke-Success.*canvas-debian-repository-lock.mjs verify/u);
    assert.match(configuration, /APT::Update::Error-Mode "any"/u);
    assert(!fs.existsSync(path.join(directory, 'sources.list')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
