/** Loaded only by the isolated E2E runner, never imported by the product. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const runId = process.env.CANVAS_BATCH_E2E_RUN_ID;
const directory = process.env.CANVAS_BATCH_E2E_GATE_DIR;
const data = process.env.DATA;
if (!runId || !/^[a-f0-9-]{36}$/u.test(runId) || !directory
  || data !== path.join(os.tmpdir(), `canvas-file-review-e2e-${runId}`)
  || directory !== path.join(data, 'peer-gates') || process.env.NODE_ENV !== 'development'
  || process.env.CANVAS_DEPLOYMENT_MODE !== 'community') {
  throw new Error('Peer gates require the runner-owned disposable E2E instance.');
}
const gateDirectory = directory;
const dataDirectory = data;
const active = new Set<string>();
type Gate = { runId: string; batchId: string; workspaceId: string; documentId: string; phase: 'preparing' | 'links' };
type Reader = (documentId: string, workspaceId: string, ...args: unknown[]) => Promise<unknown>;

async function gate(documentId: string, workspaceId: string): Promise<void> {
  // This bridge is also used by normal editor reads. Pause only the exact
  // link service called by the real worker, before it owns the room lease.
  if (!new Error().stack?.includes('workspace-link-yjs-edits')) return;
  for (const name of await fs.readdir(gateDirectory)) {
    if (!/^[A-Za-z0-9_-]{16,128}\.gate\.json$/u.test(name)) continue;
    const config = JSON.parse(await fs.readFile(path.join(gateDirectory, name), 'utf8')) as Gate;
    if (config.runId !== runId || config.documentId !== documentId || config.workspaceId !== workspaceId
      || name !== `${config.batchId}.gate.json` || !['preparing', 'links'].includes(config.phase)
      || active.has(config.batchId)) continue;
    const manifestPath = path.join(dataDirectory, 'workspace-operation-batches', `${config.batchId}.json`);
    let pathReceipts = 0;
    try {
      const stored = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { payload: string; sha256: string };
      if (createHash('sha256').update(stored.payload).digest('hex') !== stored.sha256) throw new Error('Invalid gate manifest');
      const manifest = JSON.parse(stored.payload) as { batchId: string; workspaceId: string; steps: Array<{ key: string; state: string; receipt: unknown }> };
      if (manifest.batchId !== config.batchId || manifest.workspaceId !== workspaceId) throw new Error('Invalid gate scope');
      pathReceipts = manifest.steps.filter((step) => step.key.startsWith('path:') && step.state === 'applied' && step.receipt).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (config.phase === 'links' && !pathReceipts || config.phase === 'preparing' && pathReceipts) continue;
    active.add(config.batchId);
    await fs.writeFile(path.join(gateDirectory, `${config.batchId}.entered.json`),
      JSON.stringify({ ...config, pathReceipts }), { mode: 0o600, flag: 'wx' });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { await fs.access(path.join(gateDirectory, `${config.batchId}.release`)); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('E2E peer gate timed out');
  }
}

let reader: Reader | undefined;
Object.defineProperty(globalThis, '__canvasCollaborationDocumentReader', {
  configurable: true,
  get: () => reader,
  set: (handler: Reader | undefined) => {
    reader = handler ? async (documentId, workspaceId, ...args) => {
      await gate(documentId, workspaceId);
      return handler(documentId, workspaceId, ...args);
    } : undefined;
  },
});
