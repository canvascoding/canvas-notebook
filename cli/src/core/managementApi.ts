import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { validateAdminCredentials, type AdminCredentials } from './admin';
import { configSecretState, createDefaultConfig, normalizeConfig, redactConfig, writeSecureFile } from './config';
import { acquireOperationLock } from './operationLock';
import type { CanvasCliConfig, RuntimeContext } from './types';

export const MANAGEMENT_API_VERSION = 1;
export const MANAGEMENT_API_SOCKET = '/run/canvas-notebook-management/api.sock';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;

class ManagementError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

interface ManagementDependencies {
  context: RuntimeContext;
  socketPath?: string;
  setConfigValue(config: CanvasCliConfig, key: string, value: string): CanvasCliConfig;
  resetAdmin(config: CanvasCliConfig, credentials: AdminCredentials): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ManagementError(400, 'INVALID_REQUEST', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ManagementError(415, 'INVALID_CONTENT_TYPE', 'Use application/json.');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ManagementError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the management API limit.');
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) {
    if (error instanceof ManagementError) throw error;
    throw new ManagementError(400, 'INVALID_JSON', 'Request must contain valid JSON.');
  }
}

function revision(content: string): string { return crypto.createHash('sha256').update(content).digest('hex'); }

async function snapshot(context: RuntimeContext) {
  const content = await fs.readFile(context.paths.configFile, 'utf8');
  if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new ManagementError(413, 'CONFIG_TOO_LARGE', 'Config exceeds the management API limit.');
  const raw = object(JSON.parse(content));
  return { raw, config: normalizeConfig(raw, createDefaultConfig(context.paths, context.platform)), revision: revision(content) };
}

function respond(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ protocolVersion: MANAGEMENT_API_VERSION, ...body }));
}

async function prepareSocket(socketPath: string): Promise<void> {
  const existing = await fs.lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Management socket path is occupied or has an unexpected owner.');
  const active = await new Promise<boolean>((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Management socket probe timed out.')); });
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error('Management API is already running.');
  await fs.rm(socketPath, { force: true });
}

export async function startManagementApi(dependencies: ManagementDependencies): Promise<http.Server> {
  const { context } = dependencies;
  const socketPath = dependencies.socketPath || MANAGEMENT_API_SOCKET;
  if (process.platform === 'win32') throw new Error('Management API requires Unix sockets.');
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await prepareSocket(socketPath);
  let queue = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const locked = async <T>(response: http.ServerResponse, operation: () => Promise<T>): Promise<T> => {
    if (response.destroyed) throw new ManagementError(408, 'REQUEST_EXPIRED', 'The requesting client disconnected before the operation started.');
    let lease;
    try { lease = await acquireOperationLock(context, 'management-api', { ...process.env, CANVAS_OPERATION_LOCK_TIMEOUT: '5', CANVAS_CLI_SELF_UPDATE_REEXEC: 'false' }); }
    catch { throw new ManagementError(409, 'HOST_BUSY', 'Another Canvas Notebook mutation is running.'); }
    try {
      if (response.destroyed) throw new ManagementError(408, 'REQUEST_EXPIRED', 'The requesting client disconnected before the operation started.');
      return await operation();
    }
    finally { await lease.release(); }
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/capabilities') {
        respond(response, 200, { ok: true, result: { methods: ['config.get', 'config.environment.patch', 'admin.resetPassword'], configFile: context.paths.configFile } });
      } else if (request.method === 'GET' && request.url === '/v1/config') {
        const current = await snapshot(context);
        respond(response, 200, { ok: true, result: { revision: current.revision, configFile: context.paths.configFile, config: { ...redactConfig(current.config), secretState: configSecretState(current.config) } } });
      } else if (request.method === 'PATCH' && request.url === '/v1/config/environment') {
        const body = await readBody(request);
        if (Object.keys(body).some((key) => key !== 'set' && key !== 'remove')) throw new ManagementError(400, 'INVALID_REQUEST', 'Unknown environment patch field.');
        const set = object(body.set ?? {});
        const remove = body.remove ?? [];
        if (!Array.isArray(remove) || remove.some((key) => typeof key !== 'string')) throw new ManagementError(400, 'INVALID_REQUEST', 'remove must be an array of environment keys.');
        const keys = [...Object.keys(set), ...remove as string[]];
        if (keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) || Object.values(set).some((value) => typeof value !== 'string')) throw new ManagementError(400, 'INVALID_REQUEST', 'Environment values must be strings with valid keys.');
        if ((remove as string[]).some((key) => Object.hasOwn(set, key))) throw new ManagementError(400, 'INVALID_REQUEST', 'A key cannot be set and removed together.');
        const expectedRevision = request.headers['if-match'];
        if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedRevision)) throw new ManagementError(428, 'REVISION_REQUIRED', 'Supply the config revision in If-Match.');
        const result = await mutate(() => locked(response, async () => {
          const current = await snapshot(context);
          if (current.revision !== expectedRevision) throw new ManagementError(409, 'CONFIG_CONFLICT', 'Config changed; reload before applying this patch.');
          let next = current.config;
          try { for (const [key, value] of Object.entries(set)) next = dependencies.setConfigValue(next, `env.${key}`, value as string); }
          catch { throw new ManagementError(400, 'INVALID_CONFIG', 'An environment value is invalid. No changes were written.'); }
          const removedKeys = (remove as string[]).filter((key) => Object.hasOwn(next.env, key));
          for (const key of remove as string[]) delete next.env[key];
          const content = `${JSON.stringify({ ...current.raw, ...next }, null, 2)}\n`;
          if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new ManagementError(413, 'CONFIG_TOO_LARGE', 'Resulting config exceeds the management API limit.');
          await writeSecureFile(context.paths.configFile, content);
          return { revision: revision(content), changedKeys: Object.keys(set), removedKeys };
        }));
        respond(response, 200, { ok: true, result });
      } else if (request.method === 'POST' && request.url === '/v1/admin/reset-password') {
        const body = await readBody(request);
        if (Object.keys(body).some((key) => !['email', 'name', 'password'].includes(key)) || typeof body.email !== 'string' || typeof body.password !== 'string' || (body.name !== undefined && typeof body.name !== 'string')) throw new ManagementError(400, 'INVALID_REQUEST', 'Supply email, password and optional name.');
        const credentials: AdminCredentials = { email: body.email, password: body.password, name: typeof body.name === 'string' ? body.name : 'Administrator' };
        try { validateAdminCredentials(credentials); }
        catch (error) { throw new ManagementError(400, 'INVALID_ACCOUNT', (error as Error).message); }
        await mutate(() => locked(response, async () => {
          const current = await snapshot(context);
          await dependencies.resetAdmin(current.config, credentials);
        }));
        respond(response, 200, { ok: true, result: { email: credentials.email, name: credentials.name } });
      } else {
        throw new ManagementError(404, 'NOT_FOUND', 'Unknown management API route.');
      }
    } catch (error) {
      const known = error instanceof ManagementError;
      respond(response, known ? error.status : 500, { ok: false, error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Canvas Notebook management operation failed.' } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  await fs.chmod(socketPath, 0o600);
  return server;
}
