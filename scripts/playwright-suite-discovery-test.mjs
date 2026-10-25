import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { managedAcceptanceTestIgnore } from '../tests/helpers/managed-acceptance-suites.mjs';

const env = { ...process.env, E2E_EXTERNAL_SERVER: '1' };
const listed = spawnSync('npx', ['--no-install', 'playwright', 'test', '--list', '--reporter=json'], {
  env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
});
assert.equal(listed.status, 0, `Ordinary test discovery failed: ${listed.stderr.slice(-1500)}`);
const start = listed.stdout.search(/\{\s*"config"\s*:/u);
assert.ok(start >= 0, 'Playwright must emit its actual discovered suite');
const report = JSON.parse(listed.stdout.slice(start));
const files = report.suites.map(suite => suite.file.replaceAll('\\', '/'));
assert.ok(files.length > 30, 'The ordinary suite must retain broad coverage');
for (const name of ['auth-bootstrap.spec.ts', 'browser-lab.spec.ts', 'automationen.spec.ts', 'collaboration-recovery.spec.ts', 'collaboration-release-recovery.spec.ts']) {
  assert.ok(files.some(file => file.endsWith(name)), `${name} must remain in ordinary discovery`);
}
for (const pattern of managedAcceptanceTestIgnore) {
  const name = pattern.slice(3);
  assert.ok(!files.some(file => name.startsWith('*-') ? file.endsWith(name.slice(1)) : file.endsWith(name)),
    `Owned acceptance ${pattern} leaked into ordinary discovery`);
}
// Its explicit runner keeps the guard: default discovery never enables it.
const guarded = spawnSync('npx', ['--no-install', 'playwright', 'test', '--list',
  '--config', 'tests/playwright/playwright.plugin-extensions.config.ts'], {
  env: { ...env, CANVAS_PLUGIN_EXTENSION_E2E: '', PLUGIN_EXTENSION_E2E_ROOT: '', PLUGIN_EXTENSION_E2E_FIXTURE: '' },
  encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
});
assert.notEqual(guarded.status, 0);
assert.match(guarded.stderr + guarded.stdout, /requires its isolated runner/u);
console.log(`Ordinary discovery retains ${files.length} test files; private acceptance runner still rejects an unowned invocation`);
