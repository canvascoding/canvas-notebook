import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tool-output-maintenance-'));
  process.env.CANVAS_DATA_ROOT = root;
  try {
    const { storeToolOutput, getToolOutputSessionDirectory, readStoredToolOutput, resolveToolOutputReference } = await import('../app/lib/pi/tool-output-store');
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

    const persistedIdentity = { ...active, sessionId: 'persisted' };
    const old = new Date(now - 48 * 60 * 60 * 1000);
    const neverSaved = await storeToolOutput({ identity: persistedIdentity, toolCallId: 'unpublished', content: 'unpublished', format: 'text' });
    const recent = await storeToolOutput({ identity: persistedIdentity, toolCallId: 'in-flight', content: 'in-flight', format: 'text' });
    if (!neverSaved.ok || !recent.ok) throw new Error('fixture storage failed');
    const orphanPath = await resolveToolOutputReference(persistedIdentity, neverSaved.reference);
    await fs.utimes(orphanPath, old, old); await fs.utimes(`${orphanPath}.manifest.json`, old, old);
    // Referenced files may be older than the grace period and must survive.
    const keptPath = await resolveToolOutputReference(persistedIdentity, artifacts.get('persisted')!);
    await fs.utimes(keptPath, old, old); await fs.utimes(`${keptPath}.manifest.json`, old, old);
    await fs.utimes(getToolOutputSessionDirectory(persistedIdentity), old, old);
    const parent = path.dirname(getToolOutputSessionDirectory(active));
    const staging = path.join(parent, `.session-clone-${'a'.repeat(32)}`);
    const freshStaging = path.join(parent, `.session-clone-${'b'.repeat(32)}`);
    for (const directory of [staging, freshStaging]) await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(staging, 'partial'), 'partial', { mode: 0o600 });
    await fs.utimes(path.join(staging, 'partial'), old, old); await fs.utimes(staging, old, old);
    assert.equal(await cleanupToolOutputOrphans(active, { now, isPersisted: async () => true,
      references: async (identity) => [artifacts.get(identity.sessionId)!] }), 3);
    await assert.rejects(() => readStoredToolOutput(persistedIdentity, neverSaved.reference));
    assert.equal((await readStoredToolOutput(persistedIdentity, artifacts.get('persisted')!)).content, 'persisted');
    assert.equal((await readStoredToolOutput(persistedIdentity, recent.reference)).content, 'in-flight');
    await assert.rejects(() => fs.stat(staging)); await fs.stat(freshStaging);
    await assert.rejects(() => cleanupToolOutputOrphans(active, { now, isPersisted: async () => true,
      references: async () => { throw new Error('history read failed'); } }));
    assert.equal((await readStoredToolOutput(persistedIdentity, recent.reference)).content, 'in-flight');
    console.log('tool-output-maintenance-test: ok');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
