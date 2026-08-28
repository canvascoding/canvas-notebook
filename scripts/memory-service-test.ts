import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-memory-service-'));
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.DATA = dataDir;

  const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);
  try {
    const { openDb } = await import('../app/lib/db');
    const db = await openDb();
    try {
      await db.run(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)`, ['user-1', 'Memory User', 'memory@example.test']);
    } finally { await db.close(); }

    const {
      addMemory,
      applyMemoryReviewCandidates,
      claimDueMemoryReviewJob,
      completeMemoryReviewJob,
      deleteMemory,
      readMemory,
      scheduleMemoryReviewForSession,
      updateMemory,
    } = await import('../app/lib/memory/service');
    const scope = { target: 'user' as const, userId: 'user-1' };
    const added = await addMemory({ ...scope, content: 'Prefers concise answers.' });
    assert.equal(added.changed, true);
    assert.equal(added.entry?.status, 'published');
    const duplicate = await addMemory({ ...scope, content: '  prefers concise answers.  ' });
    assert.equal(duplicate.changed, false);
    const updated = await updateMemory({ ...scope, id: added.entry!.id, content: 'Prefers concise answers with file links.' });
    assert.equal(updated.entry?.content, 'Prefers concise answers with file links.');
    const archived = await deleteMemory({ ...scope, id: added.entry!.id });
    assert.equal(archived.archivedEntry?.id, added.entry!.id);
    assert.deepEqual((await readMemory(scope)).entries, []);

    const workspace = await addMemory({ target: 'workspace', userId: 'user-1', workspaceId: 'workspace-1', content: 'Use the approved brand voice.' });
    assert.equal(workspace.entry?.status, 'pending');
    await assert.rejects(() => addMemory({ ...scope, content: 'x'.repeat(801) }), /800 characters/);
    await assert.rejects(() => addMemory({ ...scope, content: 'API_KEY=secret-value' }), /secret or credential/);

    const sessionDb = await openDb();
    try {
      await sessionDb.run(`
        INSERT INTO pi_sessions (session_id, user_id, agent_id, provider, model, created_at, updated_at)
        VALUES ('review-session', 'user-1', 'canvas-agent', 'test', 'test-model', 1, 1)
      `);
      const session = await sessionDb.get(`SELECT id FROM pi_sessions WHERE session_id = 'review-session'`) as { id: number };
      for (let sequence = 1; sequence <= 20; sequence += 1) {
        await sessionDb.run(`
          INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
          VALUES (?, ?, ?, ?, ?)
        `, [session.id, sequence % 2 === 1 ? 'user' : 'assistant', '{}', sequence, sequence]);
      }
    } finally { await sessionDb.close(); }
    const scheduled = await scheduleMemoryReviewForSession({ userId: 'user-1', sessionId: 'review-session', now: 1_000 });
    assert.deepEqual(scheduled, { scheduled: true, triggerType: 'turn_interval', fromMessageSequence: 1, throughMessageSequence: 20 });
    assert.equal(await claimDueMemoryReviewJob(1_000), null);
    const jobDb = await openDb();
    try {
      const job = await jobDb.get(`SELECT status FROM memory_review_jobs WHERE session_id = 'review-session'`) as { status: string };
      assert.equal(job.status, 'awaiting_model_configuration');
      await jobDb.run(`
        INSERT INTO memory_user_settings (user_id, automatic_memory_enabled, provider_installation_id, model_id, memory_prompt_max_tokens, sensitive_memory_enabled, created_at, updated_at)
        VALUES ('user-1', 1, 'aip_0123456789abcdef01234567', 'review-model', 2000, 0, 1, 1)
      `);
    } finally { await jobDb.close(); }
    const claim = await claimDueMemoryReviewJob(1_001);
    assert.equal(claim?.sourceAgentId, 'canvas-agent');
    assert.equal(claim?.modelId, 'review-model');
    assert.deepEqual(
      await scheduleMemoryReviewForSession({ userId: 'user-1', sessionId: 'review-session', now: 1_002 }),
      { scheduled: false, triggerType: 'turn_interval', fromMessageSequence: 1, throughMessageSequence: 20 },
    );
    const reviewResult = await applyMemoryReviewCandidates({
      claim: claim!,
      candidates: [{
        action: 'add',
        target: 'user',
        category: 'preferences',
        semanticKey: 'communication.response-length',
        content: 'Prefers concise responses.',
        priority: 70,
        confidence: 0.9,
        sourceMessageSequence: 1,
      }],
    });
    assert.deepEqual(reviewResult, { added: 1, updated: 0, archived: 0, skipped: 0 });
    await completeMemoryReviewJob(claim!.id, 1_003);
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  console.log('memory-service-test: ok');
}

main().catch((error) => { console.error(error); process.exit(1); });
