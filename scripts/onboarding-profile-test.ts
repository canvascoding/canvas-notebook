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
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.DATA = dataDir;

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
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
    const bootstrapSeed = await fs.readFile(path.join(process.cwd(), 'seed_sys_prompts', 'BOOTSTRAP.md'), 'utf8');
    assert.match(bootstrapSeed, /with the `memories`\s+and `soulMd` parameters/);
    assert.doesNotMatch(bootstrapSeed, /`userMd`/);
    const { db } = await import('../app/lib/db');
    const {
      aiProviderInstallations,
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

    console.log('onboarding-profile-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
