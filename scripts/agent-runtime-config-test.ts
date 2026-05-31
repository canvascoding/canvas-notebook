import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type OpenAICompletionsCompatProbe = {
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsStore?: boolean;
    thinkingFormat?: string;
  };
};

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
          if (provider === 'openrouter') return [
            model(provider, 'anthropic/claude-sonnet-4.5'),
            model(provider, 'anthropic/claude-3.7-sonnet'),
          ];
          return [];
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
  const {
    DEFAULT_MANAGED_AGENT_ID,
    PI_RUNTIME_CONFIG_PATH,
    isWritableManagedAgentFileName,
    readManagedAgentFile,
    writePiRuntimeConfig,
  } = await import('../app/lib/agents/storage');
  const { createAgentProfile, getAgentProfile, updateAgentProfile } = await import('../app/lib/agents/registry');
  const { resolveAgentRuntimeConfig, resolveAgentRuntimeSettings } = await import('../app/lib/agents/effective-runtime-config');
  const { loadManagedAgentSystemPrompt } = await import('../app/lib/agents/system-prompt');
  const { getCanvasControlPlaneModels, resolvePiModel } = await import('../app/lib/pi/model-resolver');

  const unconfiguredSettings = await resolveAgentRuntimeSettings(DEFAULT_MANAGED_AGENT_ID);
  assert.equal(unconfiguredSettings.activeProvider, DEFAULT_PI_CONFIG.activeProvider);
  assert.equal(unconfiguredSettings.providerConfig.model, '');
  assert.equal(unconfiguredSettings.setupState.modelConfigured, false);
  await assert.rejects(
    () => resolveAgentRuntimeConfig(DEFAULT_MANAGED_AGENT_ID),
    /No model selected/,
  );

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
  assert.equal(inheritedAgent.iconId, 'bot');
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
    iconId: 'sparkles',
    defaultProvider: 'openrouter',
    defaultModel: DEFAULT_PI_CONFIG.providers.openrouter.model,
    defaultThinking: 'high',
    enabledTools: ['bash'],
    relevantSkills: ['research-notes'],
  });
  const customProfile = await getAgentProfile(customAgent.agentId);
  assert.equal(customProfile?.iconId, 'sparkles');
  assert.deepEqual(customProfile?.relevantSkills, ['research-notes']);
  const customConfig = await resolveAgentRuntimeConfig(customAgent.agentId);
  assert.equal(customConfig.activeProvider, 'openrouter');
  assert.equal(customConfig.model.id, DEFAULT_PI_CONFIG.providers.openrouter.model);
  assert.equal(customConfig.thinkingLevel, 'high');
  assert.deepEqual(customConfig.enabledTools, ['bash']);
  assert.deepEqual(customConfig.overrideState, { model: true, tools: true });

  const legacyAgent = await createAgentProfile({
    name: 'Legacy OpenRouter Agent',
    defaultProvider: 'openrouter',
    defaultModel: 'anthropic/claude-3.5-sonnet',
  });
  const legacyConfig = await resolveAgentRuntimeConfig(legacyAgent.agentId);
  assert.equal(legacyConfig.activeProvider, 'openrouter');
  assert.equal(legacyConfig.providerConfig.model, 'anthropic/claude-3.5-sonnet');
  assert.equal(legacyConfig.model.id, 'anthropic/claude-sonnet-4.5');

  const directOllamaModel = await resolvePiModel('ollama', 'deepseek-r1:32b');
  const directOllamaCompat = (directOllamaModel as OpenAICompletionsCompatProbe).compat;
  assert.equal(directOllamaCompat?.supportsDeveloperRole, false);
  assert.equal(directOllamaCompat?.supportsReasoningEffort, false);

  await updateAgentProfile({
    agentId: customAgent.agentId,
    iconId: 'briefcase',
    defaultProvider: null,
    defaultModel: null,
    defaultThinking: null,
    enabledTools: null,
  });
  const updatedCustomProfile = await getAgentProfile(customAgent.agentId);
  assert.equal(updatedCustomProfile?.iconId, 'briefcase');
  const clearedConfig = await resolveAgentRuntimeConfig(customAgent.agentId);
  assert.equal(clearedConfig.activeProvider, 'google');
  assert.equal(clearedConfig.model.id, 'gemini-1.5-pro');
  assert.deepEqual(clearedConfig.enabledTools, ['read', 'ls']);
  assert.deepEqual(clearedConfig.overrideState, { model: false, tools: false });

  await fs.mkdir(path.join(dataDir, 'skills', 'research-notes'), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'skills', 'research-notes', 'SKILL.md'),
    [
      '---',
      'name: research-notes',
      'description: Summarize and organize research material.',
      '---',
      '',
      '# Research Notes',
    ].join('\n'),
    'utf8',
  );
  const prompt = await loadManagedAgentSystemPrompt(customAgent.agentId);
  assert.match(prompt.systemPrompt, /# Agent-Relevant Skills/);
  assert.match(prompt.systemPrompt, /research-notes: Summarize and organize research material/);

  await fs.rm(PI_RUNTIME_CONFIG_PATH, { force: true });
  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
  process.env.CANVAS_CONTROL_PLANE_URL = 'https://control-plane.example.test';
  process.env.CANVAS_INSTANCE_TOKEN = 'instance-token';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        provider: 'openrouter',
        reasoning: true,
      },
      {
        id: 'deepseek-v4-flash:cloud',
        name: 'DeepSeek V4 Flash via Ollama',
        provider: 'openai-compatible',
        reasoning: true,
      },
    ],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const managedSettings = await resolveAgentRuntimeSettings(DEFAULT_MANAGED_AGENT_ID);
    assert.equal(managedSettings.activeProvider, 'canvas-control-plane');
    assert.equal(managedSettings.providerConfig.model, 'deepseek-v4-flash');
    assert.equal(managedSettings.setupState.modelConfigured, true);

    const managedConfig = await resolveAgentRuntimeConfig(DEFAULT_MANAGED_AGENT_ID);
    assert.equal(managedConfig.activeProvider, 'canvas-control-plane');
    assert.equal(managedConfig.model.id, 'deepseek-v4-flash');
    const managedCompat = (managedConfig.model as OpenAICompletionsCompatProbe).compat;
    assert.equal(managedCompat?.supportsDeveloperRole, false);
    assert.equal(managedCompat?.supportsStore, false);
    assert.equal(managedCompat?.thinkingFormat, 'openrouter');

    const managedModels = await getCanvasControlPlaneModels();
    const openAiCompatibleModel = managedModels.find((model) => model.managedProvider === 'openai-compatible');
    const openAiCompatibleCompat = (openAiCompatibleModel as OpenAICompletionsCompatProbe | undefined)?.compat;
    assert.equal(openAiCompatibleCompat?.supportsDeveloperRole, false);
    assert.equal(openAiCompatibleCompat?.supportsReasoningEffort, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
    delete process.env.CANVAS_CONTROL_PLANE_URL;
    delete process.env.CANVAS_INSTANCE_TOKEN;
  }

  moduleInternals._load = originalLoad;
  console.log('agent-runtime-config-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
