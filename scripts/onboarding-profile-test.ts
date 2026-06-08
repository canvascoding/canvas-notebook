import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { EffectiveAgentRuntimeConfig } from '../app/lib/agents/effective-runtime-config';

const fakeModel = {
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
} as const;

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
    if (request === '@earendil-works/pi-ai') {
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
    const { testAgentModelConnection } = await import('../app/lib/agents/model-test');
    const {
      buildOnboardingProfileSessionId,
      completeOnboardingProfile,
      ensureOnboardingProfileSession,
      getOnboardingBootstrapPath,
      readOnboardingBootstrapPrompt,
      skipOnboardingProfile,
    } = await import('../app/lib/onboarding/profile');
    const { isOnboardingComplete } = await import('../app/lib/onboarding/status');

    const now = new Date('2026-06-08T10:00:00.000Z');
    const userId = 'user-onboarding';
    await db.insert(user).values({
      id: userId,
      name: 'Onboarding User',
      email: 'onboarding@example.test',
      emailVerified: true,
      image: null,
      role: 'user',
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

    const missingModel = await testAgentModelConnection({
      deps: {
        resolveConfig: async () => {
          throw new Error('No model selected for this agent.');
        },
      },
    });
    assert.equal(missingModel.success, false);
    assert.equal(missingModel.code, 'MODEL_NOT_CONFIGURED');

    const missingKey = await testAgentModelConnection({
      deps: {
        resolveConfig: async () => ({
          activeProvider: 'google',
          model: fakeModel,
        }) as unknown as EffectiveAgentRuntimeConfig,
        resolveApiKey: async () => undefined,
      },
    });
    assert.equal(missingKey.success, false);
    assert.equal(missingKey.code, 'API_KEY_MISSING');

    const failedCall = await testAgentModelConnection({
      deps: {
        resolveConfig: async () => ({
          activeProvider: 'google',
          model: fakeModel,
        }) as unknown as EffectiveAgentRuntimeConfig,
        resolveApiKey: async () => 'test-key',
        complete: async () => {
          throw new Error('provider unavailable');
        },
      },
    });
    assert.equal(failedCall.success, false);
    assert.equal(failedCall.code, 'MODEL_TEST_FAILED');

    const okCall = await testAgentModelConnection({
      deps: {
        resolveConfig: async () => ({
          activeProvider: 'google',
          model: fakeModel,
        }) as unknown as EffectiveAgentRuntimeConfig,
        resolveApiKey: async () => 'test-key',
        complete: async () => assistantText('OK'),
      },
    });
    assert.equal(okCall.success, true);

    const bootstrapPath = getOnboardingBootstrapPath(DEFAULT_MANAGED_AGENT_ID);
    await fs.mkdir(path.dirname(bootstrapPath), { recursive: true });
    await fs.writeFile(bootstrapPath, 'Bootstrap setup instructions.\n', 'utf8');
    assert.match(await readOnboardingBootstrapPrompt() || '', /Bootstrap setup/);

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
    assert.equal(completed.deletedBootstrap, true);
    await assert.rejects(() => fs.stat(bootstrapPath), /ENOENT/);
    assert.match(await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'USER.md'), 'utf8'), /Frank/);
    assert.match(await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'SOUL.md'), 'utf8'), /Canvas Agent/);
    assert.equal(await isOnboardingComplete(), true);

    await db.delete(onboardingLog).where(eq(onboardingLog.method, 'ui'));
    await fs.writeFile(bootstrapPath, 'Bootstrap setup instructions.\n', 'utf8');
    await fs.writeFile(path.join(dataDir, 'agents', 'canvas-agent', 'USER.md'), '', 'utf8');
    await fs.writeFile(path.join(dataDir, 'agents', 'canvas-agent', 'SOUL.md'), 'Default soul.\n', 'utf8');

    const skipped = await skipOnboardingProfile({
      userId,
      testModel: async () => ({ success: true, provider: 'google', model: fakeModel.id }),
    });
    assert.equal(skipped.success, true);
    assert.equal(skipped.deletedBootstrap, true);
    assert.equal(await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'USER.md'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'SOUL.md'), 'utf8'), 'Default soul.\n');
    const skipLog = await db.query.onboardingLog.findFirst({
      where: eq(onboardingLog.method, 'ui'),
    });
    assert.equal(skipLog?.notes, 'profile_skipped');

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
