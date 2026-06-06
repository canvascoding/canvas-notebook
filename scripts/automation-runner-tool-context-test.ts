import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-runner-tools-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.QMD_ENABLED = 'false';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;

const toolCalls: Array<{
  userId: string | undefined;
  agentId: string | null | undefined;
  sessionId: string | null | undefined;
}> = [];
let agentLoopToolNames: string[] = [];

const testModel = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'test-provider',
  api: 'openai-completions',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};

moduleInternals._load = (request, parent, isMain) => {
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/oauth') {
    return {
      registerBuiltInApiProviders() {},
      getProviders() {
        return [];
      },
      getModels() {
        return [];
      },
    };
  }

  if (request === '@earendil-works/pi-agent-core') {
    return {
      agentLoop: async function* agentLoopStub(_messages: unknown[], context: { tools?: Array<{ name: string }> }) {
        agentLoopToolNames = context.tools?.map((tool) => tool.name) ?? [];
        yield {
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Automation finished.' }],
              api: testModel.api,
              provider: testModel.provider,
              model: testModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: Date.now(),
            },
          ],
        };
      },
    };
  }

  if (
    request === '@/app/lib/agents/effective-runtime-config' ||
    request === './effective-runtime-config' ||
    request.endsWith('/agents/effective-runtime-config')
  ) {
    return {
      resolveAgentRuntimeConfig: async () => ({
        activeProvider: testModel.provider,
        providerConfig: { thinking: 'off' },
        model: testModel,
      }),
    };
  }

  if (request === '@/app/lib/agents/system-prompt' || request.endsWith('/agents/system-prompt')) {
    return {
      loadManagedAgentSystemPrompt: async () => ({
        systemPrompt: '',
        diagnostics: {
          loadedFiles: [],
          includedFiles: [],
          emptyFiles: [],
          usedFallback: false,
        },
      }),
    };
  }

  if (
    request === '@/app/lib/pi/api-key-resolver' ||
    request === './api-key-resolver' ||
    request.endsWith('/pi/api-key-resolver')
  ) {
    return { resolvePiApiKey: async () => undefined };
  }

  if (request === '@/app/lib/pi/message-normalization' || request.endsWith('/pi/message-normalization')) {
    return { normalizePiMessagesForLlm: async (messages: unknown[]) => messages };
  }

  if (request === '@/app/lib/pi/tool-registry' || request.endsWith('/pi/tool-registry')) {
    return {
      getPiTools: async (userId?: string, agentId?: string | null, sessionId?: string | null) => {
        toolCalls.push({ userId, agentId, sessionId });
        return [
          {
            name: 'studio_generate_image',
            label: 'Generating studio image',
            description: 'Test studio image tool',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
          },
        ];
      },
    };
  }

  if (request === '@/app/lib/pi/model-resolver' || request.endsWith('/pi/model-resolver')) {
    return { CANVAS_CONTROL_PLANE_PROVIDER_ID: 'canvas-control-plane' };
  }

  return originalLoad(request, parent, isMain);
};

async function main() {
  const userId = 'automation-tool-user';
  const agentId = 'canvas-agent';
  const now = new Date();

  const { db } = await import('../app/lib/db');
  const { user, piSessions } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const { createAutomationJob, getAutomationRun, scheduleAutomationJobRun } = await import('../app/lib/automations/store');
  const { executeAutomationRun } = await import('../app/lib/automations/runner');

  await db.insert(user).values({
    id: userId,
    name: 'Automation Tool User',
    email: 'automation-tool-user@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const job = await createAutomationJob(
    {
      name: 'Image Automation',
      prompt: 'Generate an image through Studio.',
      preferredSkill: 'auto',
      workspaceContextPaths: [],
      targetOutputPath: null,
      agentId,
      deliveryMode: 'web',
      deliverySessionMode: 'new_session',
      schedule: { kind: 'interval', every: 1, unit: 'hours', timeZone: 'UTC' },
    },
    userId,
  );
  const run = await scheduleAutomationJobRun(job.id, 'manual', now);
  assert.ok(run);

  await executeAutomationRun(run.id);

  assert.deepEqual(toolCalls, [{ userId, agentId, sessionId: `auto-${run.id.replace(/^run-/, '')}` }]);
  assert.deepEqual(agentLoopToolNames, ['studio_generate_image']);

  const finishedRun = await getAutomationRun(run.id);
  assert.equal(finishedRun?.status, 'success');
  assert.equal(finishedRun?.errorMessage, null);

  const session = await db.query.piSessions.findFirst({
    where: eq(piSessions.userId, userId),
  });
  assert.equal(session?.userId, userId);
  assert.equal(session?.agentId, agentId);

  console.log('automation-runner-tool-context-test: ok');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
