import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

type SearchPhase = 'local' | 'connected';
type PackagePin = { resourceRef: string; publishedRevisionRef: string; checksum: string };
type ProbeResponse = { status: number; serverTiming: string | null; bytes: Uint8Array };
const maxBytes = 4 * 1024 * 1024;
const timingStages = new Set(['extension', 'context', 'packages', 'store', 'composio', 'mcp', 'revalidate', 'projection',
  'recents', 'preview', 'catalog', 'package_source', 'artifact_resolve', 'icon']);

/** A bounded follow-up probe, never the original failed response or an acceptance receipt. */
export async function captureNativeSearchFailureDiagnostics(input: {
  root: string; platform: 'ios' | 'android'; failedPhase: 'chat' | 'agent-create' | 'agent-edit' | 'agent-package-policy' | 'my-connection';
  expectedPackages: PackagePin[]; request: (phase: SearchPhase, timeoutMs: number) => Promise<ProbeResponse>; timeoutMs?: number;
}): Promise<void> {
  const root = await fs.realpath(input.root), stat = await fs.lstat(input.root);
  assert(root === input.root && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
    && (stat.mode & 0o777) === 0o700 && /^canvas-plugin-extension-e2e-[A-Za-z0-9]+$/u.test(path.basename(root)));
  assert(['ios', 'android'].includes(input.platform));
  assert(['chat', 'agent-create', 'agent-edit', 'agent-package-policy', 'my-connection'].includes(input.failedPhase));
  const timeoutMs = input.timeoutMs ?? 20_000;
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 20_000);
  const prefix = path.join(root, `native-${input.platform}-${input.failedPhase}-post-failure-search`);
  const marker = { version: 1, classification: 'post_failure_probe', originalResponse: false, acceptanceEvidence: false };
  try { await fs.writeFile(`${prefix}.started.json`, JSON.stringify(marker), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  if (input.failedPhase !== 'chat') {
    await fs.writeFile(`${prefix}-summary.json`, JSON.stringify({ ...marker, platform: input.platform, failedNativePhase: input.failedPhase,
      status: 'not_applicable', reason: 'CHAT_TARGET_NOT_CURRENT_FOR_NATIVE_PHASE', probes: [] }), { mode: 0o600, flag: 'wx' });
    return;
  }
  const pinHash = (value: unknown): string | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const pin = value as Partial<PackagePin>;
    if (typeof pin.resourceRef !== 'string' || typeof pin.publishedRevisionRef !== 'string' || typeof pin.checksum !== 'string') return null;
    return createHash('sha256').update(JSON.stringify({ resourceRef: pin.resourceRef, publishedRevisionRef: pin.publishedRevisionRef, checksum: pin.checksum })).digest('hex');
  };
  const expected = input.expectedPackages.map(pinHash); assert(expected.every(Boolean));
  const probes: Record<string, unknown>[] = [];
  for (const phase of ['local', 'connected'] as const) {
    const started = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([input.request(phase, timeoutMs), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { const error = new Error('Bounded diagnostic timeout.'); error.name = 'TimeoutError'; reject(error); }, timeoutMs);
      })]);
      assert(Number.isInteger(result.status) && result.status >= 100 && result.status <= 599);
      const bytes = Buffer.from(result.bytes), oversized = bytes.byteLength > maxBytes;
      const rawPath = `${prefix}-${phase}.response.json`;
      // A private response can contain identity and opaque references. Never copy it into public evidence.
      await fs.writeFile(rawPath, JSON.stringify({ ...marker, phase, httpStatus: result.status, serverTiming: result.serverTiming,
        oversized, ...(oversized ? {} : { bodyUtf8: bytes.toString('utf8') }) }), { mode: 0o600, flag: 'wx' });
      const timing = (result.serverTiming ?? '').split(/,\s*(?=[a-z_]+;dur=)/u).flatMap(value => {
        const match = /^\s*([a-z_]+);dur=(\d+(?:\.\d+)?)(?:;desc="\d+ calls, \d+ items")?\s*$/u.exec(value);
        return match && timingStages.has(match[1]) ? [{ stage: match[1], milliseconds: Number(match[2]) }] : [];
      });
      let parsed: unknown;
      if (!oversized) { try { parsed = JSON.parse(bytes.toString('utf8')); } catch { /* Raw bytes remain private. */ } }
      const envelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {};
      const recents = Array.isArray(data.recents) ? data.recents : [];
      const packageHashes: string[] = [], kinds: Record<string, number> = {};
      for (const recent of recents) {
        const selection = recent?.bodyBundle?.primary?.selection;
        if (!selection || !['plugin', 'skill', 'mcp', 'composio'].includes(selection.kind)) continue;
        kinds[selection.kind] = (kinds[selection.kind] ?? 0) + 1;
        const digest = pinHash(selection.package); if (digest) packageHashes.push(digest);
      }
      probes.push({ phase, status: 'response', httpStatus: result.status, durationMs: Math.round(performance.now() - started),
        serverTiming: timing, responseBytes: bytes.byteLength, responseSha256: createHash('sha256').update(bytes).digest('hex'), oversized,
        success: envelope.success === true, operation: data.operation === 'search' ? 'search' : null,
        recentsByKind: kinds, expectedPackages: expected.map(digest => ({ sha256: digest, recentPresent: packageHashes.includes(digest!) })) });
    } catch (error) {
      probes.push({ phase, status: 'error', durationMs: Math.round(performance.now() - started),
        errorCode: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'REQUEST_OR_CAPTURE_FAILED' });
    } finally { if (timer) clearTimeout(timer); }
  }
  await fs.writeFile(`${prefix}-summary.json`, JSON.stringify({ ...marker, platform: input.platform, failedNativePhase: input.failedPhase,
    probes }), { mode: 0o600, flag: 'wx' });
}
