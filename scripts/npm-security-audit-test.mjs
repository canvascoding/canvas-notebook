import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditBlockers, verifyPicomatchPatches } from './npm-security-audit.mjs';

const copy = 'node_modules/picomatch';
const verified = new Set([copy]);
const advisory = { name: 'picomatch', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf' };
const findings = {
  picomatch: { nodes: [copy], via: [advisory] },
  indirect: { via: ['picomatch'] },
  consumer: { via: ['indirect', 'picomatch'] },
};

test('only the verified advisory and its derived findings are exempted', () => {
  assert.deepEqual(auditBlockers(findings, verified), []);
  assert.deepEqual(auditBlockers({
    ...findings,
    indirect: { via: ['picomatch', { name: 'indirect', url: 'https://example.org/another-advisory' }] },
  }, verified), ['indirect', 'consumer']);
  assert.deepEqual(auditBlockers({
    ...findings,
    picomatch: { nodes: [copy], via: [advisory, { ...advisory, url: 'https://example.org/another-advisory' }] },
  }, verified), Object.keys(findings));
});

test('unverified paths and unresolved dependency chains still block', () => {
  assert.deepEqual(auditBlockers(findings, new Set()), Object.keys(findings));
  assert.deepEqual(auditBlockers({ ...findings, unresolved: { via: ['absent'] } }, verified), ['unresolved']);
  assert.deepEqual(auditBlockers({
    ...findings,
    picomatch: { nodes: [copy, 'node_modules/new-parent/node_modules/picomatch'], via: [advisory] },
  }, verified), Object.keys(findings));
});

test('cycles only clear when their causes reach the verified advisory', () => {
  assert.deepEqual(auditBlockers({
    ...findings,
    cyclic: { via: ['consumer', 'cyclic'] },
    detached: { via: ['detached'] },
  }, verified), ['detached']);
});

test('an installed Picomatch copy with unexpected parser bytes fails verification', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'canvas-picomatch-audit-')));
  try {
    const version = '4.0.5';
    const directory = path.join(root, copy);
    mkdirSync(path.join(directory, 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { [copy]: { version } } }));
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'picomatch', version }));
    writeFileSync(path.join(directory, 'lib/parse.js'), 'fixture');
    assert.throws(() => verifyPicomatchPatches(root), /Unverified Picomatch patch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
