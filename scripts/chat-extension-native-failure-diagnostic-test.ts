import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureNativeSearchFailureDiagnostics } from './helpers/chat-extension-native-failure-diagnostic';

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-extension-e2e-')));
  await fs.chmod(root, 0o700);
  const pin = { resourceRef: 'private-resource', publishedRevisionRef: 'private-published', checksum: 'private-checksum' };
  let cases = 0;
  try {
    const phases: string[] = [];
    const body = Buffer.from(JSON.stringify({ success: true, data: { operation: 'search', secret: 'PRIVATE_TOKEN', recents: [
      { bodyBundle: { primary: { selection: { kind: 'plugin', package: pin } } } },
      { bodyBundle: { primary: { selection: { kind: 'mcp', target: { connectionRef: 'PRIVATE_CONNECTION' } } } } },
    ] } }));
    const request = async (phase: 'local' | 'connected', timeoutMs: number) => {
      phases.push(phase); assert.equal(timeoutMs, 20_000);
      return { status: 200, serverTiming: 'extension;dur=42.2, recents;dur=18.0;desc="1 calls, 2 items", private_id;dur=8.0', bytes: body };
    };
    const input = { root, platform: 'ios' as const, failedPhase: 'chat' as const, expectedPackages: [pin], request };
    await captureNativeSearchFailureDiagnostics(input);
    assert.deepEqual(phases, ['local', 'connected']); cases++;
    const prefix = path.join(root, 'native-ios-chat-post-failure-search');
    const summaryBytes = await fs.readFile(`${prefix}-summary.json`, 'utf8'), summary = JSON.parse(summaryBytes);
    assert.equal(summary.originalResponse, false); assert.equal(summary.acceptanceEvidence, false); cases++;
    assert.equal(summary.classification, 'post_failure_probe');
    assert.deepEqual(summary.probes[0].recentsByKind, { plugin: 1, mcp: 1 });
    assert.equal(summary.probes[0].expectedPackages[0].recentPresent, true); cases++;
    assert.deepEqual(summary.probes[0].serverTiming, [{ stage: 'extension', milliseconds: 42.2 }, { stage: 'recents', milliseconds: 18 }]); cases++;
    for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_CONNECTION', pin.resourceRef, pin.publishedRevisionRef, pin.checksum, 'private_id']) {
      assert(!summaryBytes.includes(secret)); cases++;
    }
    const raw = JSON.parse(await fs.readFile(`${prefix}-local.response.json`, 'utf8'));
    assert(raw.bodyUtf8.includes('PRIVATE_TOKEN')); cases++;
    for (const name of await fs.readdir(root)) { assert.equal((await fs.stat(path.join(root, name))).mode & 0o777, 0o600); cases++; }
    await captureNativeSearchFailureDiagnostics(input); assert.equal(phases.length, 2); cases++;
    await captureNativeSearchFailureDiagnostics({ ...input, platform: 'android', timeoutMs: 5,
      request: async () => new Promise(() => {}) });
    const timed = JSON.parse(await fs.readFile(path.join(root, 'native-android-chat-post-failure-search-summary.json'), 'utf8'));
    assert.deepEqual(timed.probes.map((probe: { errorCode: string }) => probe.errorCode), ['TIMEOUT', 'TIMEOUT']); cases++;
    const failedRoot = path.join(root, 'canvas-plugin-extension-e2e-failure'); await fs.mkdir(failedRoot, { mode: 0o700 });
    await captureNativeSearchFailureDiagnostics({ ...input, root: failedRoot, request: async () => {
      throw new Error('PRIVATE_UPSTREAM_ERROR');
    } });
    const failed = await fs.readFile(path.join(failedRoot, 'native-ios-chat-post-failure-search-summary.json'), 'utf8');
    assert(!failed.includes('PRIVATE_UPSTREAM_ERROR')); assert.equal(JSON.parse(failed).probes.length, 2); cases++;
    const oversizedRoot = path.join(root, 'canvas-plugin-extension-e2e-oversized'); await fs.mkdir(oversizedRoot, { mode: 0o700 });
    await captureNativeSearchFailureDiagnostics({ ...input, root: oversizedRoot, request: async () => ({
      status: 200, serverTiming: null, bytes: Buffer.alloc(4 * 1024 * 1024 + 1, 'x') }) });
    const oversized = JSON.parse(await fs.readFile(path.join(oversizedRoot, 'native-ios-chat-post-failure-search-local.response.json'), 'utf8'));
    assert.equal(oversized.oversized, true); assert.equal(oversized.bodyUtf8, undefined); cases++;
    for (const failedPhase of ['agent-create', 'agent-edit', 'agent-package-policy', 'my-connection'] as const) {
      await captureNativeSearchFailureDiagnostics({ ...input, failedPhase, request: async () => { assert.fail('No current Chat target for this Native phase.'); } });
      const skipped = JSON.parse(await fs.readFile(path.join(root, `native-ios-${failedPhase}-post-failure-search-summary.json`), 'utf8'));
      assert.equal(skipped.status, 'not_applicable'); assert.deepEqual(skipped.probes, []); cases++;
    }
    await fs.chmod(root, 0o755);
    await assert.rejects(captureNativeSearchFailureDiagnostics({ ...input, failedPhase: 'agent-create' })); cases++;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log(`Native post-failure search diagnostics passed (${cases} cases).`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
