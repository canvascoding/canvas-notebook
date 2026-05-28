import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-runtime-'));
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.DATA = dataDir;

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@mariozechner/pi-ai') {
      const model = (provider: string, id: string) => ({
        id,
        name: id,
        provider,
        api: 'openai-completions',
        baseUrl: '',
        reasoning: provider === 'openrouter',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      });
      return {
        registerBuiltInApiProviders: () => undefined,
        getProviders: () => ['google', 'openrouter'],
        getModels: (provider: string) => {
          if (provider === 'google') return [model(provider, 'gemini-1.5-pro')];
          if (provider === 'openrouter') return [model(provider, 'anthropic/claude-3.5-sonnet')];
          return [];
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
  const { DEFAULT_MANAGED_AGENT_ID, isWritableManagedAgentFileName, readManagedAgentFile, writePiRuntimeConfig } = await import('../app/lib/agents/storage');
  const { createAgentProfile, updateAgentProfile } = await import('../app/lib/agents/registry');
  const { resolveAgentRuntimeConfig } = await import('../app/lib/agents/effective-runtime-config');

  await writePiRuntimeConfig({
    ...DEFAULT_PI_CONFIG,
    activeProvider: 'google',
    providers: {
      ...DEFAULT_PI_CONFIG.providers,
      google: {
        ...DEFAULT_PI_CONFIG.providers.google,
        model: 'gemini-1.5-pro',
        thinking: 'off',
        enabledTools: ['read', 'ls'],
      },
      openrouter: {
        ...DEFAULT_PI_CONFIG.providers.openrouter,
        enabledTools: ['bash'],
      },
    },
  });

  await fs.mkdir(path.join(dataDir, 'canvas-agent'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'canvas-agent', 'MEMORY.md'), 'Legacy runtime memory.\n', 'utf8');
  assert.equal((await readManagedAgentFile('MEMORY.md', DEFAULT_MANAGED_AGENT_ID)).trim(), 'Legacy runtime memory.');
  assert.equal(
    (await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'MEMORY.md'), 'utf8')).trim(),
    'Legacy runtime memory.',
  );

  const inheritedAgent = await createAgentProfile({ name: 'Inherited Agent' });
  assert.equal(isWritableManagedAgentFileName('IDENTITY.md', inheritedAgent.agentId), false);
  assert.equal(isWritableManagedAgentFileName('USER.md', inheritedAgent.agentId), false);
  assert.equal(isWritableManagedAgentFileName('MEMORY.md', inheritedAgent.agentId), true);
  assert.equal(isWritableManagedAgentFileName('IDENTITY.md', DEFAULT_MANAGED_AGENT_ID), true);
  const inheritedConfig = await resolveAgentRuntimeConfig(inheritedAgent.agentId);
  assert.equal(inheritedConfig.activeProvider, 'google');
  assert.equal(inheritedConfig.model.id, 'gemini-1.5-pro');
  assert.equal(inheritedConfig.thinkingLevel, 'off');
  assert.deepEqual(inheritedConfig.enabledTools, ['read', 'ls']);
  assert.deepEqual(inheritedConfig.overrideState, { model: false, tools: false });

  const customAgent = await createAgentProfile({
    name: 'Custom Agent',
    defaultProvider: 'openrouter',
    defaultModel: DEFAULT_PI_CONFIG.providers.openrouter.model,
    defaultThinking: 'high',
    enabledTools: ['bash'],
  });
  const customConfig = await resolveAgentRuntimeConfig(customAgent.agentId);
  assert.equal(customConfig.activeProvider, 'openrouter');
  assert.equal(customConfig.model.id, DEFAULT_PI_CONFIG.providers.openrouter.model);
  assert.equal(customConfig.thinkingLevel, 'high');
  assert.deepEqual(customConfig.enabledTools, ['bash']);
  assert.deepEqual(customConfig.overrideState, { model: true, tools: true });

  await updateAgentProfile({
    agentId: customAgent.agentId,
    defaultProvider: null,
    defaultModel: null,
    defaultThinking: null,
    enabledTools: null,
  });
  const clearedConfig = await resolveAgentRuntimeConfig(customAgent.agentId);
  assert.equal(clearedConfig.activeProvider, 'google');
  assert.equal(clearedConfig.model.id, 'gemini-1.5-pro');
  assert.deepEqual(clearedConfig.enabledTools, ['read', 'ls']);
  assert.deepEqual(clearedConfig.overrideState, { model: false, tools: false });

  moduleInternals._load = originalLoad;
  console.log('agent-runtime-config-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
