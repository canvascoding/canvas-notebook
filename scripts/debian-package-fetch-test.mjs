import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fetchVerified } from './debian-package-fetch.mjs';
import { parsePackagePlan } from './debian-package-install.mjs';
import { mirrorRepository, verifyRelease } from './debian-repository-lock.mjs';

const payload = Buffer.from('authenticated package bytes');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const urls = ['https://deb.debian.org/debian/pool/package.deb', 'https://snapshot.debian.org/archive/debian/20261105T000000Z/pool/package.deb'];
const options = { urls, sha256: digest(payload), size: payload.length };

test('transient source failure uses identical authenticated bytes from fallback and verifies cache hits', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fetch-test-'));
  try {
    let calls = 0;
    const destination = path.join(directory, 'package.deb');
    const fetchImpl = async () => new Response(++calls === 1 ? 'unavailable' : payload, { status: calls === 1 ? 503 : 200 });
    assert.equal((await fetchVerified({ ...options, destination, fetchImpl })).cached, false);
    assert.equal(calls, 2);
    assert.equal((await fetchVerified({ ...options, destination, fetchImpl })).cached, true);
    assert.equal(calls, 2);
    fs.writeFileSync(destination, Buffer.alloc(payload.length));
    await assert.rejects(fetchVerified({ ...options, destination, fetchImpl }), /SHA256/u);
    assert.equal(calls, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('integrity errors, TLS errors and symlinks fail closed without fallback or leftover files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fetch-reject-'));
  try {
    const destination = path.join(directory, 'package.deb');
    for (const fetchResult of [Buffer.alloc(payload.length), Buffer.alloc(payload.length + 1), Buffer.alloc(payload.length - 1)]) {
      let calls = 0;
      await assert.rejects(fetchVerified({ ...options, destination, fetchImpl: async () => { calls++; return new Response(fetchResult); } }), /SHA256|size/u);
      assert.equal(calls, 1);
      assert.deepEqual(fs.readdirSync(directory), []);
    }
    let calls = 0;
    await assert.rejects(fetchVerified({ ...options, destination, fetchImpl: async () => { calls++; throw new TypeError('TLS failed', { cause: { code: 'CERT_HAS_EXPIRED' } }); } }), /TLS/u);
    assert.equal(calls, 1);
    fs.writeFileSync(path.join(directory, 'target'), payload);
    fs.symlinkSync('target', destination);
    await assert.rejects(fetchVerified({ ...options, destination }), /regular files/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('plan accepts exact frozen package paths and rejects weak hashes or external authorities', () => {
  const lock = JSON.parse(fs.readFileSync('docs/compliance/debian-repository-lock.json'));
  const uri = `${mirrorRepository(lock.repositories[0]).uri}/pool/main/e/exif/libexif12_1%2b1_amd64.deb`;
  const line = `'${uri}' libexif12_1+1_amd64.deb 27 SHA256:${digest(payload)}`;
  const [entry] = parsePackagePlan(line, lock);
  assert.equal(entry.filename, 'libexif12_1+1_amd64.deb');
  assert.equal(entry.urls[0], 'https://deb.debian.org/debian/pool/main/e/exif/libexif12_1%2b1_amd64.deb');
  assert.deepEqual(parsePackagePlan(line.replace('file:///', 'file:/'), lock), [entry]);
  for (const invalid of [line.replace('SHA256:', 'MD5Sum:'), line.replace('file:///', 'file://evil/'), line.replace('/pool/', '/outside/'), line.replace(' libexif12_', ' ../libexif12_'), line.replace('/main/', '/%2e%2e/')]) {
    assert.throws(() => parsePackagePlan(invalid, lock));
  }
});

test('redirects remain bounded on the same official HTTPS authority', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fetch-redirect-'));
  try {
    const destination = path.join(directory, 'package.deb');
    let calls = 0;
    await fetchVerified({ ...options, destination, fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      return ++calls === 1 ? new Response(null, { status: 302, headers: { location: '/debian/redirect/package.deb' } }) : new Response(payload);
    } });
    assert.equal(calls, 2);
    fs.rmSync(destination);
    for (const location of ['https://evil.example/package.deb', 'http://deb.debian.org/package.deb']) {
      await assert.rejects(fetchVerified({ ...options, destination, fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), /same official HTTPS/u);
    }
    await assert.rejects(fetchVerified({ ...options, destination, fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/loop' } }) }), /Too many/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('whole signed metadata binding rejects expiry, future dates and changed release fields', () => {
  const metadata = date => Buffer.from(`-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nDate: ${date}\nValid-Until: Wed, 11 Nov 2026 21:43:52 UTC\nSHA256:\n ${'a'.repeat(64)} 27 main/binary-amd64/Packages\n`);
  const bytes = metadata('Thu, 05 Nov 2026 00:00:00 UTC');
  const repository = { suite: 'fixture', indexSha256: { 'main/binary-amd64/Packages': 'a'.repeat(64) }, inRelease: { sha256: digest(bytes), size: bytes.length } };
  verifyRelease(repository, bytes, Date.parse('2026-11-06T00:00:00Z'));
  assert.throws(() => verifyRelease(repository, bytes, Date.parse('2026-11-12T00:00:00Z')), /expired/u);
  assert.throws(() => verifyRelease(repository, bytes, Date.parse('2026-11-04T00:00:00Z')), /future/u);
  assert.throws(() => verifyRelease(repository, metadata('Thu, 05 Nov 2026 01:00:00 UTC')), /SHA256/u);
});
