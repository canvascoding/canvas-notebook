import assert from 'node:assert/strict';
import { unstable_doesMiddlewareMatch } from 'next/dist/experimental/testing/server/middleware-testing-utils';

import {
  EmailAiRequestBodyError,
  emailAiRequestBodyErrorStatus,
  readEmailAiJsonObject,
} from '../app/lib/email/ai-request-body';
import { config as proxyConfig } from '../proxy';

type StreamMetrics = {
  cancelCount: number;
  pullCount: number;
};

type StreamRequest = {
  metrics: StreamMetrics;
  request: Request;
};

const encoder = new TextEncoder();

function requestFromChunks(
  chunks: Uint8Array[],
  headers?: HeadersInit,
): StreamRequest {
  const metrics: StreamMetrics = { cancelCount: 0, pullCount: 0 };
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      metrics.pullCount += 1;
      const chunk = chunks[index];
      index += 1;
      if (chunk) {
        controller.enqueue(chunk);
        return;
      }
      controller.close();
    },
    cancel() {
      metrics.cancelCount += 1;
    },
  }, {
    // Prevent eager prefetch so the oversized Content-Length test can prove
    // that the production reader rejects before pulling the request stream.
    highWaterMark: 0,
  });

  const request = new Request('http://localhost:3000/api/email/compose/ai', {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { metrics, request };
}

async function expectRequestBodyError(
  promise: Promise<unknown>,
  expected: { code: EmailAiRequestBodyError['code']; status: 400 | 413 },
): Promise<EmailAiRequestBodyError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof EmailAiRequestBodyError, 'Expected EmailAiRequestBodyError.');
  assert.equal(thrown.code, expected.code);
  assert.equal(thrown.status, expected.status);
  assert.equal(emailAiRequestBodyErrorStatus(thrown), expected.status);
  return thrown;
}

async function testChunkedBodyWithoutContentLengthIsCanceled() {
  const streamed = requestFromChunks([
    encoder.encode('{"value":'),
    encoder.encode('"this crosses the byte limit"}'),
  ]);
  assert.equal(streamed.request.headers.has('content-length'), false);

  await expectRequestBodyError(
    readEmailAiJsonObject(streamed.request, 12),
    { code: 'too_large', status: 413 },
  );
  assert.equal(streamed.metrics.pullCount, 2);
  assert.equal(streamed.metrics.cancelCount, 1, 'Oversized chunked body must cancel its reader.');
}

async function testLiedSmallContentLengthStillUsesRealBytes() {
  const streamed = requestFromChunks([
    encoder.encode('{"value":'),
    encoder.encode('"larger than advertised"}'),
  ], {
    'Content-Length': '2',
    'Content-Type': 'application/json',
  });

  await expectRequestBodyError(
    readEmailAiJsonObject(streamed.request, 16),
    { code: 'too_large', status: 413 },
  );
  assert.ok(streamed.metrics.pullCount >= 2);
  assert.equal(streamed.metrics.cancelCount, 1);
}

async function testOversizedHeaderRejectsBeforeStreamPull() {
  const streamed = requestFromChunks([encoder.encode('{"ok":true}')], {
    'Content-Length': '1025',
    'Content-Type': 'application/json',
  });
  assert.equal(streamed.metrics.pullCount, 0);

  await expectRequestBodyError(
    readEmailAiJsonObject(streamed.request, 1024),
    { code: 'too_large', status: 413 },
  );
  assert.equal(streamed.metrics.pullCount, 0, 'Oversized advertised length must reject before reading.');
  assert.equal(streamed.metrics.cancelCount, 0);
}

async function testMultibyteUtf8WithinLimit() {
  const payload = {
    greeting: 'Grüße 👋',
    subject: '東京からの更新',
  };
  const rawJson = JSON.stringify(payload);
  const encoded = encoder.encode(rawJson);
  assert.ok(encoded.byteLength > rawJson.length, 'Fixture must contain multibyte UTF-8.');

  // One-byte chunks deliberately split every multibyte code point.
  const chunks = Array.from(encoded, (_byte, index) => encoded.subarray(index, index + 1));
  const streamed = requestFromChunks(chunks, { 'Content-Type': 'application/json' });
  const parsed = await readEmailAiJsonObject(streamed.request, encoded.byteLength);

  assert.deepEqual(parsed, payload);
  assert.equal(streamed.metrics.cancelCount, 0);
}

async function testMalformedAndInvalidUtf8Return400() {
  const malformed = requestFromChunks([encoder.encode('{"unfinished":')]);
  await expectRequestBodyError(
    readEmailAiJsonObject(malformed.request, 128),
    { code: 'invalid_json', status: 400 },
  );

  const invalidUtf8 = requestFromChunks([
    new Uint8Array([
      0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x22, 0x3a, 0x22,
      0xc3, 0x28,
      0x22, 0x7d,
    ]),
  ]);
  await expectRequestBodyError(
    readEmailAiJsonObject(invalidUtf8.request, 128),
    { code: 'invalid_json', status: 400 },
  );
}

async function testArraysAndScalarsReturn400() {
  for (const rawJson of ['[]', '"scalar"', '42', 'true', 'null']) {
    const streamed = requestFromChunks([encoder.encode(rawJson)]);
    await expectRequestBodyError(
      readEmailAiJsonObject(streamed.request, 128),
      { code: 'invalid_shape', status: 400 },
    );
  }
}

function testEmailAiRoutesBypassProxyBodyBuffer() {
  const proxyMatches = (pathname: string) => unstable_doesMiddlewareMatch({
    config: proxyConfig,
    url: `http://localhost:3000${pathname}`,
  });

  for (const pathname of [
    '/api/email/compose/ai',
    '/api/email/compose/agent?stream=1',
    '/api/email/accounts/account-1/messages/actions',
    '/api/email/accounts/account-1/messages/message-1/summary',
    '/api/email/accounts/account-1/messages/message-1/ai-reply',
  ]) {
    assert.equal(proxyMatches(pathname), false, `${pathname} must bypass the proxy body clone.`);
  }

  for (const pathname of [
    '/api/email/compose/aix',
    '/api/email/accounts/account-1/messages/actions-extra',
    '/api/email/accounts/account-1/messages/message-1/summary-extra',
    '/api/email/accounts/account-1/messages/message-1/draft',
    '/api/email/send',
    '/api/sessions',
    '/en/chat',
  ]) {
    assert.equal(proxyMatches(pathname), true, `${pathname} must retain normal proxy protection.`);
  }
}

async function main() {
  await testChunkedBodyWithoutContentLengthIsCanceled();
  await testLiedSmallContentLengthStillUsesRealBytes();
  await testOversizedHeaderRejectsBeforeStreamPull();
  await testMultibyteUtf8WithinLimit();
  await testMalformedAndInvalidUtf8Return400();
  await testArraysAndScalarsReturn400();
  testEmailAiRoutesBypassProxyBodyBuffer();
  console.log('Email AI request body tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
