import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../workflows/electron-build.yml', import.meta.url), 'utf8');
const sourceSha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const releaseTag = 'v2026.11.5.4';

function stepScript(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  assert(start >= 0, `Missing workflow step: ${name}`);
  let index = start + 1;
  while (index < lines.length && lines[index] !== '        run: |') {
    assert(!lines[index].startsWith('      - '), 'Step has no shell block');
    index++;
  }
  const script = [];
  for (index++; index < lines.length; index++) {
    if (lines[index] && !lines[index].startsWith('          ')) break;
    script.push(lines[index].slice(10));
  }
  assert(script[0] === 'set -euo pipefail');
  return script.join('\n');
}

function runStep(name, overrides = {}, responses = [{ status: 0, message: 'Ticket validated' }]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-desktop-contract-'));
  try {
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '2026.11.5.4' }));
    fs.writeFileSync(path.join(directory, 'responses.json'), JSON.stringify(responses));
    fs.writeFileSync(path.join(directory, 'output'), '');
    const executable = (name, body) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o700 });
    executable('xcrun', `
      const fs = require('node:fs');
      const rows = fs.existsSync('calls') ? fs.readFileSync('calls', 'utf8').trim().split('\\n') : [];
      fs.appendFileSync('calls', JSON.stringify(process.argv.slice(2)) + '\\n');
      const responses = JSON.parse(fs.readFileSync('responses.json'));
      const response = responses[Math.min(rows.length, responses.length - 1)];
      console.error(response.message);
      process.exit(response.status);
    `);
    executable('sleep', `require('node:fs').appendFileSync('sleeps', process.argv[2] + '\\n');`);
    executable('git', `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync('git-calls', JSON.stringify(args) + '\\n');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') console.log(process.env.STUB_HEAD);
      else if (args[0] === 'rev-parse' && args[1].startsWith('refs/tags/')) console.log(process.env.STUB_TAG_SHA);
      else if (args[0] === 'merge-base') process.exit(Number(process.env.STUB_ANCESTOR_STATUS));
      else process.exit(99);
    `);
    const result = spawnSync('bash', ['-c', stepScript(name)], {
      cwd: directory,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        RUNNER_TEMP: directory, APP_PATH: path.join(directory, 'Canvas Test.app'),
        GITHUB_OUTPUT: path.join(directory, 'output'), GITHUB_REPOSITORY: 'canvascoding/canvas-notebook',
        GITHUB_SHA: sourceSha, GITHUB_REF: 'refs/tags/' + releaseTag, GITHUB_EVENT_NAME: 'push',
        REQUESTED_RELEASE_TAG: '', REQUESTED_SOURCE_SHA: '',
        STUB_HEAD: sourceSha, STUB_TAG_SHA: sourceSha, STUB_ANCESTOR_STATUS: '0', ...overrides },
      encoding: 'utf8', timeout: 15_000,
    });
    assert(Number.isInteger(result.status), String(result.error ?? result.signal));
    const rows = file => fs.existsSync(path.join(directory, file))
      ? fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n').filter(Boolean) : [];
    return { status: result.status, stderr: result.stderr,
      calls: rows('calls').map(JSON.parse), sleeps: rows('sleeps'), gitCalls: rows('git-calls').map(JSON.parse),
      output: rows('output'), injected: fs.existsSync(path.join(directory, 'injected')),
      proof: fs.existsSync(path.join(directory, 'desktop-release-source.json'))
        ? JSON.parse(fs.readFileSync(path.join(directory, 'desktop-release-source.json'))) : null };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const ticketStep = 'Verify Apple notarization ticket';
const sourceStep = 'Verify desktop release source';
const networkFailure = { status: 68, message: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' };

test('valid ticket succeeds once with the literal app path', () => {
  const result = runStep(ticketStep);
  assert.equal(result.status, 0);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].slice(0, 2), ['stapler', 'validate']);
  assert(result.calls[0][2].endsWith('/Canvas Test.app'));
  assert.deepEqual(result.sleeps, []);
});

for (const code of [1001, 1003, 1004, 1005, 1009]) {
  test(`transport error -${code} retries the same artifact and requires actual success`, () => {
    const result = runStep(ticketStep, {}, [
      { status: 68, message: `Error Domain=NSURLErrorDomain Code=-${code} transport failure` },
      { status: 0, message: 'Ticket validated' },
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.calls[0], result.calls[1]);
    assert.deepEqual(result.sleeps, ['15']);
  });
}

test('persistent transport failure remains a bounded failure', () => {
  const result = runStep(ticketStep, {}, [networkFailure]);
  assert.equal(result.status, 68);
  assert.equal(result.calls.length, 4);
  assert.deepEqual(result.sleeps, ['15', '30', '45']);
});

test('a later ticket rejection cannot reuse an earlier transport error', () => {
  const result = runStep(ticketStep, {}, [networkFailure, { status: 68, message: 'Ticket rejected' }]);
  assert.equal(result.status, 68);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.sleeps, ['15']);
});

for (const failure of [
  { status: 68, message: 'The ticket does not match the application.' },
  { status: 68, message: 'NSURLErrorDomain Code=-1200 TLS validation failed' },
  { status: 68, message: 'NSURLErrorDomain Code=-10050 unknown error' },
  { status: 1, message: networkFailure.message },
]) {
  test(`non-retryable rejection remains a failure: ${failure.message}`, () => {
    const result = runStep(ticketStep, {}, [failure]);
    assert.equal(result.status, failure.status);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.sleeps, []);
  });
}

test('tag push binds the receipt to the exact event source', () => {
  const result = runStep(sourceStep);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.proof, { schemaVersion: 1, commitSha: sourceSha, tag: releaseTag });
});

test('manual rebuild binds an older tag source independently of the workflow commit', () => {
  const result = runStep(sourceStep, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: workflowSha,
    GITHUB_REF: 'refs/heads/main', REQUESTED_RELEASE_TAG: releaseTag, REQUESTED_SOURCE_SHA: sourceSha });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.proof, { schemaVersion: 1, commitSha: sourceSha, tag: releaseTag });
});

for (const [reason, overrides] of [
  ['unpaired tag', { GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_RELEASE_TAG: releaseTag }],
  ['unpaired SHA', { GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_SOURCE_SHA: sourceSha }],
  ['wrong approved source', { GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_RELEASE_TAG: releaseTag, REQUESTED_SOURCE_SHA: workflowSha }],
  ['malformed SHA', { GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_RELEASE_TAG: releaseTag, REQUESTED_SOURCE_SHA: sourceSha + '\ninjected=yes' }],
  ['shell payload in tag', { GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_RELEASE_TAG: releaseTag + '$(touch injected)', REQUESTED_SOURCE_SHA: sourceSha }],
  ['tag points elsewhere', { STUB_TAG_SHA: workflowSha }],
  ['source absent from main', { STUB_ANCESTOR_STATUS: '1' }],
  ['tag/package mismatch', { GITHUB_REF: 'refs/tags/v2026.11.5.5' }],
  ['event source drift', { GITHUB_SHA: workflowSha }],
  ['wrong repository', { GITHUB_REPOSITORY: 'untrusted/fork' }],
]) {
  test(`source admission rejects ${reason} before creating a receipt`, () => {
    const result = runStep(sourceStep, overrides);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.output, []);
    assert.equal(result.proof, null);
    assert.equal(result.calls.length, 0);
    assert.equal(result.injected, false);
  });
}

test('an unversioned manual build emits no publishable release tag', () => {
  const result = runStep(sourceStep, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.proof, { schemaVersion: 1, commitSha: sourceSha, tag: '' });
  assert(result.output.includes('release_tag='));
});
