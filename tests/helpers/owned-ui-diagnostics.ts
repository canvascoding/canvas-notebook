import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, Response, ConsoleMessage, TestInfo } from '@playwright/test';
import { assertOrigin, assertOwnedRoot, privateBytes, redactBoundedOutput, writePrivateJson,
  type OwnedYjsReceipt } from '../../scripts/lib/owned-yjs-authority-qa';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const kind = (value: unknown) => value === null ? 'null' : typeof value;
const token = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(value) ? value : undefined;

/** Shape and whitelisted file metadata only; never response content or credentials. */
export function summarizeDiagnosticResponse(payload: unknown) {
  const body = object(payload), data = object(body.data), stats = object(data.stats);
  const collaboration = object(data.collaboration), document = object(collaboration.document), native = object(data.nativeSource);
  const modified = stats.modified;
  return {
    success: typeof body.success === 'boolean' ? body.success : undefined,
    code: token(body.code), validationCode: token(body.validationCode),
    contentKind: kind(data.content), contentCharacters: typeof data.content === 'string' ? data.content.length : undefined,
    contentUnavailable: typeof data.contentUnavailable === 'boolean' ? data.contentUnavailable : undefined,
    stats: { sizeKind: kind(stats.size), size: typeof stats.size === 'number' && Number.isFinite(stats.size) ? stats.size : undefined,
      modifiedKind: kind(modified), modified: typeof modified === 'number' && Number.isFinite(modified) ? modified
        : typeof modified === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(modified) ? modified : undefined,
      permissionsKind: kind(stats.permissions) },
    collaboration: { strategy: token(collaboration.strategy), provider: token(document.provider),
      crdtCapable: typeof collaboration.crdtCapable === 'boolean' ? collaboration.crdtCapable : undefined },
    nativeSource: token(native.source), representation: token(body.representation), permission: token(body.permission),
    lifecycleGeneration: typeof body.lifecycleGeneration === 'number' ? body.lifecycleGeneration : undefined,
  };
}

export function redactDiagnosticText(value: string, secrets: string[] = []) {
  return redactBoundedOutput(value.replace(/((?:["']?)(?:password|secret|token|authorization|cookie|code_verifier)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;\r\n]+)/giu,
    '$1[redacted]'), secrets, 4096);
}

export class BoundedUiObservations {
  readonly events: Array<Record<string, unknown>> = [];
  dropped = 0;
  private bytes = 0;
  add(event: Record<string, unknown>) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.events.length >= 96 || this.bytes + bytes > 128 * 1024) { this.dropped += 1; return; }
    this.events.push(event); this.bytes += bytes;
  }
}

/** Passive listeners only. Every context must be observed before navigation. */
export class OwnedUiDiagnostics {
  private readonly observations = new BoundedUiObservations();
  private readonly pending = new Set<Promise<void>>();
  private readonly detach: Array<() => void> = [];
  private readonly secrets = Object.entries(process.env).filter(([key]) => /PASSWORD|SECRET|TOKEN|COOKIE|DATABASE_URL|MASTER_KEY/u.test(key))
    .map(([, value]) => value).filter((value): value is string => Boolean(value));
  private readonly origin = assertOrigin(process.env.BASE_URL ?? '').origin;

  observe(page: Page, label: 'owner' | 'peer' | 'fresh') {
    assert.equal(process.env.CANVAS_YJS_AUTHORITY_E2E, '1');
    const pageerror = (error: Error) => this.observations.add({ type: 'pageerror', label,
      name: redactDiagnosticText(error.name, this.secrets), message: redactDiagnosticText(error.message, this.secrets),
      stack: redactDiagnosticText(error.stack ?? '', this.secrets) });
    const consoleEvent = (message: ConsoleMessage) => {
      if (!['error', 'warning'].includes(message.type())) return;
      this.observations.add({ type: 'console', label, level: message.type(), text: redactDiagnosticText(message.text(), this.secrets) });
    };
    const response = (received: Response) => {
      const url = new URL(received.url());
      if (url.origin !== this.origin || !['/api/files/read', '/api/files/create', '/api/files/collaboration/session'].includes(url.pathname)) return;
      const read = this.responseMetadata(received, label, url.pathname).catch(() => {
        this.observations.add({ type: 'http-body-unavailable', label, pathname: url.pathname, status: received.status() });
      });
      this.pending.add(read); void read.finally(() => this.pending.delete(read));
    };
    page.on('pageerror', pageerror); page.on('console', consoleEvent); page.on('response', response);
    this.detach.push(() => { page.off('pageerror', pageerror); page.off('console', consoleEvent); page.off('response', response); });
  }

  private async responseMetadata(response: Response, label: string, pathname: string) {
    const base = { type: 'http', label, pathname, method: response.request().method(), status: response.status() };
    const declared = Number(response.headers()['content-length']);
    if (Number.isFinite(declared) && declared > 128 * 1024) {
      this.observations.add({ ...base, bodySummary: 'too-large' }); return;
    }
    const body = await response.body();
    if (body.length > 128 * 1024) { this.observations.add({ ...base, bodySummary: 'too-large' }); return; }
    try { this.observations.add({ ...base, fields: summarizeDiagnosticResponse(JSON.parse(body.toString('utf8'))) }); }
    catch { this.observations.add({ ...base, bodySummary: 'not-json' }); }
  }

  async flush(info: TestInfo) {
    this.detach.forEach(detach => detach());
    await Promise.allSettled([...this.pending]);
    const receipt = JSON.parse((await privateBytes(process.env.CANVAS_YJS_QA_RECEIPT ?? '')).toString()) as OwnedYjsReceipt;
    await assertOwnedRoot(receipt);
    assert.equal(receipt.nonce, process.env.CANVAS_YJS_QA_NONCE);
    const file = info.outputPath('owned-ui-observations.json');
    const relative = path.relative(path.join(receipt.fixtureRoot, 'results'), file);
    assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    assert.equal(await fs.realpath(path.dirname(file)), path.dirname(file));
    await writePrivateJson(file, { version: 1, observations: this.observations.events, dropped: this.observations.dropped }, true);
    await info.attach('owned-ui-observations', { path: file, contentType: 'application/json' });
  }
}
