import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const data = await mkdtemp(path.join(os.tmpdir(), 'canvas-standalone-import-'));
try {
  for (const entry of ['recovery-evidence', 'recovery-operator', '../excalidraw-collaboration/checkpoint-worker']) {
    const source = `require('./app/lib/collaboration/${entry}.ts');
      ${entry === 'recovery-evidence' ? `if (Object.keys(require.cache).some(file => file.endsWith('/app/lib/auth.ts'))) throw new Error('Read-only evidence imported authentication runtime');` : ''}
      console.log('standalone import passed'); ${entry === 'recovery-evidence' ? '' : 'process.exit(0);'}`;
    const { stdout } = await execute(process.execPath, ['--conditions', 'react-server', '--import', 'tsx', '-e', source], {
      cwd: process.cwd(), timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', CANVAS_MCP_DIRECT_ENABLED: 'false',
        DATA: data, CANVAS_DATA_ROOT: data, CANVAS_ENV_FILE: path.join(data, 'absent.env'),
        CANVAS_DATABASE_PROVIDER: 'postgres', DATABASE_URL: '',
        BETTER_AUTH_BASE_URL: 'http://127.0.0.1:3100',
        BETTER_AUTH_SECRET: 'standalone-import-fixture-secret-at-least-32-characters' },
    });
    assert.match(stdout, /standalone import passed/u);
  }
  console.log('collaboration-standalone-import-test: real recovery and backup modules import without provider loading');
} finally { await rm(data, { recursive: true, force: true }); }
