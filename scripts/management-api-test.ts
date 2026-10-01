import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setConfigValue } from '../cli/src/main';
import { createDefaultConfig, writeConfig } from '../cli/src/core/config';
import { startManagementApi } from '../cli/src/core/managementApi';
import { acquireOperationLock } from '../cli/src/core/operationLock';
import { createRuntimeContext } from '../cli/src/core/platform';
import type { AdminCredentials } from '../cli/src/core/admin';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-management-'));
  const context = createRuntimeContext({ NODE_ENV: 'test', CANVAS_INSTALL_DIR: root, CANVAS_DATA_DIR: path.join(root, 'data') });
  const socketPath = path.join(root, 'api.sock');
  const config = createDefaultConfig(context.paths, context.platform);
  config.env.PRIVATE_TOKEN = 'private-test-token';
  config.env.OLD_VALUE = 'remove-me';
  await writeConfig(config);
  const credentials: AdminCredentials[] = [];
  const server = await startManagementApi({ context, socketPath, setConfigValue, resetAdmin: async (_config, input) => { credentials.push(input); } });
  const call = (method: string, route: string, body?: unknown, revision?: string) => new Promise<{ status: number; payload: { result: { revision: string }; [key: string]: unknown } }>((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers: { 'content-type': 'application/json', ...(revision ? { 'if-match': revision } : {}) } }, (res) => {
      let output = '';
      res.on('data', (chunk) => { output += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, payload: JSON.parse(output) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
    let current = await call('GET', '/v1/config');
    assert.equal(current.status, 200);
    assert.equal(JSON.stringify(current.payload).includes('private-test-token'), false);
    const before = await fs.readFile(context.paths.configFile, 'utf8');
    const invalid = await call('PATCH', '/v1/config/environment', { set: { GOOD_VALUE: 'one', CANVAS_DATABASE_PROVIDER: 'sqlite' } }, current.payload.result.revision);
    assert.equal(invalid.status, 400);
    assert.equal(await fs.readFile(context.paths.configFile, 'utf8'), before);
    assert.equal((await call('PATCH', '/v1/config/environment', { set: { X: '1' } })).status, 428);
    assert.equal((await call('PATCH', '/v1/config/environment', { set: { X: '1' }, remove: ['X'] }, current.payload.result.revision)).status, 400);
    const updates = await Promise.all([
      call('PATCH', '/v1/config/environment', { set: { FIRST: '1', SECOND: '2' }, remove: ['OLD_VALUE'] }, current.payload.result.revision),
      call('PATCH', '/v1/config/environment', { set: { THIRD: '3' } }, current.payload.result.revision),
    ]);
    assert.deepEqual(updates.map((result) => result.status).sort(), [200, 409]);
    const stored = JSON.parse(await fs.readFile(context.paths.configFile, 'utf8'));
    if (updates[0].status === 200) {
      assert.equal(stored.env.FIRST, '1');
      assert.equal(stored.env.SECOND, '2');
      assert.equal('OLD_VALUE' in stored.env, false);
      assert.equal('THIRD' in stored.env, false);
    } else {
      assert.equal(stored.env.THIRD, '3');
      assert.equal('FIRST' in stored.env, false);
      assert.equal('SECOND' in stored.env, false);
      assert.equal(stored.env.OLD_VALUE, 'remove-me');
    }
    assert.equal((await fs.stat(context.paths.configFile)).mode & 0o777, 0o600);
    assert.equal((await call('PATCH', '/v1/config/environment', { set: { BIG: 'x'.repeat(300_000) } }, updates.find((result) => result.status === 200)!.payload.result.revision)).status, 413);
    current = await call('GET', '/v1/config');
    const lock = await acquireOperationLock(context, 'test-cli');
    const waiting = call('PATCH', '/v1/config/environment', { set: { AFTER_LOCK: 'yes' } }, current.payload.result.revision);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await fs.readFile(context.paths.configFile, 'utf8')).includes('AFTER_LOCK'), false);
    await lock.release();
    assert.equal((await waiting).status, 200);
    current = await call('GET', '/v1/config');
    const abortLock = await acquireOperationLock(context, 'test-aborted-request');
    const cancelled = http.request({ socketPath, method: 'PATCH', path: '/v1/config/environment', headers: { 'content-type': 'application/json', 'if-match': current.payload.result.revision } });
    cancelled.on('error', () => undefined);
    cancelled.end(JSON.stringify({ set: { ABORTED_CHANGE: 'must-not-write' } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancelled.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await abortLock.release();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await fs.readFile(context.paths.configFile, 'utf8')).includes('ABORTED_CHANGE'), false);
    assert.equal((await call('POST', '/v1/admin/reset-password', { email: 'admin@example.test', name: 'Admin', password: 'test-password' })).status, 200);
    assert.equal(credentials.length, 1);
    assert.equal((await call('POST', '/v1/admin/reset-password', { email: 'bad', password: 'short' })).status, 400);
    assert.equal(credentials.length, 1);
    assert.equal((await call('POST', '/v1/updates', {})).status, 404);
    await assert.rejects(startManagementApi({ context, socketPath, setConfigValue, resetAdmin: async () => {} }), /already running/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Management API: atomic patches, revision conflicts, shared CLI lock, private socket and account validation passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
