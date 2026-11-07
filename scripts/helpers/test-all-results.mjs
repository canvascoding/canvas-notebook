import { regularCollaborationFiles, deferredReviewAndUndoFiles } from '../../tests/helpers/regular-collaboration-suites.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { managedAcceptanceSelection } from '../../tests/helpers/managed-acceptance-suites.mjs';

// Each leaf runs once. Aggregates remain available for focused development.
export const independentTestScripts = [
  'test:browser:environment:unit', 'test:browser:context', 'test:browser:discovery',
  'test:browser:server', 'test:browser:runtime',
  'test:server:shutdown:ownership', 'test:server:shutdown:coordinator', 'test:server:shutdown:checkout',
  'test:internal:scheduler', 'test:cli:portable',
  'test:api-keys:json', 'test:api-keys:management', 'test:api-keys:authentication',
  'test:api-keys:ui', 'test:api-keys:proxy', 'test:api-keys:errors',
  'test:collaboration:diagnostic-cause', 'test:api-keys:compiled:harness:node',
  'test:api-keys:compiled:harness:journal', 'test:prompt-builder', 'test:collaboration:regular:contracts',
  'test:notebook:tabs', 'test:notebook:location-lifecycle', 'test:notebook:delete-events',
  'test:collaboration:retention-policy', 'test:collaboration:live-tabs',
];
export const serverTestScripts = ['test:smoke', 'test:integration', 'test:integration:pi'];
export const testAllPhaseIds = ['configuration', ...independentTestScripts, 'build', 'server-start',
  'server-health', ...serverTestScripts, 'playwright', 'playwright-collaboration', 'server-lifetime', 'cleanup'];
const statuses = ['passed', 'failed', 'skipped', 'blocked'];
const countsFor = rows => Object.fromEntries(statuses.map(status => [status, rows.filter(row => row.status === status).length]));

export async function readPlaywrightResults(filename) {
  const report = JSON.parse(await readFile(filename, 'utf8'));
  if (!Array.isArray(report.suites) || !report.stats || !Array.isArray(report.errors)) {
    throw new Error('Playwright did not produce a complete JSON report');
  }
  const tests = [];
  function visit(suite, parents = []) {
    const titles = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const last = test.results?.at(-1);
      let status;
      if (test.expectedStatus === 'skipped' || (test.annotations ?? []).some(annotation => ['skip', 'fixme'].includes(annotation.type))) status = 'skipped';
      else if (test.status === 'skipped' || !last || last.status === 'interrupted') status = 'blocked';
      else status = ['expected', 'flaky'].includes(test.status) ? 'passed' : 'failed';
      tests.push({ title: [...titles, spec.title].join(' › '), file: spec.file, line: spec.line,
        project: test.projectName, status, expectedStatus: test.expectedStatus,
        actualStatus: last?.status, flaky: test.status === 'flaky',
        annotations: test.annotations ?? [],
        errors: (test.results ?? []).flatMap(result => result.errors ?? []).map(error => error.message ?? error.value ?? 'Test error') });
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  for (const suite of report.suites) visit(suite);
  if (tests.length === 0 && report.errors.length === 0) throw new Error('Playwright discovered zero tests');
  return { counts: countsFor(tests), tests, errors: report.errors, source: filename };
}

export async function createTestAllReport(environment = process.env) {
  const directory = environment.TEST_ALL_REPORT_DIR
    ? path.resolve(environment.TEST_ALL_REPORT_DIR)
    : await mkdtemp(path.join(os.tmpdir(), 'canvas-test-all-report-'));
  if (environment.TEST_ALL_REPORT_DIR) await mkdir(directory, { mode: 0o700 });
  const secretValues = Object.entries(environment)
    .filter(([key, value]) => /PASSWORD|SECRET|TOKEN|API_KEY/u.test(key) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value);
  const redact = text => secretValues.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), String(text));
  let revision = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim(); } catch { /* Temporary orchestration fixtures need no Git checkout. */ }
  const runnerHash = createHash('sha256').update(await readFile(new URL('../test-all.mjs', import.meta.url))).digest('hex');
  const selection = managedAcceptanceSelection(environment);
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), finishedAt: null,
    revision, runnerSha256: runnerHash, status: 'running',
    scope: 'Regular test:all plan; does not enumerate every npm test script or private acceptance profile.',
    selection: { excludedFiles: selection.testIgnore.filter(file => !regularCollaborationFiles.some(name => file === '**/' + name)),
      requiredCollaborationFiles: regularCollaborationFiles, deferredReviewAndUndoFiles, excludedTags: selection.grepInvert?.source ?? null,
      note: 'Excluded suites are not discovered tests and are not counted as passed or skipped test cases.' },
    stages: testAllPhaseIds.map(id => ({ id, status: 'pending' })), browser: null };
  const filename = path.join(directory, 'results.json');
  const save = async () => {
    report.stageCounts = countsFor(report.stages);
    const temporary = path.join(directory, '.results-' + randomBytes(6).toString('hex'));
    await writeFile(temporary, redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  };
  const update = async (id, patch) => {
    const row = report.stages.find(stage => stage.id === id);
    if (!row) throw new Error('Unknown test:all stage');
    Object.assign(row, patch); await save();
  };
  const finish = async () => {
    for (const stage of report.stages) if (['pending', 'running'].includes(stage.status)) {
      Object.assign(stage, { status: 'blocked', reason: 'Runner ended before this stage could complete.' });
    }
    report.finishedAt = new Date().toISOString();
    report.status = report.stages.some(stage => ['failed', 'blocked'].includes(stage.status)) ? 'failed' : 'passed';
    await save();
    const lines = ['# test:all results', '', `Overall: **${report.status}**`, '',
      '| Stage | Result | Reason / log |', '| --- | --- | --- |',
      ...report.stages.map(stage => `| ${stage.id} | ${stage.status} | ${String(stage.reason ?? stage.log ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')} |`),
      '', 'Stage totals: ' + JSON.stringify(report.stageCounts), '',
      ...(report.browser ? ['Browser test cases: ' + JSON.stringify(report.browser.counts), '',
        ...report.browser.tests.filter(test => test.status !== 'passed').map(test =>
          `- **${test.status}** ${test.file}:${test.line} ${test.title}: ${test.annotations.filter(a => ['skip', 'fixme'].includes(a.type)).map(a => a.description).join('; ') || test.errors[0] || test.actualStatus || 'Not executed'}`), ''] : []),
      'Excluded acceptance profiles are listed in results.json; they are not counted as passing tests.', ''];
    await writeFile(path.join(directory, 'summary.md'), redact(lines.join('\n')), { mode: 0o600, flag: 'wx' });
    console.log('\n[test:all] Results (stages, not individual assertions):');
    for (const stage of report.stages) console.log(`  ${stage.status.toUpperCase().padEnd(7)} ${stage.id}${stage.reason ? ': ' + redact(stage.reason) : ''}`);
    console.log('[test:all] Stage totals: ' + JSON.stringify(report.stageCounts));
    if (report.browser) console.log('[test:all] Browser test cases: ' + JSON.stringify(report.browser.counts));
    console.log('[test:all] Report: ' + filename);
    return report.status === 'passed';
  };
  await save();
  return { directory, filename, report, update, save, finish };
}
