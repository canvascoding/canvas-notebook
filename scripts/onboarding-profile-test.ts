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
    const { db } = await import('../app/lib/db');
    const { user, onboardingLog, piMessages, piSessions } = await import('../app/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { writePiRuntimeConfig, DEFAULT_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
    const {
      buildOnboardingProfileSessionId,
      completeOnboardingProfile,
      ensureOnboardingProfileSession,
      getOnboardingBootstrapPath,
      readOnboardingBootstrapPrompt,
      skipOnboardingProfile,
    } = await import('../app/lib/onboarding/profile');
    const { isOnboardingComplete } = await import('../app/lib/onboarding/status');
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
    await updateUserOnboardingState(userId, { step: 'runtime' });
    await updateUserOnboardingState(userId, { step: 'profile', runtime: 'completed' });
    const profileSession = await ensureOnboardingProfileSession({ userId, locale: 'de' });
    assert.equal(profileSession.sessionId, buildOnboardingProfileSessionId(userId));

    const dbSession = await db.query.piSessions.findFirst({
      where: eq(piSessions.sessionId, profileSession.sessionId),
    });
    assert.ok(dbSession);
    const [welcomeRow] = await db
      .select()
      .from(piMessages)
      .where(eq(piMessages.piSessionDbId, dbSession!.id));
    const welcome = JSON.parse(welcomeRow.content) as AssistantMessage;
    assert.equal(welcome.role, 'assistant');
    assert.match(welcome.content.map((part) => part.type === 'text' ? part.text : '').join('\n'), /Wie heißt du/);

    await assert.rejects(
      () => completeOnboardingProfile({
        userId,
        userMd: 'OPENAI_API_KEY=sk-testtesttesttesttesttest',
        soulMd: 'Helpful agent.',
      }),
      /secret or credential/,
    );

    const completed = await completeOnboardingProfile({
      userId,
      userMd: '# User\n\n- Name: Frank\n- Goal: Build Canvas workflows',
      soulMd: '# Soul\n\n- Name: Canvas Agent\n- Style: concise',
      summary: 'Captured user and agent profile.',
    });
    assert.equal(completed.success, true);
    assert.equal(completed.deletedBootstrap, false);
    assert.match(await fs.readFile(bootstrapPath, 'utf8'), /Bootstrap setup/);
    const scopedCanvasAgentPath = path.join(dataDir, 'users', userId, 'agents', 'canvas-agent');
    assert.match(await fs.readFile(path.join(scopedCanvasAgentPath, 'USER.md'), 'utf8'), /Frank/);
    assert.match(await fs.readFile(path.join(scopedCanvasAgentPath, 'SOUL.md'), 'utf8'), /Canvas Agent/);
    assert.equal(await isOnboardingComplete(), false);

    await updateUserOnboardingState(userId, { step: 'profile', runtime: 'completed', profile: 'pending', tour: 'pending' });
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
    await updateUserOnboardingState(secondaryUserId, { step: 'runtime' });
    await updateUserOnboardingState(secondaryUserId, { step: 'profile', runtime: 'skipped' });
    const secondarySession = await ensureOnboardingProfileSession({ userId: secondaryUserId, locale: 'en' });
    assert.equal(secondarySession.sessionId, buildOnboardingProfileSessionId(secondaryUserId));
    const secondaryCompleted = await completeOnboardingProfile({
      userId: secondaryUserId,
      userMd: '# User\n\n- Name: Secondary',
      soulMd: '# Soul\n\n- Style: helpful',
    });
    assert.equal(secondaryCompleted.instanceCompleted, false);
    assert.equal(secondaryCompleted.deletedBootstrap, false);
    assert.match(await fs.readFile(bootstrapPath, 'utf8'), /Instance bootstrap/);

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
