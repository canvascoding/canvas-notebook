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
      await db.run(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)`, ['user-reader', 'Memory Reader', 'reader@example.test']);
      await db.run(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)`, ['user-external', 'External User', 'external@example.test']);
      await db.run(`INSERT INTO canvas_organization_settings (organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at) VALUES ('org-1', 'user-1', 'team', 1, 1, 1)`);
      await db.run(`INSERT INTO organization_user_permissions (organization_id, user_id, role, status, created_at, updated_at) VALUES ('org-1', 'user-1', 'member', 'active', 1, 1)`);
      await db.run(`INSERT INTO organization_user_permissions (organization_id, user_id, role, status, created_at, updated_at) VALUES ('org-1', 'user-reader', 'member', 'active', 1, 1)`);
      await db.run(`INSERT INTO organization_user_permissions (organization_id, user_id, role, status, created_at, updated_at) VALUES ('org-1', 'user-external', 'external', 'active', 1, 1)`);
      await db.run(`INSERT INTO canvas_workspaces (id, organization_id, type, root_relative_path, display_name, description, workspace_icon, status, is_default, created_at, updated_at) VALUES ('workspace-1', 'org-1', 'team', 'workspaces/team/org-1/workspace-1/files', 'Memory workspace', '', 'users-round', 'active', 0, 1, 1)`);
      await db.run(`INSERT INTO canvas_workspace_members (organization_id, workspace_id, user_id, role, status, can_read, can_write, can_manage, created_at, updated_at) VALUES ('org-1', 'workspace-1', 'user-1', 'member', 'active', 1, 1, 0, 1, 1)`);
      await db.run(`INSERT INTO canvas_workspace_members (organization_id, workspace_id, user_id, role, status, can_read, can_write, can_manage, created_at, updated_at) VALUES ('org-1', 'workspace-1', 'user-reader', 'viewer', 'active', 1, 0, 0, 1, 1)`);
    } finally { await db.close(); }

    const {
      addMemory,
      applyMemoryReviewCandidates,
      claimDueMemoryReviewJob,
      completeMemoryReviewJob,
      deleteAgentMemory,
      deletePersonalMemory,
      deleteMemory,
      exportAgentMemory,
      importPersonalMemory,
      listMemoryCollections,
      publishMemory,
      readMemory,
      readAgentMemoryOwnerStats,
      readMemoryCollection,
      readMemoryReviewContext,
      resolveAgentMemoryOwnerForUser,
      restoreMemory,
      runMemoryMaintenanceCycle,
      scheduleMemoryReviewForSession,
      setAgentMemoryArchived,
      transferAgentMemory,
      updateMemoryReviewSettings,
      updateMemory,
    } = await import('../app/lib/memory/service');
    const { buildMemoryPromptProjection } = await import('../app/lib/memory/prompt-projection');
    const { ensureLegacyMemoryMigrated } = await import('../app/lib/memory/legacy-migration');
    const { writeManagedAgentFile } = await import('../app/lib/agents/storage');
    const { createAgentProfile, deleteAgentProfile, ensureMemoryManagerAgent } = await import('../app/lib/agents/registry');
    const memoryManager = await ensureMemoryManagerAgent();
    assert.equal(memoryManager.agentId, 'memory-manager');
    assert.equal(memoryManager.type, 'system-worker');
    assert.equal(memoryManager.removable, false);
    assert.deepEqual(memoryManager.enabledTools, ['__none__']);
    await assert.rejects(
      () => createAgentProfile({ name: 'Memory collision', agentId: 'memory-manager' }),
      /Built-in agents cannot be recreated/,
    );
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
    const restored = await restoreMemory({ ...scope, id: added.entry!.id });
    assert.equal(restored.entry?.status, 'published');
    const archivedAgain = await deleteMemory({ ...scope, id: added.entry!.id });
    const privateCollectionId = archivedAgain.archivedEntry!.collectionId;
    assert.equal((await readMemoryCollection({ ...scope, collectionId: privateCollectionId })).entries.length, 0);
    assert.equal((await readMemoryCollection({ ...scope, collectionId: privateCollectionId, includeArchived: true })).entries[0]?.status, 'archived');

    const workspace = await addMemory({ target: 'workspace', userId: 'user-1', workspaceId: 'workspace-1', content: 'Use the approved brand voice.' });
    assert.equal(workspace.entry?.status, 'pending');
    await assert.rejects(
      () => updateMemory({ target: 'workspace', userId: 'user-1', workspaceId: 'workspace-1', id: workspace.entry!.id, content: 'Unapproved edit.' }),
      /permission to update workspace memory/,
    );
    assert.deepEqual((await readMemory({ target: 'workspace', userId: 'user-1', workspaceId: 'workspace-1' })).entries, []);
    await assert.rejects(
      () => publishMemory({ target: 'workspace', userId: 'user-1', workspaceId: 'workspace-1', id: workspace.entry!.id }),
      /permission to publish workspace memory/,
    );
    const governanceDb = await openDb();
    try {
      await governanceDb.run(`UPDATE canvas_workspace_members SET can_manage = 1 WHERE workspace_id = 'workspace-1' AND user_id = 'user-1'`);
    } finally { await governanceDb.close(); }
    const publishedWorkspace = await publishMemory({ target: 'workspace', userId: 'user-1', workspaceId: 'workspace-1', id: workspace.entry!.id });
    assert.equal(publishedWorkspace.entry?.status, 'published');
    assert.match((await readMemory({ target: 'workspace', userId: 'user-reader', workspaceId: 'workspace-1' })).entries[0]?.content ?? '', /approved brand voice/);
    await assert.rejects(
      () => addMemory({ target: 'workspace', userId: 'user-reader', workspaceId: 'workspace-1', content: 'Readers cannot suggest memory.' }),
      /permission to suggest workspace memory/,
    );

    const organizationMemory = await addMemory({ target: 'organization', userId: 'user-1', organizationId: 'org-1', content: 'Use British spelling in organization material.' });
    assert.equal(organizationMemory.entry?.status, 'pending');
    await assert.deepEqual((await readMemory({ target: 'organization', userId: 'user-1', organizationId: 'org-1' })).entries, []);
    const organizationPermissionDb = await openDb();
    try {
      await organizationPermissionDb.run(`UPDATE organization_user_permissions SET can_manage_organization_memory = 1 WHERE organization_id = 'org-1' AND user_id = 'user-1'`);
    } finally { await organizationPermissionDb.close(); }
    const publishedOrganization = await publishMemory({ target: 'organization', userId: 'user-1', organizationId: 'org-1', id: organizationMemory.entry!.id });
    assert.equal(publishedOrganization.entry?.status, 'published');
    await assert.rejects(
      () => readMemory({ target: 'organization', userId: 'user-external', organizationId: 'org-1' }),
      /permission to read organization memory/,
    );
    const imported = await importPersonalMemory({
      userId: 'user-1',
      contents: ['Keep release notes brief.', 'Keep release notes brief.', 'Prefer UTC timestamps.'],
    });
    assert.deepEqual(imported, { added: 2, skipped: 0 });
    assert.equal((await readMemory(scope)).entries.length, 2);
    await assert.rejects(() => addMemory({ ...scope, content: 'x'.repeat(801) }), /800 characters/);
    await assert.rejects(() => addMemory({ ...scope, content: 'API_KEY=secret-value' }), /secret or credential/);

    await createAgentProfile({ name: 'Research Agent', agentId: 'research-agent', accessPolicy: 'restricted', ownerUserId: 'user-1' });
    await createAgentProfile({ name: 'Writing Agent', agentId: 'writing-agent', accessPolicy: 'restricted', ownerUserId: 'user-1' });
    const researchScope = { target: 'agent' as const, userId: 'user-1', agentId: 'research-agent' };
    const writingScope = { target: 'agent' as const, userId: 'user-1', agentId: 'writing-agent' };
    await addMemory({ ...researchScope, content: 'Research sources must include publication dates.' });
    await addMemory({ ...writingScope, content: 'Writing should use short section headings.' });
    assert.deepEqual((await readMemory(researchScope)).entries.map((entry) => entry.content), ['Research sources must include publication dates.']);
    assert.deepEqual((await readMemory(writingScope)).entries.map((entry) => entry.content), ['Writing should use short section headings.']);
    assert.deepEqual(await setAgentMemoryArchived({ userId: 'user-1', agentId: 'research-agent', archived: true }), { collections: 1, archived: true });
    assert.deepEqual((await readMemory(researchScope)).entries, []);
    assert.deepEqual(await setAgentMemoryArchived({ userId: 'user-1', agentId: 'research-agent', archived: false }), { collections: 1, archived: false });
    await deleteAgentProfile('research-agent');
    assert.deepEqual(
      await resolveAgentMemoryOwnerForUser({ userId: 'user-1', agentId: 'research-agent', allowDeleted: true }),
      { agentId: 'research-agent', status: 'deleted' },
    );
    await assert.rejects(
      () => resolveAgentMemoryOwnerForUser({ userId: 'user-1', agentId: 'research-agent', allowDeleted: false }),
      /was not found/,
    );
    const exportedResearch = await exportAgentMemory('user-1', 'research-agent');
    assert.equal(exportedResearch.ownerStatus, 'deleted');
    assert.equal(exportedResearch.collections[0]?.entries[0]?.content, 'Research sources must include publication dates.');
    assert.equal((await readAgentMemoryOwnerStats('user-1')).find((owner) => owner.agentId === 'research-agent')?.agentExists, false);
    assert.deepEqual(await transferAgentMemory({ userId: 'user-1', sourceAgentId: 'research-agent', targetAgentId: 'writing-agent' }), { collections: 1, entries: 1 });
    assert.deepEqual(
      new Set((await readMemory(writingScope)).entries.map((entry) => entry.content)),
      new Set(['Writing should use short section headings.', 'Research sources must include publication dates.']),
    );
    assert.deepEqual(await deleteAgentMemory('user-1', 'writing-agent'), { collections: 2, entries: 2 });
    assert.deepEqual((await readMemory(writingScope)).entries, []);

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
      const job = await jobDb.get(`SELECT status, scheduled_for FROM memory_review_jobs WHERE session_id = 'review-session'`) as { status: string; scheduled_for: number | null };
      assert.equal(job.status, 'awaiting_model_configuration');
      assert.equal(job.scheduled_for, null);
    } finally { await jobDb.close(); }
    assert.deepEqual(await updateMemoryReviewSettings('user-1', {
      automaticMemoryEnabled: true,
      providerInstallationId: 'aip_0123456789abcdef01234567',
      modelId: 'review-model',
      memoryPromptMaxTokens: 2_000,
      sensitiveMemoryEnabled: false,
    }, 1_001), { reactivatedJobs: 1, parkedJobs: 0 });
    const reactivatedDb = await openDb();
    try {
      const job = await reactivatedDb.get(`SELECT status, scheduled_for, error_code FROM memory_review_jobs WHERE session_id = 'review-session'`) as { status: string; scheduled_for: number | null; error_code: string | null };
      assert.deepEqual(job, { status: 'scheduled', scheduled_for: 1_001, error_code: null });
    } finally { await reactivatedDb.close(); }
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
    const workspaceReviewResult = await applyMemoryReviewCandidates({
      claim: claim!,
      scopeContext: { workspaceId: 'workspace-1', organizationId: 'org-1' },
      candidates: [{
        action: 'add',
        target: 'workspace',
        category: 'decisions',
        semanticKey: 'workspace.brand.reviewed-tone',
        content: 'Use the approved workspace tone in customer-facing material.',
        priority: 60,
        confidence: 0.9,
        sourceMessageSequence: 1,
      }],
    });
    assert.deepEqual(workspaceReviewResult, { added: 1, updated: 0, archived: 0, skipped: 0 });
    const workspaceScope = { target: 'workspace' as const, userId: 'user-1', workspaceId: 'workspace-1' };
    const workspaceReviewCollection = (await listMemoryCollections(workspaceScope)).find((collection) => collection.category === 'decisions');
    assert.ok(workspaceReviewCollection);
    const workspaceReviewEntries = await readMemoryCollection({ ...workspaceScope, collectionId: workspaceReviewCollection.id });
    assert.equal(workspaceReviewEntries.entries.some((entry) => entry.status === 'pending' && /approved workspace tone/.test(entry.content)), true);
    const rejectedSharedMutation = await applyMemoryReviewCandidates({
      claim: claim!,
      scopeContext: { workspaceId: 'workspace-1' },
      candidates: [{
        action: 'update', target: 'workspace', entryId: workspace.entry!.id,
        content: 'A reviewer may not silently replace shared memory.', priority: 60,
      }],
    });
    assert.deepEqual(rejectedSharedMutation, { added: 0, updated: 0, archived: 0, skipped: 1 });
    const organizationReviewResult = await applyMemoryReviewCandidates({
      claim: claim!,
      scopeContext: { organizationId: 'org-1' },
      candidates: [{
        action: 'add',
        target: 'organization',
        category: 'conventions',
        content: 'Use the approved organization terminology in published material.',
        priority: 60,
        confidence: 0.9,
        sourceMessageSequence: 1,
      }],
    });
    assert.deepEqual(organizationReviewResult, { added: 1, updated: 0, archived: 0, skipped: 0 });
    const organizationReviewCollection = (await listMemoryCollections({ target: 'organization', userId: 'user-1', organizationId: 'org-1' })).find((collection) => collection.category === 'conventions');
    assert.ok(organizationReviewCollection);
    const organizationReviewEntries = await readMemoryCollection({ target: 'organization', userId: 'user-1', organizationId: 'org-1', collectionId: organizationReviewCollection.id });
    assert.equal(organizationReviewEntries.entries.some((entry) => entry.status === 'pending' && /approved organization terminology/.test(entry.content)), true);
    const reviewContext = await readMemoryReviewContext({
      userId: 'user-1', sourceAgentId: 'canvas-agent', workspaceId: 'workspace-1', organizationId: 'org-1',
    });
    assert.equal(reviewContext.some((entry) => entry.target === 'workspace' && /approved workspace tone/.test(entry.content)), true);
    assert.equal(reviewContext.some((entry) => entry.target === 'organization' && /approved organization terminology/.test(entry.content)), true);
    const projected = await buildMemoryPromptProjection({
      userId: 'user-1',
      agentId: 'canvas-agent',
      workspaceId: 'workspace-1',
      organizationId: 'org-1',
      usableContextTokens: 10_000,
    });
    assert.match(projected, /Prefers concise responses/);
    assert.match(projected, /Use the approved brand voice/);
    assert.match(projected, /Use British spelling in organization material/);
    const lastUsedDb = await openDb();
    try {
      const used = await lastUsedDb.get(`SELECT last_used_at FROM memory_entries WHERE content = 'Prefers concise responses.' LIMIT 1`) as { last_used_at?: number | null } | undefined;
      assert.ok(Number(used?.last_used_at ?? 0) > 0);
    } finally { await lastUsedDb.close(); }
    await completeMemoryReviewJob(claim!.id, 1_003);
    const personalDeletion = await deletePersonalMemory('user-1');
    assert.ok(personalDeletion.collections >= 1);
    assert.ok(personalDeletion.entries >= 2);
    assert.deepEqual((await readMemory(scope)).entries, []);
    assert.deepEqual((await readMemory({ target: 'agent', userId: 'user-1', agentId: 'canvas-agent' })).entries, []);
    assert.equal((await readMemory({ target: 'workspace', userId: 'user-1', workspaceId: 'workspace-1' })).entries.some((entry) => /approved brand voice/.test(entry.content)), true);
    await writeManagedAgentFile('USER.md', '- [legacy-user] Prefers migration-safe context.\n', 'canvas-agent');
    await writeManagedAgentFile('MEMORY.md', '- [legacy-agent] Keep agent-specific migration context.\n', 'canvas-agent');
    await fs.mkdir(path.join(dataDir, 'canvas-agent'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'canvas-agent', 'USER.md'), '- [legacy-canvas-agent] Keep pre-user-scope memory.\n');
    await ensureLegacyMemoryMigrated('canvas-agent', { userId: 'user-1' });
    assert.deepEqual((await readMemory(scope)).entries, []);
    assert.deepEqual((await readMemory({ target: 'agent', userId: 'user-1', agentId: 'canvas-agent' })).entries, []);
    const migrationUserDb = await openDb();
    try {
      await migrationUserDb.run(`UPDATE canvas_organization_settings SET deployment_mode = 'single_user', team_features_enabled = 0 WHERE organization_id = 'org-1'`);
    } finally { await migrationUserDb.close(); }
    await ensureLegacyMemoryMigrated('canvas-agent', { userId: 'user-1' });
    assert.deepEqual((await readMemory(scope)).entries, []);
    await addMemory({ ...scope, content: 'Keep maintenance collection available.' });
    const maintenanceDb = await openDb();
    try {
      const staleId = 'maintenance-stale';
      const pinnedId = 'maintenance-pinned';
      const pendingId = 'maintenance-pending';
      const collection = await maintenanceDb.get(`SELECT id FROM memory_collections WHERE user_id = 'user-1' AND scope_type = 'user' LIMIT 1`) as { id: string };
      for (const [id, pinned] of [[staleId, 0], [pinnedId, 1]] as const) {
        await maintenanceDb.run(`INSERT INTO memory_entries (id, collection_id, content, normalized_content_hash, status, priority, pinned, sensitivity, estimated_tokens, created_by_actor_type, created_by_user_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'published', 10, ?, 'standard', 4, 'memory_manager', 'user-1', 1, 1, 1)`, [id, collection.id, id, id, pinned]);
      }
      const workspaceCollection = await maintenanceDb.get(`SELECT id FROM memory_collections WHERE workspace_id = 'workspace-1' LIMIT 1`) as { id: string };
      await maintenanceDb.run(`INSERT INTO memory_entries (id, collection_id, content, normalized_content_hash, status, priority, pinned, sensitivity, estimated_tokens, created_by_actor_type, created_by_user_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 50, 0, 'standard', 4, 'user', 'user-1', 1, 1, 1)`, [pendingId, workspaceCollection.id, pendingId, pendingId]);
      assert.deepEqual(await runMemoryMaintenanceCycle(100 * 24 * 60 * 60 * 1000), { archived: 2 });
      const statuses = await maintenanceDb.all(`SELECT id, status FROM memory_entries WHERE id IN (?, ?, ?) ORDER BY id`, [pendingId, pinnedId, staleId]) as Array<{ id: string; status: string }>;
      assert.deepEqual(statuses, [{ id: pendingId, status: 'archived' }, { id: pinnedId, status: 'published' }, { id: staleId, status: 'archived' }]);
    } finally { await maintenanceDb.close(); }
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  console.log('memory-service-test: ok');
}

main().catch((error) => { console.error(error); process.exit(1); });
