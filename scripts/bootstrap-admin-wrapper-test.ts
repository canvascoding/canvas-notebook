import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, ['scripts/bootstrap-admin.js', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOOTSTRAP_ADMIN_EMAIL: '',
      BOOTSTRAP_ADMIN_PASSWORD: '',
    },
    encoding: 'utf8',
    input,
  });
}

const noCredentials = run([]);
assert.equal(noCredentials.status, 0);
assert.match(noCredentials.stdout, /Skipped/u);

const help = run(['--help']);
assert.equal(help.status, 0);
assert.match(help.stdout, /--ensure/u);
assert.match(help.stdout, /--password-stdin/u);

const unknown = run(['--unknown']);
assert.notEqual(unknown.status, 0);
assert.match(unknown.stderr, /Unknown option/u);

const invalidCombination = run(['--ensure', '--password-stdin'], 'fixture-password\n');
assert.notEqual(invalidCombination.status, 0);
assert.match(invalidCombination.stderr, /cannot be combined/u);

console.log('PostgreSQL bootstrap admin wrapper CLI contracts passed');
