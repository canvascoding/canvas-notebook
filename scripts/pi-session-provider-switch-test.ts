import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

type RouteSession = {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
  session: {
    id: string;
  };
};

function model(provider: string, id: string) {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: '',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function providerInstallationId(
  organizationId: string,
  providerId: string,
): string {
  return `aip_${createHash('sha256')
    .update(`${organizationId}\0${providerId}\0system`)
    .digest('hex')
    .slice(0, 24)}`;
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-provider-switch-'));
  const previousData = process.env.DATA;
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousBetterAuthUrl = process.env.BETTER_AUTH_URL;
  const previousOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  const previousGroqApiKey = process.env.GROQ_API_KEY;
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;

  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/pi/runtime-service') {
      return {
        getActiveRuntimeStatusSummaries: () => [],
        getStatus: async () => null,
        invalidateRuntime: async () => undefined,
        withRuntimeSessionOperation: async <T>(
          _sessionId: string,
          _userId: string,
          operation: () => Promise<T>,
        ) => operation(),
      };
    }
    if (request === '@earendil-works/pi-ai/oauth') {
      return { getOAuthProvider: () => null };
    }
    if (request === '@earendil-works/pi-ai/compat') {
      return {
        getModels: (provider: string) => {
          if (provider === 'openrouter') return [model(provider, 'openrouter/test-model')];
          if (provider === 'groq') return [model(provider, 'groq/test-model')];
          return [];
        },
        getProviders: () => ['openrouter', 'groq'],
        registerBuiltInApiProviders: () => undefined,
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    process.env.DATA = tempRoot;
    process.env.CANVAS_DATA_ROOT = tempRoot;
    process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
    process.env.BETTER_AUTH_URL = 'http://localhost:3000';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.GROQ_API_KEY = 'test-groq-key';

    const { runMigrations } = await import('../app/lib/db/migrate');
    const sqlite = new Database(path.join(tempRoot, 'sqlite.db'));
    const now = Date.now();
    try {
      runMigrations(sqlite);
      sqlite.prepare(`
        INSERT INTO user (
          id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
        ) VALUES (?, ?, ?, 1, NULL, 'admin', NULL, NULL, NULL, ?, ?)
      `).run('provider-switch-user', 'Provider Switch User', 'provider-switch@example.test', now, now);
      sqlite.prepare(`
        INSERT INTO pi_sessions (
          session_id, user_id, agent_id, provider, model, thinking_level, title, created_at, updated_at
        ) VALUES (?, ?, 'canvas-agent', ?, ?, ?, ?, ?, ?)
      `).run(
        'provider-switch-session',
        'provider-switch-user',
        'openrouter',
        'openrouter/test-model',
        'medium',
        'Provider switch session',
        now,
        now,
      );
    } finally {
      sqlite.close();
    }

    const { resolveAgentSessionWorkspaceForUser } = await import('../app/lib/pi/session-workspace-context');
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: 'provider-switch-user',
    });
    assert.ok(workspace.organizationId);

    const { parseAiCatalogUpdate, replaceAiAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-service');
    const openRouterInstallationId = providerInstallationId(workspace.organizationId, 'openrouter');
    const groqInstallationId = providerInstallationId(workspace.organizationId, 'groq');
    await replaceAiAppRuntimeCatalog({
      organizationId: workspace.organizationId,
      actorUserId: 'provider-switch-user',
      update: parseAiCatalogUpdate({
        expectedRevision: 0,
        providers: [
          {
            providerInstallationId: openRouterInstallationId,
            providerId: 'openrouter',
            enabled: true,
            credentialScope: 'system',
            config: {},
            modelIds: ['openrouter/test-model'],
            defaultModelId: 'openrouter/test-model',
          },
          {
            providerInstallationId: groqInstallationId,
            providerId: 'groq',
            enabled: true,
            credentialScope: 'system',
            config: {},
            modelIds: ['groq/test-model'],
            defaultModelId: 'groq/test-model',
          },
        ],
        defaultSelection: {
          providerInstallationId: openRouterInstallationId,
          providerId: 'openrouter',
          modelId: 'openrouter/test-model',
          thinkingLevel: 'medium',
        },
      }),
      discovery: {
        openrouter: {
          id: 'openrouter',
          name: 'OpenRouter',
          source: 'built-in',
          models: [{
            id: 'openrouter/test-model',
            name: 'OpenRouter Test Model',
            reasoning: true,
            supportsVision: false,
          }],
        },
        groq: {
          id: 'groq',
          name: 'Groq',
          source: 'built-in',
          models: [{
            id: 'groq/test-model',
            name: 'Groq Test Model',
            reasoning: true,
            supportsVision: false,
          }],
        },
      },
    });
    const catalogSqlite = new Database(path.join(tempRoot, 'sqlite.db'));
    try {
      catalogSqlite.prepare(`
        UPDATE ai_provider_installations
        SET status = 'ready', verified_at = ?
        WHERE id IN (?, ?)
      `).run(Date.now(), openRouterInstallationId, groqInstallationId);
    } finally {
      catalogSqlite.close();
    }

    const { writePiRuntimeConfig, readPiRuntimeConfig } = await import('../app/lib/agents/storage');
    await writePiRuntimeConfig({
      version: 2,
      activeProvider: 'openrouter',
      providers: {
        openrouter: {
          id: 'openrouter',
          model: 'openrouter/test-model',
          thinking: 'medium',
          enabledTools: [],
        },
        groq: {
          id: 'groq',
          model: 'groq/test-model',
          thinking: 'high',
          enabledTools: [],
        },
      },
      enabledSkills: [],
      updatedAt: new Date(now).toISOString(),
      updatedBy: 'test',
    });

    const { auth } = await import('../app/lib/auth');
    const currentSession: RouteSession = {
      user: {
        id: 'provider-switch-user',
        email: 'provider-switch@example.test',
        name: 'Provider Switch User',
        role: 'admin',
      },
      session: { id: 'provider-switch-auth-session' },
    };
    Reflect.set(auth.api, 'getSession', async () => currentSession);

    const sessionsRoute = await import('../app/api/sessions/route');
    const response = await sessionsRoute.PATCH(new NextRequest('http://localhost:3000/api/sessions', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'canvas-agent',
        sessionId: 'provider-switch-session',
        provider: 'groq',
        model: 'groq/test-model',
        thinkingLevel: 'high',
      }),
    }));
    const payload = await response.json() as {
      success?: boolean;
      error?: string;
      session?: { provider?: string; model?: string; thinkingLevel?: string };
    };

    assert.equal(response.status, 200, payload.error || 'Provider switch request failed');
    assert.equal(payload.success, true);
    assert.equal(payload.session?.provider, 'groq');
    assert.equal(payload.session?.model, 'groq/test-model');
    assert.equal(payload.session?.thinkingLevel, 'high');

    const savedConfig = await readPiRuntimeConfig();
    assert.equal(savedConfig.activeProvider, 'openrouter');
    assert.equal(savedConfig.providers.groq?.model, 'groq/test-model');
    assert.equal(savedConfig.providers.groq?.thinking, 'high');

    console.log('pi-session-provider-switch-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousCanvasDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousCanvasDataRoot;
    if (previousBetterAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previousBetterAuthUrl;
    if (previousOpenRouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterApiKey;
    if (previousGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroqApiKey;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
