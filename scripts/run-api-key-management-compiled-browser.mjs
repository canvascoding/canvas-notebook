import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  acceptanceOrigin, assertCompiledAcceptanceUnchanged, digest, git, loadCompiledAcceptance,
  redactAcceptanceText, repository, snapshotProtectedCompiledFixture,
} from './helpers/compiled-api-sdk-acceptance.mjs';

let context;
try { context = loadCompiledAcceptance(process.argv[2], process.argv[3]); }
catch (error) {
  console.error(JSON.stringify({ suite: 'compiled-api-key-management', passed: false, phase: 'preflight',
    errorType: error instanceof Error ? error.name : 'UnknownError' })); process.exit(1);
}
const prefix = path.join(context.root, 'api-key-management-browser-' + Date.now());
const testFile = path.join(repository, 'tests/acceptance/api-key-management.acceptance.ts');
const config = prefix + '-playwright.cjs', output = prefix + '-screens';
fs.writeFileSync(config, `const {defineConfig}=require(${JSON.stringify(path.join(repository, 'node_modules/@playwright/test'))});module.exports=defineConfig(${JSON.stringify({
  testDir: path.dirname(testFile), testMatch: path.basename(testFile), workers: 1, retries: 0,
  timeout: 120_000, fullyParallel: false, outputDir: output, reporter: [['json']],
  use: { baseURL: acceptanceOrigin, headless: true, trace: 'off', video: 'off', screenshot: 'off' },
})});\n`, { mode: 0o600, flag: 'wx' });
const proof = { sourceSha: context.sourceSha, treeSha: git('rev-parse', 'HEAD^{tree}'),
  runtimeProof: context.runtimePath, preservationFixture: context.fixturePath,
  imageId: context.container.Image, containerId: context.container.Id,
  testSourceSha256: digest(fs.readFileSync(testFile)), result: prefix + '-result.json',
  productSourceHashes: context.runtime.productSourceHashes, screenshots: output,
  report: prefix + '-playwright.json', stderr: prefix + '-stderr.log', retries: 0,
  trace: 'off', video: 'off', automaticFailureScreenshots: 'off',
  originalSnapshotBefore: prefix + '-original-before.json', originalSnapshotAfter: prefix + '-original-after.json',
  startedAt: new Date().toISOString(), passed: false };
const save = () => fs.writeFileSync(proof.result, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
let child, ended = false, outputExceeded = false, terminationTimer;
try {
  await snapshotProtectedCompiledFixture(context, proof.originalSnapshotBefore);
  save(); console.log(JSON.stringify({ phase: 'compiled-browser-started', sourceSha: context.sourceSha, result: proof.result }));
  let stdout = '', stderr = '', bytes = 0;
  const result = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(repository, 'node_modules/@playwright/test/cli.js'), 'test', '--config', config], {
      cwd: repository, env: { ...process.env, BASE_URL: acceptanceOrigin, E2E_EXTERNAL_SERVER: '1',
        CANVAS_COMPILED_API_BROWSER_RUN: '1', CANVAS_ACCEPTANCE_WORKSPACE_NAME: context.fixture.workspaceName,
        TEST_LOGIN_EMAIL: context.environment.BOOTSTRAP_ADMIN_EMAIL,
        TEST_LOGIN_PASSWORD: context.environment.BOOTSTRAP_ADMIN_PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proof.pid = child.pid; save();
    const retain = (chunk, append) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { outputExceeded = true; child.kill('SIGTERM'); }
      else append(chunk.toString('utf8'));
    };
    child.stdout.on('data', chunk => retain(chunk, value => { stdout += value; }));
    child.stderr.on('data', chunk => retain(chunk, value => { stderr += value; }));
    const timeout = setTimeout(() => {
      proof.deadlineExceeded = true; child.kill('SIGTERM');
      terminationTimer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 5000);
    }, 10 * 60_000);
    child.once('error', reject);
    child.once('close', (code, signal) => { ended = true; clearTimeout(timeout); clearTimeout(terminationTimer); resolve({ code, signal }); });
  });
  fs.writeFileSync(proof.report, redactAcceptanceText(stdout, context.sensitive), { mode: 0o600 });
  fs.writeFileSync(proof.stderr, redactAcceptanceText(stderr, context.sensitive), { mode: 0o600 });
  proof.exitCode = result.code; proof.signal = result.signal; assert(!outputExceeded && !proof.deadlineExceeded);
  const report = JSON.parse(stdout); proof.stats = report.stats;
  assert.equal(result.code, 0); assert.equal(report.stats.expected, 4);
  assert.equal(report.stats.unexpected, 0); assert.equal(report.stats.skipped, 0); assert.equal(report.stats.flaky, 0);
  proof.testsPassed = true;
} catch (error) {
  proof.errorType = error instanceof Error ? error.name : 'UnknownError'; process.exitCode = 1;
} finally {
  if (child && !ended) {
    child.kill('SIGTERM');
    for (let attempt = 0; !ended && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!ended) { child.kill('SIGKILL'); for (let attempt = 0; !ended && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  try {
    assert(!child || ended, 'Owned Playwright process did not close.');
    await snapshotProtectedCompiledFixture(context, proof.originalSnapshotAfter);
    assertCompiledAcceptanceUnchanged(context); assert.equal(digest(fs.readFileSync(testFile)), proof.testSourceSha256);
    proof.originalRowsXminBytesAndAnchorsPreserved = true;
  } catch (error) { proof.preservationErrorType = error instanceof Error ? error.name : 'UnknownError'; process.exitCode = 1; }
  proof.passed = proof.testsPassed === true && proof.originalRowsXminBytesAndAnchorsPreserved === true && process.exitCode !== 1;
  proof.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: proof.passed, stats: proof.stats, result: proof.result,
    errorType: proof.errorType, preservationErrorType: proof.preservationErrorType }));
  if (!proof.passed) process.exitCode = 1;
}
