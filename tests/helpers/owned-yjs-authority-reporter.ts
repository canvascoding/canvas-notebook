import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { writePrivateJson, type OwnedYjsBrowserReport } from '../../scripts/lib/owned-yjs-authority-qa';

/** Numeric outcomes only: no assertion payloads, credentials, cookies or traces. */
export default class OwnedYjsAuthorityReporter implements Reporter {
  private readonly report: OwnedYjsBrowserReport = { version: 1, status: 'unconfirmed', declared: 0,
    passed: 0, failed: 0, skipped: 0, timedOut: 0, interrupted: 0 };
  onBegin(_config: unknown, suite: Suite): void { this.report.declared = suite.allTests().length; }
  onTestEnd(_test: TestCase, result: TestResult): void { this.report[result.status] += 1; }
  async onEnd(result: FullResult): Promise<void> {
    if (process.argv.includes('--list')) return; // Collection never produces a runtime acceptance receipt.
    assert.equal(process.env.CANVAS_YJS_AUTHORITY_E2E, '1');
    const root = process.env.CANVAS_YJS_QA_RESULTS ?? '', output = process.env.CANVAS_YJS_QA_REPORT ?? '';
    assert(path.isAbsolute(root) && output === path.join(root, 'browser-outcome.json'));
    const current = await fs.lstat(root);
    assert(current.isDirectory() && !current.isSymbolicLink() && current.uid === process.getuid?.() && (current.mode & 0o777) === 0o700);
    assert.equal(await fs.realpath(root), root);
    this.report.status = result.status;
    await writePrivateJson(output, this.report, true);
  }
}
