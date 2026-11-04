import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

/** The existing filesystem unit keeps its declared effect adapters, while
 * the real lifecycle guard uses an owned PostgreSQL schema. No guard is mocked. */
async function main() {
  process.env.FILE_VERSION_CENTER_MODE = 'off';
  process.env.BASE_URL = 'http://localhost';
  const root = process.cwd();
  const files = ['scripts/workspace-operation-batch-executor-test.ts',
    'app/lib/files/workspace-operation-batch-executor.ts',
    'app/lib/files/workspace-file-lifecycle-guard.ts',
    'app/lib/workspaces/workspace-operation-programmatic-job-principal.ts'];
  const sourceProof = async () => Promise.all(files.map(async file => ({ file,
    sha256: createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex') })));
  const before = await sourceProof();
  let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  await withNativeCopyMetadataOwnerFixture(async () => {
    outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'),
        '--conditions', 'react-server', path.join(root, files[0])], {
        cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  });
  assert.deepEqual(await sourceProof(), before, 'Executor and original unit sources must remain fixed during the run.');
  assert.deepEqual(outcome, { code: 0, signal: null });
  console.log(JSON.stringify({ test: 'legacy-batch-executor-owned-postgres', originalAssertions: true,
    realLifecycleGuard: true, sourceProof: before, resourcesClosed: true }));
}

main().catch(error => {
  console.error(JSON.stringify({ test: 'legacy-batch-executor-owned-postgres', name: error?.name, code: error?.code }));
  process.exitCode = 1;
});
