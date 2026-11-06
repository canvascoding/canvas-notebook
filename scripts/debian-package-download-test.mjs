import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadLockedDebianPackages, lockedDebianDownloads } from './debian-package-download.mjs';

const lock = JSON.parse(await fs.readFile('docs/compliance/debian-repository-lock.json', 'utf8'));
const content = Buffer.from('exact reviewed Debian artifact');
const digest = createHash('sha256').update(content).digest('hex');
const uri = lock.repositories[0].uri + '/pool/main/p/package/package_1.0%2b1_arm64.deb';
const manifest = `'${uri}' package_1.0+1_arm64.deb ${content.length} SHA256:${digest}`;
const entry = lockedDebianDownloads(manifest, lock)[0];

test('transport candidates retain the frozen package path, version and strong hash', () => {
  assert.deepEqual(entry, { filename: 'package_1.0+1_arm64.deb', size: content.length, sha256: digest,
    urls: ['https://deb.debian.org/debian/pool/main/p/package/package_1.0%2b1_arm64.deb', uri] });
  const security = lockedDebianDownloads(manifest.replace(lock.repositories[0].uri, lock.repositories[2].uri), lock)[0];
  assert.match(security.urls[0], /^https:\/\/deb\.debian\.org\/debian-security\/pool\//u);
});

test('unlocked origins, traversal, weak/missing hashes and conflicting filenames cannot start downloads', () => {
  for (const value of [
    manifest.replace('snapshot.debian.org', 'snapshot.debian.org.evil'),
    manifest.replace(lock.repositories[0].uri, 'https://deb.debian.org/debian'),
    manifest.replace('https:', 'http:'), manifest.replace('/pool/main/', '/pool/%2e%2e/'),
    manifest.replace('package_1.0+1_arm64.deb ', '../package.deb '),
    manifest.replace('SHA256:', 'MD5Sum:'), manifest.replace(digest, digest.slice(1)),
    manifest.replace(String(content.length), '0'), manifest + '\n' + manifest,
  ]) assert.throws(() => lockedDebianDownloads(value, lock));
  assert.deepEqual(lockedDebianDownloads('0 newly installed.\n', lock), []);
});

test('official mirror bytes are verified before becoming an installable archive', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-deb-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  await downloadLockedDebianPackages([entry], directory, async url => { calls.push(url); return new Response(content); });
  assert.deepEqual(calls, [entry.urls[0]]);
  assert.deepEqual(await fs.readFile(path.join(directory, entry.filename)), content);
  assert.deepEqual(await fs.readdir(directory), [entry.filename]);
});

for (const unavailable of ['http', 'network']) test(`bounded snapshot fallback after mirror ${unavailable} failure`, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-deb-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  await downloadLockedDebianPackages([entry], directory, async (url, options) => {
    assert(options.signal instanceof AbortSignal); calls.push(url);
    if (url === entry.urls[1]) return new Response(content);
    if (unavailable === 'network') throw new TypeError('transport failed', { cause: { code: 'ECONNRESET' } });
    return new Response('not retained by live mirror', { status: 404 });
  });
  assert.deepEqual(calls, entry.urls);
});

for (const wrong of ['hash', 'short', 'oversize']) test(`reject ${wrong} bytes without caching them or masking integrity failure`, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-deb-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const bytes = wrong === 'hash' ? Buffer.alloc(content.length) : wrong === 'short' ? content.subarray(1) : Buffer.concat([content, content]);
  await assert.rejects(downloadLockedDebianPackages([entry], directory, async () => { calls++; return new Response(bytes); }), AggregateError);
  assert.equal(calls, 1); assert.deepEqual(await fs.readdir(directory), []);
});

test('both unavailable transports fail without a completed archive', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-deb-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(downloadLockedDebianPackages([entry], directory, async () => { calls++; return new Response('', { status: 503 }); }), AggregateError);
  assert.equal(calls, 2); assert.deepEqual(await fs.readdir(directory), []);
});

test('verified cache avoids the network and conflicting archives fail closed', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-deb-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, entry.filename);
  await fs.writeFile(filename, content);
  const never = async () => { throw new Error('must not fetch'); };
  await downloadLockedDebianPackages([entry], directory, never);
  await fs.writeFile(filename, Buffer.alloc(content.length));
  await assert.rejects(downloadLockedDebianPackages([entry], directory, never), AggregateError);
  assert.deepEqual(await fs.readFile(filename), Buffer.alloc(content.length));
});

test('cache directory and archive symlinks are rejected', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-deb-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  const link = path.join(directory, 'link'); await fs.symlink(outside, link);
  await assert.rejects(downloadLockedDebianPackages([entry], link));
  await fs.writeFile(path.join(outside, 'target'), content);
  await fs.symlink(path.join(outside, 'target'), path.join(directory, entry.filename));
  await assert.rejects(downloadLockedDebianPackages([entry], directory), AggregateError);
});
