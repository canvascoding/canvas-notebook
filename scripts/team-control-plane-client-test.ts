import assert from 'node:assert/strict';

import {
  classifyTeamControlPlaneStatus,
  redactTeamControlPlaneLogText,
  requestTeamControlPlane,
  TEAM_CONTROL_PLANE_OPERATION_HEADER,
  TEAM_CONTROL_PLANE_PROTOCOL_HEADER,
  TEAM_CONTROL_PLANE_VERSION_HEADER,
  TeamControlPlaneTransportError,
  type TeamControlPlaneLogger,
} from '@/app/lib/control-plane/team-client';

async function main() {
const operationId = 'd9f04214-cba0-4b1d-856a-fcabdeab55b1';
const instanceToken = 'community-instance-token-super-secret';
const memberHash = 'b'.repeat(64);
const captured: Array<{
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}> = [];
const logEntries: Array<{
  metadata: Record<string, unknown>;
  message: string;
}> = [];
const delays: number[] = [];
let attempt = 0;

const logger: TeamControlPlaneLogger = {
  warn(metadata, message) {
    logEntries.push({ metadata, message });
  },
};

const fetchImpl: typeof fetch = async (url, init) => {
  attempt += 1;
  captured.push({
    url: String(url),
    method: init?.method || 'GET',
    headers: new Headers(init?.headers),
    body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
  });
  if (attempt === 1) {
    throw new Error(`${instanceToken} failed for member ${memberHash}`);
  }
  if (attempt === 2) {
    return new Response(JSON.stringify({
      error: `Temporary failure for ${memberHash}`,
      code: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
      retryable: true,
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '0',
      },
    });
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const result = await requestTeamControlPlane({
  baseUrl: 'https://control.example.test/v1',
  path: '/license/community/v1/seats/execute',
  method: 'POST',
  body: {
    protocolVersion: 'canvas-team-seat-protocol-v1',
    operationKey: operationId,
  },
  instanceToken,
  operationId,
  fetchImpl,
  maxAttempts: 3,
  backoffMs: 10,
  maxBackoffMs: 100,
  sleep: async (delayMs) => {
    delays.push(delayMs);
  },
  logger,
});

assert.equal(result.response.status, 200);
assert.deepEqual(result.payload, { success: true });
assert.equal(result.operationId, operationId);
assert.equal(result.attemptCount, 3);
assert.equal(captured.length, 3);
assert.deepEqual(delays, [10, 0]);
for (const request of captured) {
  assert.equal(
    request.url,
    'https://control.example.test/v1/license/community/v1/seats/execute',
  );
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('Authorization'), `Bearer ${instanceToken}`);
  assert.equal(
    request.headers.get(TEAM_CONTROL_PLANE_PROTOCOL_HEADER),
    'canvas-team-seat-protocol-v1',
  );
  assert.equal(request.headers.get(TEAM_CONTROL_PLANE_OPERATION_HEADER), operationId);
  assert.match(
    request.headers.get(TEAM_CONTROL_PLANE_VERSION_HEADER) || '',
    /^\d{4}\.\d+\.\d+(?:\.\d+)?$/u,
  );
  assert.deepEqual(request.body, {
    protocolVersion: 'canvas-team-seat-protocol-v1',
    operationKey: operationId,
  });
  assert.equal(JSON.stringify(request.body).includes(instanceToken), false);
}

assert.equal(logEntries.length, 2);
const serializedLogs = JSON.stringify(logEntries);
assert.equal(serializedLogs.includes(instanceToken), false);
assert.equal(serializedLogs.includes(memberHash), false);
assert.equal(serializedLogs.includes('[member-hash-redacted]'), true);
assert.equal(
  redactTeamControlPlaneLogText(`Bearer ${instanceToken} ${memberHash}`),
  'Bearer [redacted] [member-hash-redacted]',
);

assert.equal(classifyTeamControlPlaneStatus(401), 'authentication');
assert.equal(classifyTeamControlPlaneStatus(403), 'authentication');
assert.equal(classifyTeamControlPlaneStatus(409), 'business');
assert.equal(classifyTeamControlPlaneStatus(422), 'business');
assert.equal(classifyTeamControlPlaneStatus(429), 'temporary');
assert.equal(classifyTeamControlPlaneStatus(503), 'temporary');

let businessAttempts = 0;
const business = await requestTeamControlPlane({
  baseUrl: 'https://control.example.test',
  path: '/business-error',
  method: 'POST',
  body: {},
  instanceToken,
  operationId,
  fetchImpl: async () => {
    businessAttempts += 1;
    return new Response(JSON.stringify({
      error: 'The quote is stale.',
      code: 'TEAM_SEAT_QUOTE_STALE',
      retryable: false,
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  maxAttempts: 5,
  sleep: async () => {
    throw new Error('Business errors must not enter transport backoff.');
  },
  logger,
});
assert.equal(business.response.status, 409);
assert.equal(business.attemptCount, 1);
assert.equal(businessAttempts, 1);

let authenticationAttempts = 0;
const authentication = await requestTeamControlPlane({
  baseUrl: 'https://control.example.test',
  path: '/authentication-error',
  method: 'GET',
  instanceToken,
  operationId,
  fetchImpl: async () => {
    authenticationAttempts += 1;
    return new Response(JSON.stringify({
      error: 'The instance token is invalid.',
      code: 'TEAM_SEAT_TOKEN_INVALID',
      retryable: false,
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  maxAttempts: 5,
  sleep: async () => {
    throw new Error('Authentication errors must not enter transport backoff.');
  },
  logger,
});
assert.equal(authentication.response.status, 401);
assert.equal(authentication.attemptCount, 1);
assert.equal(authenticationAttempts, 1);

let transportAttempts = 0;
await assert.rejects(
  () => requestTeamControlPlane({
    baseUrl: 'https://control.example.test',
    path: '/network-error',
    method: 'POST',
    body: {},
    instanceToken,
    operationId,
    fetchImpl: async () => {
      transportAttempts += 1;
      throw new Error(`${instanceToken} unavailable for ${memberHash}`);
    },
    maxAttempts: 2,
    backoffMs: 0,
    maxBackoffMs: 0,
    sleep: async () => undefined,
    logger,
  }),
  (error: unknown) => (
    error instanceof TeamControlPlaneTransportError
    && error.operationId === operationId
    && error.attemptCount === 2
    && !error.message.includes(instanceToken)
    && !error.message.includes(memberHash)
  ),
);
assert.equal(transportAttempts, 2);

console.log('team-control-plane-client-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
