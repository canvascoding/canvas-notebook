import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NextRequest } from 'next/server';

import {
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  parseFileVersionCenterErrorResponseV1,
} from '../app/lib/file-version-center/contracts/v1';
import {
  setFileVersionCenterMetricAdapter,
} from '../app/lib/file-version-center/observability';
import {
  applyFileVersionCenterRateLimit,
  fileVersionCenterCaughtError,
  readFileVersionCenterJson,
} from '../app/lib/file-version-center/route-adapter';
import { runWithRequestIdentity } from '../app/lib/security/request-identity';
import { dualRateLimit } from '../app/lib/utils/rate-limit';

function withIdentity<T>(clientAddress: string, run: (request: NextRequest) => T): T {
  const incoming = {
    socket: { remoteAddress: clientAddress },
    headers: {
      'x-forwarded-for': '198.51.100.250',
      'x-real-ip': '198.51.100.251',
    },
  } as unknown as IncomingMessage;
  return runWithRequestIdentity(incoming, () => run(new NextRequest(
    'https://canvas.test/api/files/version-center/v1/timeline',
    { headers: incoming.headers as Record<string, string> },
  )));
}

function limited(clientAddress: string, userId: string, input: {
  prefix: string;
  perUserLimit: number;
  perIpLimit: number;
}) {
  return withIdentity(clientAddress, (request) => dualRateLimit(request, {
    keyPrefix: input.prefix,
    windowMs: 60_000,
    perUserLimit: input.perUserLimit,
    perIpLimit: input.perIpLimit,
    verifiedUserId: userId,
  }));
}

async function testDualRateLimits(): Promise<void> {
  const userPrefix = `fvrc-user-${randomUUID()}`;
  assert.equal(limited('203.0.113.1', 'alice', {
    prefix: userPrefix, perUserLimit: 1, perIpLimit: 10,
  }).ok, true);
  assert.equal(limited('203.0.113.2', 'alice', {
    prefix: userPrefix, perUserLimit: 1, perIpLimit: 10,
  }).ok, false, 'rotating the transport address must not renew an authenticated-user budget');

  const ipPrefix = `fvrc-ip-${randomUUID()}`;
  for (const userId of ['alice', 'bob']) {
    assert.equal(limited('203.0.113.3', userId, {
      prefix: ipPrefix, perUserLimit: 10, perIpLimit: 2,
    }).ok, true);
  }
  const sharedIp = limited('203.0.113.3', 'charlie', {
    prefix: ipPrefix, perUserLimit: 10, perIpLimit: 2,
  });
  assert.equal(sharedIp.ok, false, 'rotating authenticated users must not renew an IP budget');
  if (!sharedIp.ok) assert.ok(Number(sharedIp.response.headers.get('retry-after')) > 0);

  const responses = withIdentity('203.0.113.4', (request) => [
    applyFileVersionCenterRateLimit(request, {
      operation: 'timeline',
      verifiedUserId: 'alice',
      rate: { perUserPerMinute: 1, perIpPerMinute: 10 },
    }),
    applyFileVersionCenterRateLimit(request, {
      operation: 'timeline',
      verifiedUserId: 'alice',
      rate: { perUserPerMinute: 1, perIpPerMinute: 10 },
    }),
  ]);
  assert.equal(responses[0], null);
  assert.equal(responses[1]?.status, 429);
  assert.equal(responses[1]?.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.ok(Number(responses[1]?.headers.get('retry-after')) > 0);
  assert.equal(
    parseFileVersionCenterErrorResponseV1(await responses[1]!.json()).error.code,
    FILE_VERSION_CENTER_ERROR_CODES.rateLimited,
  );
}

async function testBoundedBodies(): Promise<void> {
  const declared = new NextRequest('https://canvas.test/api/files/version-center/v1/resolve', {
    method: 'POST',
    headers: { 'content-length': String((512 * 1_024) + 1) },
    body: '{}',
  });
  await assert.rejects(
    () => readFileVersionCenterJson(declared),
    (error) => error instanceof FileVersionCenterContractError
      && error.code === FILE_VERSION_CENTER_ERROR_CODES.payloadTooLarge,
  );
  const oversizedResponse = fileVersionCenterCaughtError(new FileVersionCenterContractError(
    FILE_VERSION_CENTER_ERROR_CODES.payloadTooLarge,
    'The file version center request exceeds the transport limit.',
  ));
  assert.equal(oversizedResponse.status, 413);
  assert.equal(oversizedResponse.headers.get('cache-control'), 'private, no-store, max-age=0');

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(400 * 1_024));
      controller.enqueue(new Uint8Array(120 * 1_024));
    },
    cancel() { cancelled = true; },
  });
  const streamed = new NextRequest(new Request('https://canvas.test/api/files/version-center/v1/compare', {
    method: 'POST', body: stream, duplex: 'half',
  } as RequestInit));
  await assert.rejects(
    () => readFileVersionCenterJson(streamed),
    (error) => error instanceof FileVersionCenterContractError
      && error.code === FILE_VERSION_CENTER_ERROR_CODES.payloadTooLarge,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true, 'oversized streaming bodies are cancelled for backpressure');

  const malformed = new NextRequest('https://canvas.test/api/files/version-center/v1/policy', {
    method: 'POST', body: '{"contractVersion":',
  });
  await assert.rejects(
    () => readFileVersionCenterJson(malformed),
    (error) => error instanceof FileVersionCenterContractError
      && error.code === FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
  );
}

async function testRedactedObservability(): Promise<void> {
  const logs: string[] = [];
  const metrics: Array<{ name: string; value?: number; labels: Readonly<Record<string, string>> }> = [];
  const priorInfo = console.info;
  console.info = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  setFileVersionCenterMetricAdapter({
    increment: (name, labels) => { metrics.push({ name, labels }); },
    observe: (name, value, labels) => { metrics.push({ name, value, labels }); },
  });
  try {
    const response = fileVersionCenterCaughtError(
      new Error('secret document body at /private/workspace/notes.md'),
      { operation: 'compare', startedAt: Date.now() - 5 },
    );
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret|private|notes\.md/iu);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0] ?? '', /secret|private|notes\.md|stack/iu);
    const event = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), [
      'component', 'durationMs', 'errorCode', 'operation', 'outcome', 'version',
    ]);
    assert.equal(event.errorCode, FILE_VERSION_CENTER_ERROR_CODES.internal);
    assert.ok(metrics.some((metric) => metric.name === 'file_version_center_requests_total'));
    assert.ok(metrics.some((metric) => metric.name === 'file_version_center_request_duration_ms'));
    assert.doesNotMatch(JSON.stringify(metrics), /secret|private|notes\.md/iu);
  } finally {
    setFileVersionCenterMetricAdapter(undefined);
    console.info = priorInfo;
  }
}

async function main(): Promise<void> {
  await testDualRateLimits();
  await testBoundedBodies();
  await testRedactedObservability();
  console.log('file-version-center-hardening-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
