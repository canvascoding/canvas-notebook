import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { SystemUpdateEvent, SystemUpdateOperation } from '../cli/src/core/systemUpdateContract';
import {
  createStandaloneUpdateStatusServer,
  STANDALONE_UPDATE_STATUS_TICKET_TTL_MS,
  StandaloneUpdateStatusTickets,
} from '../cli/src/core/standaloneUpdateStatus';

const operationId = crypto.randomUUID();
const timestamp = '2026-09-04T12:00:00.000Z';
const operation: SystemUpdateOperation = {
  contractVersion: 1,
  operationId,
  status: 'succeeded',
  stage: 'completed',
  targetVersion: '2026.9.5',
  targetImageRef: `ghcr.io/canvascoding/canvas-notebook:v2026.9.5@sha256:${'a'.repeat(64)}`,
  currentVersion: '2026.9.4.2',
  startedAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp,
  rolledBack: false,
  errorCode: null,
  error: null,
  lastSequence: 1,
};
const event: SystemUpdateEvent = {
  contractVersion: 1,
  eventId: crypto.randomUUID(),
  sequence: 1,
  operationId,
  stage: 'completed',
  status: 'succeeded',
  message: 'Canvas Notebook update completed.',
  occurredAt: timestamp,
};

async function request(port: number, requestPath: string, ticket: string, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: ticket ? { authorization: `Bearer ${ticket}` } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-update-status-'));
  let now = new Date(timestamp);
  const tickets = new StandaloneUpdateStatusTickets(root, () => now);
  await tickets.initialize();
  const source = {
    getOperation: async (id: string) => id === operationId ? operation : null,
    getEvents: async (id: string, after: number) => id === operationId && after < 1 ? [event] : [],
  };
  const server = createStandaloneUpdateStatusServer(source, tickets);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const access = tickets.issue(operationId);
    assert.equal(access.path, `/__canvas-host/operations/${operationId}/events`);
    assert.equal(tickets.verify(access.ticket, operationId), true);
    const [payload, signature] = access.ticket.split('.');
    const tampered = `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    assert.equal(tickets.verify(tampered, operationId), false);
    assert.equal(tickets.verify(access.ticket, crypto.randomUUID()), false);

    const unauthorized = await request(address.port, `/__canvas-host/operations/${operationId}`, '');
    assert.equal(unauthorized.status, 401);
    const writeAttempt = await request(address.port, `/__canvas-host/operations/${operationId}`, access.ticket, 'POST');
    assert.equal(writeAttempt.status, 405);

    const status = await request(address.port, `/__canvas-host/operations/${operationId}`, access.ticket);
    assert.equal(status.status, 200);
    assert.equal(status.headers['cache-control'], 'private, no-store');
    assert.equal(JSON.parse(status.body).status, 'succeeded');
    assert.equal(status.body.includes('targetImageRef'), false);

    const stream = await request(address.port, `${access.path}?after=0`, access.ticket);
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /text\/event-stream/u);
    assert.match(stream.body, /event: update/u);
    assert.match(stream.body, /event: operation/u);
    assert.equal(stream.body.includes('targetImageRef'), false);

    now = new Date(now.getTime() + STANDALONE_UPDATE_STATUS_TICKET_TTL_MS + 1);
    assert.equal(tickets.verify(access.ticket, operationId), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log('standalone update status test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
