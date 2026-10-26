import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { managedAcceptanceSelection } from '../tests/helpers/managed-acceptance-suites.mjs';

const env = { ...process.env, E2E_EXTERNAL_SERVER: '1', CANVAS_YJS_AUTHORITY_E2E: '',
  CANVAS_BATCH_E2E_RUN_ID: '', CANVAS_COLLABORATION_QA: '', CANVAS_PI_CHAT_LIVE_E2E: '',
  CANVAS_DOCUMENT_REVIEW_E2E: '' };
function list(args = [], overrides = {}) {
  return spawnSync('npx', ['--no-install', 'playwright', 'test', '--list', '--reporter=json', ...args], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
}
function report(result) {
  assert.equal(result.status, 0, `Test discovery failed: ${result.stderr.slice(-1500)}`);
  const start = result.stdout.search(/\{\s*"config"\s*:/u);
  assert.ok(start >= 0, 'Playwright must emit its actual discovered suite');
  return JSON.parse(result.stdout.slice(start));
}
function cases(suite) {
  return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(cases)];
}
const ordinary = report(list());
const files = ordinary.suites.map(suite => suite.file.replaceAll('\\', '/'));
const ordinaryCases = cases(ordinary);
assert.ok(files.length > 30, 'The ordinary suite must retain broad coverage');
for (const name of ['auth-bootstrap.spec.ts', 'browser-lab.spec.ts', 'automationen.spec.ts',
  'collaboration-recovery.spec.ts', 'collaboration-release-recovery.spec.ts', 'shared-workspace-html-move.spec.ts',
  'studio-bulk-experimental.spec.ts', 'workspace-link-lifecycle.spec.ts', 'destination-folder-creation.spec.ts']) {
  assert.ok(files.some(file => file.endsWith(name)), `${name} must remain in ordinary discovery`);
}
for (const pattern of managedAcceptanceSelection(env).testIgnore) {
  const name = pattern.slice(3);
  assert.ok(!files.some(file => name.startsWith('*-') ? file.endsWith(name.slice(1)) : file.endsWith(name)),
    `Owned acceptance ${pattern} leaked into ordinary discovery`);
}
// Playwright's JSON reporter omits the leading @ from declared tags.
assert.ok(ordinaryCases.every(spec => !(spec.tags ?? []).some(tag =>
  ['owned-yjs', 'live-model', 'experimental-review'].includes(tag))));
const cold = ordinaryCases.filter(spec => spec.file.endsWith('notebook-query-loading.spec.ts'));
assert.equal(cold.length, 1, 'Keep the ordinary cold-document query test in this mixed suite');
assert.match(cold[0].title, /^cold document entry/u);
assert.ok(ordinaryCases.filter(spec => spec.file.endsWith('pi-chat.spec.ts')).length > 20,
  'Keep mocked PI chat coverage while isolating only the two real model turns');

// Discovery only: no private test body, fixture, server or model is executed,
// and this generated selection nonce is never used as an ownership receipt.
const batchFiles = ['workspace-operation-batches.spec.ts', 'workspace-operation-automatic.spec.ts',
  'workspace-path-operation-notifications.spec.ts'];
const batch = report(list(batchFiles.map(file => `tests/${file}`), { CANVAS_BATCH_E2E_RUN_ID: randomUUID() }));
for (const file of batchFiles) assert.ok(cases(batch).some(spec => spec.file.endsWith(file)),
  `The original batch runner must still discover ${file}`);
const ownedQueries = cases(report(list(['tests/notebook-query-loading.spec.ts'], { CANVAS_YJS_AUTHORITY_E2E: '1' })));
assert.equal(ownedQueries.length, 4);
assert.equal(ownedQueries.filter(spec => spec.tags.includes('owned-yjs')).length, 3);
const ownedCopyFiles = ['workspace-operation-copy-origin.spec.ts', 'workspace-operation-managed-scene-copy.spec.ts',
  'workspace-operation-native-copy.spec.ts'];
for (const file of ownedCopyFiles) {
  assert.ok(!ordinaryCases.some(spec => spec.file.endsWith(file)), `${file} requires the owned supervisor`);
}
const ownedCopies = cases(report(list(ownedCopyFiles.map(file => `tests/${file}`), { CANVAS_YJS_AUTHORITY_E2E: '1' })));
assert.equal(ownedCopies.length, 12, 'Keep all twelve owned Copy cases available to their original runner');
assert.ok(ownedCopies.every(spec => spec.tags.includes('owned-yjs')));

// Review Center is experimental and disabled in the regular deployment. Keep
// its original acceptance cases available through an explicit test opt-in.
const reviewFiles = ['workspace-operation-link-assessment.spec.ts', 'workspace-operation-notifications.spec.ts',
  'workspace-operation-review-toggle.spec.ts'];
for (const file of reviewFiles) {
  assert.ok(!ordinaryCases.some(spec => spec.file.endsWith(file)), `${file} requires experimental Review opt-in`);
}
const reviews = cases(report(list(reviewFiles.map(file => `tests/${file}`), { CANVAS_DOCUMENT_REVIEW_E2E: '1' })));
assert.equal(reviews.length, 4, 'Keep all four original experimental Review cases discoverable');
assert.ok(reviews.every(spec => spec.tags.includes('experimental-review')));
assert.equal(ordinaryCases.filter(spec => spec.file.endsWith('workspace-operation-notification-dismiss.spec.ts')).length, 2,
  'Keep ordinary persisted file-error notifications in regular acceptance');

// Explicit configs retain admission guards. The live model runner also refuses
// remote origins even after opt-in. Enumeration never contacts a provider.
for (const config of ['playwright.plugin-extensions.config.ts', 'playwright.yjs-authority.config.ts',
  'playwright.pi-chat-live.config.ts']) {
  const guarded = list(['--config', `tests/playwright/${config}`], {
    CANVAS_PLUGIN_EXTENSION_E2E: '', PLUGIN_EXTENSION_E2E_ROOT: '', PLUGIN_EXTENSION_E2E_FIXTURE: '',
  });
  assert.notEqual(guarded.status, 0, `${config} must reject an unowned or non-opted-in invocation`);
  const failure = guarded.stderr + guarded.stdout;
  if (config.includes('plugin-extensions')) assert.match(failure, /requires its isolated runner/u);
  else if (config.includes('pi-chat-live')) assert.match(failure, /requires its explicit production-mode loopback runner/u);
  else { assert.match(failure, /AssertionError/u); assert.match(failure, /playwright\.yjs-authority\.config\.ts/u); }
}
const liveEnvironment = { CANVAS_PI_CHAT_LIVE_E2E: '1', NODE_ENV: 'production', BASE_URL: 'http://127.0.0.1:3100' };
const live = cases(report(list(['--config', 'tests/playwright/playwright.pi-chat-live.config.ts'], liveEnvironment)));
assert.equal(live.length, 2);
assert.ok(live.every(spec => spec.tags.includes('live-model')));
const remote = list(['--config', 'tests/playwright/playwright.pi-chat-live.config.ts'],
  { ...liveEnvironment, BASE_URL: 'https://example.invalid' });
assert.notEqual(remote.status, 0);
assert.match(remote.stderr + remote.stdout, /requires its explicit production-mode loopback runner/u);
console.log(`Ordinary discovery retains ${files.length} files and ${ordinaryCases.length} cases; private runners remain guarded and discoverable`);
