import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';

const fakeModel: Model<Api> = {
  id: 'gemini-test',
  name: 'Gemini Test',
  provider: 'google',
  api: 'openai-completions',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

function assistantText(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: fakeModel.api,
    provider: fakeModel.provider,
    model: fakeModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-onboarding-profile-'));
  const environmentKeys = ['CANVAS_DATA_ROOT', 'DATA', 'CANVAS_DATABASE_PROVIDER', 'CANVAS_DEPLOYMENT_MODE', 'DATABASE_URL', 'POSTGRES_URL', 'BASE_URL', 'BETTER_AUTH_BASE_URL', 'CANVAS_MCP_DIRECT_ENABLED'] as const;
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.DATA = dataDir;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.CANVAS_DEPLOYMENT_MODE = 'community';
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.BASE_URL = 'http://127.0.0.1:3100';
  process.env.BETTER_AUTH_BASE_URL = process.env.BASE_URL;
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';

  let database: Awaited<ReturnType<typeof import('./helpers/pi-test-database').createPiTestDatabase>> | undefined;
  let beforeRuntimeResolution: (() => Promise<void>) | null = null;
  let sessionLockObserver: ((userId: string) => void) | null = null;
  const originalFetch = globalThis.fetch;
  let unexpectedHttpCalls = 0;
  globalThis.fetch = async () => {
    unexpectedHttpCalls += 1;
    throw new Error('Unexpected HTTP request in isolated onboarding profile test.');
  };

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (
      request === '@/app/lib/db'
      || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request)
      || /^(?:\.\.\/)+db$/u.test(request)
    ) {
      assert.ok(database, 'PGlite must be initialized before the production database module is imported.');
      const fixture = database;
      return {
        ...fixture,
        openDb: async () => {
          const connection = await fixture.openDb();
          const normalize = (sql: string) => {
            let parameter = 0;
            return sql.replaceAll('?', () => `$${++parameter}`);
          };
          return {
            get: (sql: string, params?: unknown[]) => connection.get(normalize(sql), params),
            all: (sql: string, params?: unknown[]) => connection.all(normalize(sql), params),
            run: (sql: string, params?: unknown[]) => connection.run(normalize(sql), params),
            close: connection.close,
          };
        },
      };
    }
    if (request === '@/app/lib/agent-runtime-policy/provider-runtime') {
      const runtime = originalLoad(request, parent, isMain) as typeof import('../app/lib/agent-runtime-policy/provider-runtime');
      return {
        ...runtime,
        resolveExecutableAgentRuntime: async (...args: Parameters<typeof runtime.resolveExecutableAgentRuntime>) => {
          await beforeRuntimeResolution?.();
          return runtime.resolveExecutableAgentRuntime(...args);
        },
      };
    }
    if (request === '@/app/lib/pi/session-operation-lock') {
      const locks = originalLoad(request, parent, isMain) as typeof import('../app/lib/pi/session-operation-lock');
      return {
        ...locks,
        withPiSessionOperationLock: <T>(sessionId: string, userId: string, operation: () => Promise<T>) => {
          sessionLockObserver?.(userId);
          return locks.withPiSessionOperationLock(sessionId, userId, operation);
        },
      };
    }
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return {
        completeSimple: async () => assistantText('OK'),
        registerBuiltInApiProviders: () => undefined,
        getProviders: () => ['google'],
        getModels: () => [fakeModel],
      };
    }
    if (request === '@earendil-works/pi-ai/oauth') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { createPiTestDatabase } = await import('./helpers/pi-test-database');
    database = await createPiTestDatabase();
    const bootstrapSeed = await fs.readFile(path.join(process.cwd(), 'seed_sys_prompts', 'BOOTSTRAP.md'), 'utf8');
    assert.match(bootstrapSeed, /with the `memories`\s+and `soulMd` parameters/);
    assert.doesNotMatch(bootstrapSeed, /`userMd`/);
    const { db } = await import('../app/lib/db');
    const {
      aiProviderInstallations,
      canvasWorkspaces,
      user,
      onboardingLog,
      piMessages,
      piSessions,
    } = await import('../app/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { writePiRuntimeConfig, DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    const {
      aiProviderInstallationId,
      parseAiCatalogUpdate,
      replaceAiAppRuntimeCatalog,
    } = await import('../app/lib/agent-runtime-policy/catalog-service');
    const { readPiSessionRuntimeSnapshot } = await import('../app/lib/agent-runtime-policy/runtime-store');
    const {
      buildOnboardingProfileSessionId,
      completeOnboardingProfile,
      ensureOnboardingProfileSession,
      getOnboardingProfileWelcomeMessage,
      getOnboardingBootstrapPath,
      ONBOARDING_PROFILE_SESSION_TITLE,
      OnboardingProfileError,
      readOnboardingBootstrapPrompt,
      skipOnboardingProfile,
    } = await import('../app/lib/onboarding/profile');
    const { isOnboardingComplete } = await import('../app/lib/onboarding/status');
    const { readMemory, saveOnboardingUserMemories } = await import('../app/lib/memory/service');
    const { buildMemoryPromptProjection } = await import('../app/lib/memory/prompt-projection');
    const { openDb } = await import('../app/lib/db');
    const { resolveAgentSessionWorkspaceForUser } = await import('../app/lib/pi/session-workspace-context');
    const { initializeUserOnboarding, updateUserOnboardingState } = await import('../app/lib/user-preferences');

    const now = new Date('2026-06-08T10:00:00.000Z');
    const userId = 'user-onboarding';
    await db.insert(user).values({
      id: userId,
      name: 'Onboarding User',
      email: 'onboarding@example.test',
      emailVerified: true,
      image: null,
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const personalWorkspace = await resolveAgentSessionWorkspaceForUser({ userId });
    assert.equal(personalWorkspace.workspaceType, 'personal');
    assert.ok(personalWorkspace.organizationId);
    const providerInstallationId = aiProviderInstallationId(
      personalWorkspace.organizationId,
      'openai-compatible',
      'organization',
    );
    await replaceAiAppRuntimeCatalog({
      organizationId: personalWorkspace.organizationId,
      actorUserId: userId,
      update: parseAiCatalogUpdate({
        expectedRevision: 0,
        providers: [{
          providerInstallationId,
          providerId: 'openai-compatible',
          enabled: true,
          credentialScope: 'organization',
          config: {
            openaiCompatibleBaseUrl: 'http://localhost:9000/v1',
            openaiCompatibleModelSource: 'custom',
            openaiCompatibleCustomModel: fakeModel.id,
          },
          modelIds: [fakeModel.id],
          defaultModelId: fakeModel.id,
        }],
        defaultSelection: {
          providerInstallationId,
          providerId: 'openai-compatible',
          modelId: fakeModel.id,
          thinkingLevel: 'off',
        },
      }),
      discovery: {
        'openai-compatible': {
          id: 'openai-compatible',
          name: 'OpenAI Compatible',
          source: 'self-hosted',
          models: [{
            id: fakeModel.id,
            name: fakeModel.name,
            reasoning: false,
            supportsVision: false,
          }],
        },
      },
    });
    await db
      .update(aiProviderInstallations)
      .set({
        status: 'ready',
        verifiedAt: now,
        verifiedByUserId: userId,
        updatedAt: now,
      })
      .where(eq(aiProviderInstallations.id, providerInstallationId));

    const configuredPiConfig = {
      ...DEFAULT_PI_CONFIG,
      activeProvider: 'google',
      providers: {
        ...DEFAULT_PI_CONFIG.providers,
        google: {
          ...DEFAULT_PI_CONFIG.providers.google,
          model: fakeModel.id,
          thinking: 'off' as const,
          enabledTools: [],
        },
      },
    };
    await writePiRuntimeConfig(configuredPiConfig);

    const bootstrapPath = getOnboardingBootstrapPath(DEFAULT_MANAGED_AGENT_ID);
    await fs.mkdir(path.dirname(bootstrapPath), { recursive: true });
    await fs.writeFile(bootstrapPath, 'Bootstrap setup instructions.\n', 'utf8');
    assert.match(await readOnboardingBootstrapPrompt() || '', /Bootstrap setup/);

    await initializeUserOnboarding(userId);
    await updateUserOnboardingState(userId, { step: 'workspace' });
    await updateUserOnboardingState(userId, { step: 'profile' });
    assert.equal(ONBOARDING_PROFILE_SESSION_TITLE, 'Bradley Onboarding');
    assert.match(getOnboardingProfileWelcomeMessage('de'), /Bradley/);
    assert.match(getOnboardingProfileWelcomeMessage('de'), /Hauptagent/);
    assert.match(getOnboardingProfileWelcomeMessage('de'), /Name und meine Rolle bleiben fest/);
    assert.match(getOnboardingProfileWelcomeMessage('en'), /Bradley/);
    assert.match(getOnboardingProfileWelcomeMessage('en'), /main agent/);
    assert.match(getOnboardingProfileWelcomeMessage('en'), /name and role stay fixed/);
    const profileSession = await ensureOnboardingProfileSession({ userId, locale: 'de' });
    assert.equal(profileSession.sessionId, buildOnboardingProfileSessionId(userId));
    assert.equal(profileSession.workspaceId, personalWorkspace.workspaceId);

    const dbSession = await db.query.piSessions.findFirst({
      where: eq(piSessions.sessionId, profileSession.sessionId),
    });
    assert.ok(dbSession);
    assert.equal(dbSession.agentId, DEFAULT_MANAGED_AGENT_ID);
    assert.equal(dbSession.organizationId, personalWorkspace.organizationId);
    assert.equal(dbSession.workspaceId, personalWorkspace.workspaceId);
    assert.equal(dbSession.workspaceType, 'personal');
    assert.equal(dbSession.provider, 'openai-compatible');
    assert.equal(dbSession.model, fakeModel.id);
    assert.equal(dbSession.thinkingLevel, 'off');
    assert.equal(dbSession.runtimeProviderInstallationId, providerInstallationId);
    assert.equal(dbSession.runtimeCatalogRevision, 1);
    assert.equal(typeof dbSession.runtimePolicyRevision, 'number');
    assert.equal(dbSession.runtimeSelectionSource, 'app_default');
    const runtimeSnapshot = await readPiSessionRuntimeSnapshot({
      sessionId: profileSession.sessionId,
      userId,
      agentId: DEFAULT_MANAGED_AGENT_ID,
    });
    assert.ok(runtimeSnapshot);
    assert.deepEqual(runtimeSnapshot.selection, {
      providerInstallationId,
      providerId: 'openai-compatible',
      modelId: fakeModel.id,
      thinkingLevel: 'off',
    });
    const [welcomeRow] = await db
      .select()
      .from(piMessages)
      .where(eq(piMessages.piSessionDbId, dbSession!.id));
    const welcome = JSON.parse(welcomeRow.content) as AssistantMessage;
    assert.equal(welcome.role, 'assistant');
    const welcomeText = welcome.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
    assert.match(welcomeText, /Bradley/);
    assert.match(welcomeText, /Wie heißt du/);

    const beforeReuse = await db.select().from(piMessages).where(eq(piMessages.piSessionDbId, dbSession.id));
    const reusedSession = await ensureOnboardingProfileSession({ userId, locale: 'en' });
    assert.deepEqual(reusedSession, profileSession, 'Reload returns the same authoritative session/workspace pair.');
    assert.deepEqual(await db.query.piSessions.findFirst({ where: eq(piSessions.id, dbSession.id) }), dbSession);
    assert.deepEqual(await db.select().from(piMessages).where(eq(piMessages.piSessionDbId, dbSession.id)), beforeReuse,
      'Reusing a populated session preserves the welcome and conversation history.');

    await db.update(piSessions).set({ workspaceType: 'organization' }).where(eq(piSessions.id, dbSession.id));
    await assert.rejects(() => ensureOnboardingProfileSession({ userId }),
      error => error instanceof OnboardingProfileError && error.code === 'ONBOARDING_WORKSPACE_CHANGED');
    await db.update(piSessions).set({ workspaceType: 'personal' }).where(eq(piSessions.id, dbSession.id));

    await db.update(canvasWorkspaces).set({ status: 'disabled' }).where(eq(canvasWorkspaces.id, personalWorkspace.workspaceId));
    await assert.rejects(() => ensureOnboardingProfileSession({ userId }), /Workspace not found or inaccessible/);
    await db.update(canvasWorkspaces).set({ status: 'active' }).where(eq(canvasWorkspaces.id, personalWorkspace.workspaceId));
    assert.deepEqual(await db.select().from(piMessages).where(eq(piMessages.piSessionDbId, dbSession.id)), beforeReuse,
      'Failed workspace checks never rewrite existing messages.');

    await assert.rejects(
      () => completeOnboardingProfile({
        userId,
        sessionId: profileSession.sessionId,
        memories: [{
          category: 'profile',
          semanticKey: 'profile.api-key',
          content: 'OPENAI_API_KEY=sk-testtesttesttesttesttest',
        }],
        soulMd: 'Helpful agent.',
      }),
      /secret or credential/,
    );

    const completed = await completeOnboardingProfile({
      userId,
      sessionId: profileSession.sessionId,
      memories: [
        { category: 'profile', semanticKey: 'profile.name', content: 'The user\'s name is Frank.' },
        { category: 'interests', semanticKey: 'interests.primary-goal', content: 'The user wants to build Canvas workflows.' },
      ],
      soulMd: '# Collaboration Preferences\n\n- Style: concise\n- Ask before consequential actions',
      summary: 'Captured user context and Bradley collaboration preferences.',
    });
    assert.equal(completed.success, true);
    assert.equal(completed.deletedBootstrap, false);
    assert.deepEqual(
      { added: completed.memory.added, updated: completed.memory.updated, unchanged: completed.memory.unchanged },
      { added: 2, updated: 0, unchanged: 0 },
    );
    assert.match(await fs.readFile(bootstrapPath, 'utf8'), /Bootstrap setup/);
    const scopedCanvasAgentPath = path.join(dataDir, 'users', userId, 'agents', DEFAULT_MANAGED_AGENT_ID);
    assert.doesNotMatch(await fs.readFile(path.join(scopedCanvasAgentPath, 'USER.md'), 'utf8'), /Frank/);
    const savedSoul = await fs.readFile(path.join(scopedCanvasAgentPath, 'SOUL.md'), 'utf8');
    assert.match(savedSoul, /Style: concise/);
    assert.match(savedSoul, /Ask before consequential actions/);
    assert.doesNotMatch(savedSoul, /Canvas Agent/);
    const savedMemory = await readMemory({ target: 'user', userId });
    assert.deepEqual(
      new Set(savedMemory.entries.map((entry) => entry.content)),
      new Set(['The user\'s name is Frank.', 'The user wants to build Canvas workflows.']),
    );
    const retriedMemorySave = await saveOnboardingUserMemories({
      userId,
      agentId: DEFAULT_MANAGED_AGENT_ID,
      sessionId: profileSession.sessionId,
      memories: [
        { category: 'profile', semanticKey: 'profile.name', content: 'The user\'s name is Frank.' },
        { category: 'interests', semanticKey: 'interests.primary-goal', content: 'The user wants to build Canvas workflows.' },
      ],
    });
    assert.deepEqual(
      { added: retriedMemorySave.added, updated: retriedMemorySave.updated, unchanged: retriedMemorySave.unchanged },
      { added: 0, updated: 0, unchanged: 2 },
    );
    assert.match(
      await buildMemoryPromptProjection({ userId, agentId: DEFAULT_MANAGED_AGENT_ID }),
      /The user's name is Frank\./,
    );
    const memoryAuditDb = await openDb();
    try {
      const auditRows = await memoryAuditDb.all(`
        SELECT event.decision_code, event.session_id
        FROM memory_events event
        INNER JOIN memory_entries entry ON entry.id = event.entry_id
        INNER JOIN memory_collections collection ON collection.id = entry.collection_id
        WHERE collection.user_id = ?
        ORDER BY event.created_at, event.id
      `, [userId]) as Array<{ decision_code: string; session_id: string }>;
      assert.equal(auditRows.length, 2);
      assert.equal(auditRows.every((row) => row.decision_code === 'onboarding_profile'), true);
      assert.equal(auditRows.every((row) => row.session_id === profileSession.sessionId), true);
    } finally {
      await memoryAuditDb.close();
    }
    assert.equal(await isOnboardingComplete(), false);

    await updateUserOnboardingState(userId, { step: 'profile', runtime: 'skipped', profile: 'pending', tour: 'pending' });
    await fs.writeFile(bootstrapPath, 'Bootstrap setup instructions.\n', 'utf8');
    await fs.writeFile(path.join(scopedCanvasAgentPath, 'USER.md'), '', 'utf8');
    await fs.writeFile(path.join(scopedCanvasAgentPath, 'SOUL.md'), 'Default soul.\n', 'utf8');

    const skipped = await skipOnboardingProfile({ userId });
    assert.equal(skipped.success, true);
    assert.equal(skipped.deletedBootstrap, false);
    assert.equal(skipped.alreadyComplete, false);
    assert.equal(await fs.readFile(path.join(scopedCanvasAgentPath, 'USER.md'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(scopedCanvasAgentPath, 'SOUL.md'), 'utf8'), 'Default soul.\n');
    const skipLog = await db.query.onboardingLog.findFirst({
      where: eq(onboardingLog.method, 'ui'),
    });
    assert.equal(skipLog, undefined);

    const skippedAgain = await skipOnboardingProfile({ userId });
    assert.equal(skippedAgain.success, true);
    assert.equal(skippedAgain.deletedBootstrap, false);
    assert.equal(skippedAgain.alreadyComplete, true);

    const secondaryUserId = 'user-secondary';
    await db.insert(user).values({
      id: secondaryUserId,
      name: 'Secondary User',
      email: 'secondary@example.test',
      emailVerified: true,
      image: null,
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await fs.writeFile(bootstrapPath, 'Instance bootstrap remains managed by the owner.\n', 'utf8');
    await initializeUserOnboarding(secondaryUserId);
    await updateUserOnboardingState(secondaryUserId, { step: 'workspace' });
    await updateUserOnboardingState(secondaryUserId, { step: 'profile' });
    const secondarySession = await ensureOnboardingProfileSession({ userId: secondaryUserId, locale: 'en' });
    assert.equal(secondarySession.sessionId, buildOnboardingProfileSessionId(secondaryUserId));
    assert.notEqual(secondarySession.workspaceId, profileSession.workspaceId);
    await updateUserOnboardingState(userId, { step: 'profile', profile: 'pending' });
    await db.update(piSessions).set({ workspaceId: secondarySession.workspaceId }).where(eq(piSessions.id, dbSession.id));
    await assert.rejects(() => ensureOnboardingProfileSession({ userId }), /Workspace not found or inaccessible/);
    await db.update(piSessions).set({ workspaceId: personalWorkspace.workspaceId }).where(eq(piSessions.id, dbSession.id));
    assert.deepEqual(await db.select().from(piMessages).where(eq(piMessages.piSessionDbId, dbSession.id)), beforeReuse,
      'A foreign personal workspace is rejected even for the organization owner.');
    await updateUserOnboardingState(userId, { step: 'tour', profile: 'skipped' });
    const secondaryCompleted = await completeOnboardingProfile({
      userId: secondaryUserId,
      sessionId: secondarySession.sessionId,
      memories: [{ category: 'profile', semanticKey: 'profile.name', content: 'The user\'s name is Secondary.' }],
      soulMd: '# Soul\n\n- Style: helpful',
    });
    assert.equal(secondaryCompleted.instanceCompleted, false);
    assert.equal(secondaryCompleted.deletedBootstrap, false);
    assert.match(await fs.readFile(bootstrapPath, 'utf8'), /Instance bootstrap/);
    assert.deepEqual(
      (await readMemory({ target: 'user', userId: secondaryUserId })).entries.map((entry) => entry.content),
      ['The user\'s name is Secondary.'],
    );

    const concurrentUserId = 'user-concurrent-bootstrap';
    await db.insert(user).values({ id: concurrentUserId, name: 'Concurrent User', email: 'concurrent@example.test',
      emailVerified: true, role: 'user', createdAt: now, updatedAt: now });
    await initializeUserOnboarding(concurrentUserId);
    await updateUserOnboardingState(concurrentUserId, { step: 'workspace' });
    await updateUserOnboardingState(concurrentUserId, { step: 'profile' });
    let runtimeEntered!: () => void;
    let releaseRuntime!: () => void;
    const runtimeReached = new Promise<void>(resolve => { runtimeEntered = resolve; });
    const runtimeReleased = new Promise<void>(resolve => { releaseRuntime = resolve; });
    beforeRuntimeResolution = async () => { runtimeEntered(); await runtimeReleased; };
    const pendingBootstrap = ensureOnboardingProfileSession({ userId: concurrentUserId });
    await runtimeReached;
    let skipSettled = false;
    const pendingSkip = skipOnboardingProfile({ userId: concurrentUserId }).then(result => { skipSettled = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(skipSettled, false, 'Skip waits for an in-flight bootstrap before confirming completion.');
    releaseRuntime();
    const [concurrentSession, concurrentSkip] = await Promise.all([pendingBootstrap, pendingSkip]);
    beforeRuntimeResolution = null;
    assert.equal(concurrentSkip.alreadyComplete, false);
    assert.ok(concurrentSession.workspaceId);
    const messagesAfterSkip = await db.select().from(piMessages);
    await assert.rejects(() => ensureOnboardingProfileSession({ userId: concurrentUserId }),
      error => error instanceof OnboardingProfileError && error.code === 'PROFILE_ALREADY_COMPLETE');
    assert.deepEqual(await db.select().from(piMessages), messagesAfterSkip, 'No bootstrap work persists after successful Skip.');

    const queuedUserId = 'user-queued-skip';
    await db.insert(user).values({ id: queuedUserId, name: 'Queued User', email: 'queued@example.test',
      emailVerified: true, role: 'user', createdAt: now, updatedAt: now });
    await initializeUserOnboarding(queuedUserId);
    await updateUserOnboardingState(queuedUserId, { step: 'workspace' });
    await updateUserOnboardingState(queuedUserId, { step: 'profile' });
    const { withPiSessionOperationLock } = await import('../app/lib/pi/session-operation-lock');
    let lockHeld!: () => void;
    let releaseLock!: () => void;
    const held = new Promise<void>(resolve => { lockHeld = resolve; });
    const released = new Promise<void>(resolve => { releaseLock = resolve; });
    const blocker = withPiSessionOperationLock(buildOnboardingProfileSessionId(queuedUserId), queuedUserId,
      async () => { lockHeld(); await released; });
    await held;
    let bothQueued!: () => void;
    const queued = new Promise<void>(resolve => { bothQueued = resolve; });
    let queuedCalls = 0;
    sessionLockObserver = id => { if (id === queuedUserId && ++queuedCalls === 2) bothQueued(); };
    const queuedSkip = skipOnboardingProfile({ userId: queuedUserId });
    const queuedBootstrap = ensureOnboardingProfileSession({ userId: queuedUserId });
    const rejectedBootstrap = assert.rejects(queuedBootstrap,
      error => error instanceof OnboardingProfileError && error.code === 'PROFILE_ALREADY_COMPLETE');
    await queued;
    releaseLock();
    await Promise.all([blocker, queuedSkip, rejectedBootstrap]);
    sessionLockObserver = null;
    assert.equal(await db.query.piSessions.findFirst({ where: eq(piSessions.userId, queuedUserId) }), undefined,
      'Bootstrap rechecks pending status after waiting for a prior Skip under the session lock.');

    console.log('onboarding-profile-test: ok (isolated PGlite; new/reused workspace pair, ownership/access, idempotence, Skip concurrency)');
  } finally {
    moduleInternals._load = originalLoad;
    globalThis.fetch = originalFetch;
    try {
      await database?.close();
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else Reflect.set(process.env, key, value);
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    }
    assert.equal(unexpectedHttpCalls, 0, 'No HTTP/AI provider requests may escape the isolated fixture.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
