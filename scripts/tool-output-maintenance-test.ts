import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tool-output-maintenance-'));
  process.env.CANVAS_DATA_ROOT = root;
  try {
    const { storeToolOutput, getToolOutputSessionDirectory, readStoredToolOutput } = await import('../app/lib/pi/tool-output-store');
    const { cleanupToolOutputOrphans } = await import('../app/lib/pi/tool-output-maintenance');
    const active = { userId: 'owner', sessionId: 'active', organizationId: null };
    const now = Date.now();
    const artifacts = new Map<string, string>();
    for (const sessionId of ['active', 'orphan', 'persisted', 'recent', 'db-error']) {
      const identity = { ...active, sessionId };
      const result = await storeToolOutput({ identity, toolCallId: 'test', content: sessionId, format: 'text' });
      if (!result.ok) throw new Error(result.error);
      artifacts.set(sessionId, result.reference);
      const timestamp = new Date(now - (sessionId === 'recent' ? 100 : 48 * 60 * 60 * 1_000));
      await fs.utimes(getToolOutputSessionDirectory(identity), timestamp, timestamp);
    }
    const persisted = new Set(['persisted', 'db-error']);
    assert.equal(await cleanupToolOutputOrphans(active, { now, isPersisted: async identity => persisted.has(identity.sessionId) }), 1);
    await assert.rejects(() => readStoredToolOutput({ ...active, sessionId: 'orphan' }, artifacts.get('orphan')!));
    for (const sessionId of ['active', 'persisted', 'recent', 'db-error']) {
      assert.equal((await readStoredToolOutput({ ...active, sessionId }, artifacts.get(sessionId)!)).content, sessionId);
    }
    await assert.rejects(() => cleanupToolOutputOrphans(active, { now, isPersisted: async () => { throw new Error('database unavailable'); } }));
    assert.equal((await readStoredToolOutput({ ...active, sessionId: 'db-error' }, artifacts.get('db-error')!)).content, 'db-error');
    console.log('tool-output-maintenance-test: ok');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
