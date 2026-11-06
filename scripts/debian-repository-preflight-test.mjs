import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import crypto from 'node:crypto';
import { preflightRepositories } from './debian-repository-preflight.mjs';

const lock = JSON.parse(fs.readFileSync(new URL('../docs/compliance/debian-repository-lock.json', import.meta.url), 'utf8'));
const metadata = repository => '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nDate: Thu, 05 Nov 2026 00:00:00 UTC\nSHA256:\n'
  + Object.entries(repository.indexSha256).map(([name, hash]) => ` ${hash} 100 ${name}\n`).join('')
  + '-----BEGIN PGP SIGNATURE-----\nfixture, authenticated by APT in the actual image build\n-----END PGP SIGNATURE-----\n';
const reply = (url, body, status = 200, finalUrl = url) => {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
};
// Synthetic signature fixtures exercise metadata checks only; native APT tests authenticate signatures.
for (const repository of lock.repositories) {
  const bytes = Buffer.from(metadata(repository));
  repository.inRelease.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  repository.inRelease.size = bytes.length;
}
const sourceFor = url => lock.repositories.find(repository => url === `https://snapshot.debian.org/file/${repository.inRelease.fileSha1}/InRelease`);

test('HTTPS metadata preflight checks all reviewed suite hashes and consumes every body', async () => {
  const responses = [];
  const report = await preflightRepositories({ lock, fetchImpl: async (url, options) => {
    assert(url.startsWith('https://snapshot.debian.org/'));
    assert(options.signal instanceof AbortSignal);
    const response = reply(url, metadata(sourceFor(url)));
    responses.push(response);
    return response;
  } });
  assert.equal(report.passed, true);
  assert.equal(report.preflight, 'https-and-locked-index-metadata');
  assert.deepEqual(report.repositories.map(repository => repository.suite), lock.repositories.map(repository => repository.suite));
  assert(responses.every(response => response.bodyUsed && !response.body.locked));
});

test('invalid repository configuration is rejected before any network request', async () => {
  const candidate = structuredClone(lock);
  candidate.repositories[0].uri = 'http://snapshot.debian.org/archive/debian/20261105';
  let calls = 0;
  await assert.rejects(preflightRepositories({ lock: candidate, fetchImpl: async () => { calls++; throw Error('Unexpected network'); } }), /official Debian snapshot/u);
  assert.equal(calls, 0);
});

test('HTTP 503 fails after all independent responses have settled and closed', async () => {
  const responses = [];
  await assert.rejects(preflightRepositories({ lock, fetchImpl: async url => {
    const response = reply(url, metadata(sourceFor(url)), responses.length === 0 ? 503 : 200);
    responses.push(response);
    return response;
  } }), error => error instanceof AggregateError && error.errors.some(cause => cause.message.includes('HTTP 503')));
  assert.equal(responses.length, 3);
  assert(responses.every(response => response.bodyUsed && !response.body.locked));
});

test('a changed reviewed package index remains a failure', async () => {
  await assert.rejects(preflightRepositories({ lock, fetchImpl: async url => {
    const repository = sourceFor(url);
    return reply(url, metadata(repository).replace(repository.indexSha256['main/binary-amd64/Packages'], '0'.repeat(64)));
  } }), /Debian repository changed/u);
});

test('unfinished metadata requests are aborted within their deadline', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  let aborted = 0;
  try {
    await assert.rejects(preflightRepositories({ lock, timeoutMs: 15, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
    }) }), error => error instanceof AggregateError && error.errors.every(cause => cause.name === 'TimeoutError'));
    assert.equal(aborted, 3);
  } finally { clearTimeout(keepAlive); }
});

test('oversized metadata is bounded and rejected', async () => {
  await assert.rejects(preflightRepositories({ lock, fetchImpl: async url => reply(url, 'x'.repeat(2 * 1024 * 1024 + 1)) }),
    error => error instanceof AggregateError && error.errors.every(cause => cause.message.includes('preflight bound')));
});

test('an insecure redirect is rejected and its response body is cancelled', async () => {
  const responses = [];
  await assert.rejects(preflightRepositories({ lock, fetchImpl: async url => {
    const response = reply(url, metadata(sourceFor(url)), 200, url.replace('https:', 'http:'));
    responses.push(response);
    return response;
  } }), error => error instanceof AggregateError && error.errors.every(cause => cause.message.includes('official HTTPS')));
  assert(responses.every(response => response.bodyUsed && !response.body.locked));
});
