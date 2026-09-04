import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import { isTerminalSystemUpdateStatus, type SystemUpdateOperation } from './systemUpdateContract';

export const STANDALONE_UPDATE_STATUS_PORT = 3457;
export const STANDALONE_UPDATE_STATUS_TICKET_TTL_MS = 20 * 60 * 1000;
const STATUS_PREFIX = '/__canvas-host/operations/';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{40,1024}\.[A-Za-z0-9_-]{43}$/u;

type UpdateStatusSource = {
  getOperation(operationId: string): Promise<SystemUpdateOperation | null>;
  getEvents(operationId: string, afterSequence: number): Promise<import('./systemUpdateContract').SystemUpdateEvent[]>;
};

type StatusTicketClaims = {
  version: 1;
  operationId: string;
  expiresAt: number;
  nonce: string;
};

export interface StandaloneUpdateStatusAccess {
  path: string;
  ticket: string;
  expiresAt: string;
}

function safeOperation(operation: SystemUpdateOperation): Omit<SystemUpdateOperation, 'targetImageRef'> {
  const { targetImageRef: _targetImageRef, ...result } = operation;
  return result;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const content = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': content.length,
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(content);
}

async function readOrCreateSecret(filePath: string): Promise<Buffer> {
  const existing = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)) {
    throw new Error('Standalone updater status ticket key is unsafe.');
  }
  if (!existing) {
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(crypto.randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const secret = await fs.readFile(filePath);
  if (secret.length !== 32) throw new Error('Standalone updater status ticket key is invalid.');
  await fs.chmod(filePath, 0o600);
  return secret;
}

export class StandaloneUpdateStatusTickets {
  private secret: Buffer | null = null;

  constructor(
    private readonly stateRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    const resolvedRoot = path.resolve(this.stateRoot);
    if (resolvedRoot === path.parse(resolvedRoot).root) throw new Error('Updater status state root must not be a filesystem root.');
    await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
    this.secret = await readOrCreateSecret(path.join(resolvedRoot, 'status-ticket.key'));
  }

  issue(operationId: string): StandaloneUpdateStatusAccess {
    if (!this.secret) throw new Error('Updater status tickets are not initialized.');
    if (!UUID_PATTERN.test(operationId)) throw new Error('Update operation ID is invalid.');
    const expiresAt = this.now().getTime() + STANDALONE_UPDATE_STATUS_TICKET_TTL_MS;
    const claims: StatusTicketClaims = {
      version: 1,
      operationId,
      expiresAt,
      nonce: crypto.randomBytes(12).toString('base64url'),
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return {
      path: `${STATUS_PREFIX}${operationId}/events`,
      ticket: `${payload}.${signature}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  verify(ticket: string, operationId: string): boolean {
    if (!this.secret || !TICKET_PATTERN.test(ticket) || !UUID_PATTERN.test(operationId)) return false;
    const separator = ticket.lastIndexOf('.');
    const payload = ticket.slice(0, separator);
    const supplied = Buffer.from(ticket.slice(separator + 1), 'base64url');
    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest();
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return false;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<StatusTicketClaims>;
      return claims.version === 1 && claims.operationId === operationId &&
        typeof claims.expiresAt === 'number' && Number.isSafeInteger(claims.expiresAt) &&
        claims.expiresAt > this.now().getTime() && claims.expiresAt <= this.now().getTime() + STANDALONE_UPDATE_STATUS_TICKET_TTL_MS + 60_000 &&
        typeof claims.nonce === 'string' && /^[A-Za-z0-9_-]{16}$/u.test(claims.nonce);
    } catch {
      return false;
    }
  }
}

function bearerToken(request: IncomingMessage): string {
  const authorization = String(request.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function writeSse(response: ServerResponse, event: string, data: unknown, id?: number): void {
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamStatus(
  source: UpdateStatusSource,
  operationId: string,
  afterSequence: number,
  response: ServerResponse,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'private, no-store, no-transform',
    connection: 'keep-alive',
    'referrer-policy': 'no-referrer',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  response.flushHeaders();
  let cursor = afterSequence;
  let closed = false;
  response.on('close', () => { closed = true; });

  while (!closed) {
    const operation = await source.getOperation(operationId);
    if (!operation) {
      writeSse(response, 'error', { code: 'operation_not_found', message: 'Update operation was not found.' });
      response.end();
      return;
    }
    const events = await source.getEvents(operationId, cursor);
    for (const event of events) {
      writeSse(response, 'update', event, event.sequence);
      cursor = Math.max(cursor, event.sequence);
    }
    writeSse(response, 'operation', safeOperation(operation));
    if (isTerminalSystemUpdateStatus(operation.status)) {
      response.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (!closed) response.write(': keep-alive\n\n');
  }
}

export function createStandaloneUpdateStatusServer(
  source: UpdateStatusSource,
  tickets: StandaloneUpdateStatusTickets,
): http.Server {
  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: { code: 'method_not_allowed', message: 'The host update status endpoint is read-only.' } });
          return;
        }
        const url = new URL(request.url || '/', 'http://canvas-updater.local');
        const match = /^\/__canvas-host\/operations\/([0-9a-f-]+)(\/events)?$/iu.exec(url.pathname);
        if (!match || !UUID_PATTERN.test(match[1])) {
          sendJson(response, 404, { error: { code: 'not_found', message: 'Host update status endpoint was not found.' } });
          return;
        }
        const operationId = match[1];
        if (!tickets.verify(bearerToken(request), operationId)) {
          sendJson(response, 401, { error: { code: 'ticket_invalid', message: 'Update status ticket is missing, invalid, or expired.' } });
          return;
        }
        const allowedParameters = match[2] ? new Set(['after']) : new Set<string>();
        if ([...url.searchParams.keys()].some((key) => !allowedParameters.has(key))) {
          sendJson(response, 400, { error: { code: 'request_invalid', message: 'Host update status request contains unsupported parameters.' } });
          return;
        }
        const operation = await source.getOperation(operationId);
        if (!operation) {
          sendJson(response, 404, { error: { code: 'operation_not_found', message: 'Update operation was not found.' } });
          return;
        }
        if (!match[2]) {
          sendJson(response, 200, safeOperation(operation));
          return;
        }
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) {
          sendJson(response, 400, { error: { code: 'request_invalid', message: 'Event cursor is invalid.' } });
          return;
        }
        await streamStatus(source, operationId, after, response);
      } catch {
        if (!response.headersSent) sendJson(response, 500, { error: { code: 'status_failed', message: 'Host update status is unavailable.' } });
        else response.end();
      }
    })();
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;
  return server;
}
