import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'canvas-setup-managed-'));
const callsFile = path.join(temporary, 'calls.jsonl');

try {
  for (const command of ['npm', 'docker']) {
    const filename = path.join(temporary, command);
    writeFileSync(filename, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SETUP_TEST_CALLS, JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2),
  cwd: process.cwd(), sentinel: process.env.SETUP_TEST_SENTINEL }) + '\\n');
process.exit(${command === 'npm' ? 'Number(process.env.SETUP_TEST_EXIT_CODE || 0)' : '93'});
`);
    chmodSync(filename, 0o700);
  }
  writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}\n');

  const run = (arguments_, exitCode = 0) => {
    writeFileSync(callsFile, '');
    const result = spawnSync(process.execPath, [path.join(repository, 'scripts/setup.mjs'), ...arguments_], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PATH: `${temporary}${path.delimiter}${process.env.PATH || ''}`,
        SETUP_TEST_CALLS: callsFile, SETUP_TEST_SENTINEL: 'inherited', SETUP_TEST_EXIT_CODE: String(exitCode) },
    });
    assert.ifError(result.error);
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value));
    return { result, calls };
  };

  for (const arguments_ of [['--managed'], ['--managed', '--state-dir', '/tmp/managed state'],
    ['--state-dir', '/tmp/managed state', '--managed']]) {
    const { result, calls } = run(arguments_);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [{ command: 'npm', args: ['run', 'testenv:update:notebook',
      ...(arguments_.includes('--state-dir') ? ['--', '--state-dir', '/tmp/managed state'] : [])],
      cwd: repository, sentinel: 'inherited' }]);
    assert.doesNotMatch(result.stdout, /Step 1:|Checking Docker|3456/u);
  }

  const failed = run(['--managed'], 27);
  assert.equal(failed.result.status, 27);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.calls[0].command, 'npm');

  for (const arguments_ of [['--managed', '--unknown'], ['--managed', '--managed'],
    ['--managed', '--state-dir'], ['--managed', '--state-dir', '--unknown'],
    ['--managed', '--state-dir', ' '], ['--managed', '--state-dir', '/tmp/state\ninvalid'],
    ['--managed', '--state-dir', '/tmp/one', '--state-dir', '/tmp/two']]) {
    const { result, calls } = run(arguments_);
    assert.equal(result.status, 1);
    assert.deepEqual(calls, []);
  }

  const standalone = run([]);
  assert.equal(standalone.result.status, 1);
  assert.ok(standalone.calls.length > 0);
  assert.ok(standalone.calls.every(call => call.command === 'docker'));
  assert.match(standalone.result.stdout, /Checking Docker/u);
  console.log('Managed setup dispatch: passed (standalone Docker is isolated by test stubs).');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
