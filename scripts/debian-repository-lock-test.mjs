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
    assert.equal((sources.match(/Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring.gpg/gu) || []).length, 3);
    assert.doesNotMatch(sources + configuration, /trusted=yes|Check-Valid-Until|AllowInsecure|AllowUnauthenticated/iu);
    assert.match(configuration, /Post-Invoke-Success.*canvas-debian-repository-lock.mjs verify/u);
    assert.match(configuration, /APT::Update::Error-Mode "any"/u);
    assert(!fs.existsSync(path.join(directory, 'sources.list')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
