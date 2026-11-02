import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPrivateJson, redactAcceptanceText } from './helpers/compiled-api-sdk-acceptance.mjs';

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-compiled-acceptance-'));
  fs.chmodSync(root, 0o700);
  try { return run(fs.realpathSync(root)); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('owned private JSON is accepted; group-readable evidence is rejected', () => fixture(root => {
  const file = path.join(root, 'evidence.json');
  fs.writeFileSync(file, '{"version":1}', { mode: 0o600 });
  assert.deepEqual(readPrivateJson(file, root), { version: 1 });
  fs.chmodSync(file, 0o640); assert.throws(() => readPrivateJson(file, root));
}));

test('symlink and shared-inode evidence cannot substitute for the supplied private file', () => fixture(root => {
  const file = path.join(root, 'evidence.json'), link = path.join(root, 'link.json'), hard = path.join(root, 'shared.json');
  fs.writeFileSync(file, '{"version":1}', { mode: 0o600 });
  fs.symlinkSync(file, link); assert.throws(() => readPrivateJson(link, root));
  fs.linkSync(file, hard); assert.throws(() => readPrivateJson(hard, root)); assert.throws(() => readPrivateJson(file, root));
}));

test('a sibling directory with the same textual prefix is outside the fixture', () => fixture(root => {
  const child = path.join(root, 'held'), sibling = path.join(root, 'held-other');
  fs.mkdirSync(child, { mode: 0o700 }); fs.mkdirSync(sibling, { mode: 0o700 });
  const file = path.join(sibling, 'evidence.json'); fs.writeFileSync(file, '{}', { mode: 0o600 });
  assert.throws(() => readPrivateJson(file, child));
}));

test('oversized and malformed private evidence fail before becoming a runtime proof', () => fixture(root => {
  const huge = path.join(root, 'huge.json'), malformed = path.join(root, 'malformed.json');
  const fd = fs.openSync(huge, 'wx', 0o600);
  try { fs.ftruncateSync(fd, 16 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  assert.throws(() => readPrivateJson(huge, root));
  fs.writeFileSync(malformed, '{', { mode: 0o600 }); assert.throws(() => readPrivateJson(malformed, root));
}));

test('report redaction removes issued-key syntax, sessions, Bearer and runtime secrets', () => {
  const key = 'cnk_' + randomUUID() + '.' + randomBytes(32).toString('base64url');
  const session = randomBytes(32).toString('base64url'), bearer = randomBytes(32).toString('base64url');
  const runtimeSecret = randomBytes(32).toString('base64url');
  const observed = redactAcceptanceText(`keep ${key} better-auth.session_token=${session}; Bearer ${bearer} ${runtimeSecret}`, [runtimeSecret]);
  for (const value of [key, session, bearer, runtimeSecret]) assert.equal(observed.includes(value), false);
  assert(observed.startsWith('keep ')); assert(observed.includes('[redacted-api-key]'));
});
