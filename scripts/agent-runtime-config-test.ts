import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BRADLEY_IDENTITY_PROMPT_MARKER,
  BRADLEY_IDENTITY_SYSTEM_PROMPT,
} from '../app/lib/agents/bradley-identity';

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
  const piAiMock = {
    completeSimple: async () => ({
      message: { role: 'assistant', content: 'Mock completion' },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
    streamSimple: async function* () {},
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
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return piAiMock;
    }
    if (request === '@earendil-works/pi-ai/oauth') {
      return {};
    }
    if (request === '@earendil-works/pi-agent-core') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
  const { SKILL_TOOL_NAMES } = await import('../app/lib/pi/toolsets');
  const {
    DEFAULT_MANAGED_AGENT_ID,
    PI_RUNTIME_CONFIG_PATH,
    isWritableManagedAgentFileName,
    readManagedAgentFile,
    resetManagedAgentFile,
    writeManagedAgentFile,
    writePiRuntimeConfig,
  } = await import('../app/lib/agents/storage');
  const { createAgentProfile, getAgentProfile, updateAgentProfile } = await import('../app/lib/agents/registry');
  const { resolveAgentRuntimeSettings } = await import('../app/lib/agents/effective-runtime-config');
  const { loadManagedAgentSystemPrompt } = await import('../app/lib/agents/system-prompt');
  const {
    formatImageInputUnsupportedError,
    getCanvasControlPlaneModels,
    isImageInputUnsupportedError,
    modelSupportsImageInput,
    modelSupportsVision,
    resolveModelInputModalities,
    resolvePiModel,
  } = await import('../app/lib/pi/model-resolver');
  const { db } = await import('../app/lib/db');
  const { user: users, piSessions } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const { MAX_COMPOSED_SYSTEM_PROMPT_BYTES } = await import('../app/lib/agents/managed-file-limits');
  const {
    CANVAS_MARKDOWN_AGENT_GUIDANCE,
    CANVAS_MARKDOWN_GUIDANCE_MARKER,
  } = await import('../app/lib/markdown/canvas-markdown-agent-guidance');
  const {
    createPiSystemPromptSnapshot,
    ensurePiSessionSystemPromptSnapshot,
    hashPiSystemPrompt,
    piSystemPromptSnapshotDbFields,
  } = await import('../app/lib/pi/system-prompt-snapshot');

  const unconfiguredSettings = await resolveAgentRuntimeSettings(DEFAULT_MANAGED_AGENT_ID);
  assert.equal(unconfiguredSettings.activeProvider, DEFAULT_PI_CONFIG.activeProvider);
  assert.equal(unconfiguredSettings.providerConfig.model, '');
  assert.equal(unconfiguredSettings.setupState.modelConfigured, false);

  const configuredPiConfig = {
    ...DEFAULT_PI_CONFIG,
    activeProvider: 'google',
    providers: {
      ...DEFAULT_PI_CONFIG.providers,
      google: {
        ...DEFAULT_PI_CONFIG.providers.google,
        model: 'gemini-1.5-pro',
        thinking: 'off' as const,
        enabledTools: ['read', 'ls'],
      },
      openrouter: {
        ...DEFAULT_PI_CONFIG.providers.openrouter,
        enabledTools: ['bash'],
      },
    },
  };
  await writePiRuntimeConfig(configuredPiConfig);
  assert.equal(PI_RUNTIME_CONFIG_PATH, path.join(dataDir, 'settings', 'pi-runtime-config.json'));
  assert.ok(await fs.stat(PI_RUNTIME_CONFIG_PATH));
  const expectedGoogleTools = ['read', 'ls', ...SKILL_TOOL_NAMES];
  const persistedPiConfig = JSON.parse(await fs.readFile(PI_RUNTIME_CONFIG_PATH, 'utf8'));
  assert.equal(persistedPiConfig.runtimeMigrations?.skillToolsDefaultEnabled, true);
  assert.deepEqual(persistedPiConfig.providers.google.enabledTools, expectedGoogleTools);

  await fs.rm(PI_RUNTIME_CONFIG_PATH, { force: true });
  await fs.mkdir(path.join(dataDir, 'canvas-agent'), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'canvas-agent', 'pi-runtime-config.json'),
    `${JSON.stringify(configuredPiConfig, null, 2)}\n`,
    'utf8',
  );
  const migratedRuntimeSettings = await resolveAgentRuntimeSettings(DEFAULT_MANAGED_AGENT_ID);
  assert.equal(migratedRuntimeSettings.activeProvider, 'google');
  assert.ok(await fs.stat(PI_RUNTIME_CONFIG_PATH));

  await fs.mkdir(path.join(dataDir, 'canvas-agent'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'canvas-agent', 'MEMORY.md'), 'Legacy runtime memory.\n', 'utf8');
  assert.equal((await readManagedAgentFile('MEMORY.md', DEFAULT_MANAGED_AGENT_ID)).trim(), 'Legacy runtime memory.');
  assert.equal(
    (await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', 'MEMORY.md'), 'utf8')).trim(),
    'Legacy runtime memory.',
  );

  const seedContentFor = async (fileName: string) => {
    const seedPath = path.join(process.cwd(), 'seed_sys_prompts', fileName);
    try {
      const seedContent = await fs.readFile(seedPath, 'utf8');
      return seedContent.endsWith('\n') || seedContent.length === 0 ? seedContent : `${seedContent}\n`;
    } catch {
      return '';
    }
  };
  const resetRegressionFiles = ['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;
  for (const fileName of resetRegressionFiles) {
    await fs.writeFile(path.join(dataDir, 'canvas-agent', fileName), `Legacy ${fileName} should not return after reset.\n`, 'utf8');
    await writeManagedAgentFile(fileName, `Customized ${fileName}.\n`, DEFAULT_MANAGED_AGENT_ID);

    const expectedSeed = await seedContentFor(fileName);
    assert.equal(await resetManagedAgentFile(fileName, DEFAULT_MANAGED_AGENT_ID), expectedSeed);
    assert.equal(await readManagedAgentFile(fileName, DEFAULT_MANAGED_AGENT_ID), expectedSeed);
    assert.equal(
      await fs.readFile(path.join(dataDir, 'agents', 'canvas-agent', fileName), 'utf8'),
      expectedSeed,
    );
  }

  await fs.writeFile(path.join(dataDir, 'canvas-agent', 'USER.md'), 'Legacy user profile should not leak.\n', 'utf8');
  const scopedUserId = 'runtime-user-a';
  await db.insert(users).values({
    id: scopedUserId,
    name: 'Runtime User A',
    email: 'runtime-user-a@example.test',
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.doesNotMatch(
    await readManagedAgentFile('USER.md', DEFAULT_MANAGED_AGENT_ID, { userId: scopedUserId }),
    /Legacy user profile should not leak/,
  );
  await writeManagedAgentFile('AGENTS.md', 'Scoped runtime prompt.\n', DEFAULT_MANAGED_AGENT_ID, {
    userId: scopedUserId,
  });
  const scopedPrompt = await loadManagedAgentSystemPrompt(DEFAULT_MANAGED_AGENT_ID, { userId: scopedUserId });
  assert.match(scopedPrompt.systemPrompt, /Scoped runtime prompt/);
  assert.match(scopedPrompt.systemPrompt, /## Authenticated User Context/);
  assert.match(scopedPrompt.systemPrompt, /User display name: "Runtime User A"/);
  assert.match(scopedPrompt.systemPrompt, /## AGENTS\.md\n\nScoped runtime prompt\./);
  assert.match(scopedPrompt.systemPrompt, /canvas-bradley-identity:v1/);
  assert.ok(
    scopedPrompt.systemPrompt.indexOf(BRADLEY_IDENTITY_SYSTEM_PROMPT)
      < scopedPrompt.systemPrompt.indexOf('## AGENTS.md'),
  );
  assert.doesNotMatch(scopedPrompt.systemPrompt, /Source: /);
  const providedNamePrompt = await loadManagedAgentSystemPrompt(DEFAULT_MANAGED_AGENT_ID, {
    userId: scopedUserId,
    userName: ' Runtime\nDisplay ',
  });
  assert.match(providedNamePrompt.systemPrompt, /User display name: "Runtime Display"/);
  assert.match(
    await fs.readFile(path.join(dataDir, 'users', scopedUserId, 'agents', 'canvas-agent', 'AGENTS.md'), 'utf8'),
    /Scoped runtime prompt/,
  );
  const originalConsoleError = console.error;
  let invalidPromptFallback: Awaited<ReturnType<typeof loadManagedAgentSystemPrompt>>;
  try {
    console.error = () => undefined;
    invalidPromptFallback = await loadManagedAgentSystemPrompt('../invalid-agent');
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(invalidPromptFallback.diagnostics.usedFallback, true);
  assert.match(invalidPromptFallback.systemPrompt, /^<!-- canvas-system-prompt-foundation:v2 -->\n\n# Canvas Notebook Runtime/);
  assert.doesNotMatch(invalidPromptFallback.systemPrompt, /canvas-bradley-identity/u);
  assert.doesNotMatch(invalidPromptFallback.systemPrompt, /## File Access for Uploaded Attachments/);
  let canvasPromptFallback: Awaited<ReturnType<typeof loadManagedAgentSystemPrompt>>;
  try {
    console.error = () => undefined;
    canvasPromptFallback = await loadManagedAgentSystemPrompt(DEFAULT_MANAGED_AGENT_ID, {
      userId: '../invalid-user',
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(canvasPromptFallback.diagnostics.usedFallback, true);
  assert.match(canvasPromptFallback.systemPrompt, /canvas-bradley-identity:v1/u);
  await assert.rejects(
    () => writeManagedAgentFile('AGENTS.md', 'Invalid scoped prompt.\n', DEFAULT_MANAGED_AGENT_ID, {
      userId: '../other-user',
    }),
    /Invalid userId/,
  );

  const inheritedAgent = await createAgentProfile({ name: 'Inherited Agent' });
  assert.equal(inheritedAgent.iconId, 'bot');
  assert.equal(isWritableManagedAgentFileName('USER.md', inheritedAgent.agentId), false);
  assert.equal(isWritableManagedAgentFileName('MEMORY.md', inheritedAgent.agentId), true);
  const inheritedConfig = await resolveAgentRuntimeSettings(inheritedAgent.agentId);
  assert.equal(inheritedConfig.activeProvider, 'google');
  assert.equal(inheritedConfig.providerConfig.model, 'gemini-1.5-pro');
  assert.equal(inheritedConfig.thinkingLevel, 'off');
  assert.deepEqual(inheritedConfig.enabledTools, expectedGoogleTools);
  assert.deepEqual(inheritedConfig.overrideState, { model: false, tools: false });

  const customAgent = await createAgentProfile({
    name: 'Custom Agent',
    iconId: 'sparkles',
    defaultProviderInstallationId: `aip_${'a'.repeat(24)}`,
    defaultProvider: 'openrouter',
    defaultModel: DEFAULT_PI_CONFIG.providers.openrouter.model,
    defaultThinking: 'high',
    enabledTools: ['bash'],
    relevantSkills: ['research-notes'],
    relevantConnections: ['mcp:Docs', 'composio:slack'],
  });
  const customProfile = await getAgentProfile(customAgent.agentId);
  assert.equal(customProfile?.iconId, 'sparkles');
  assert.deepEqual(customProfile?.relevantSkills, ['research-notes']);
  assert.deepEqual(customProfile?.relevantConnections, ['mcp:Docs', 'composio:slack']);
  const customConfig = await resolveAgentRuntimeSettings(customAgent.agentId);
  assert.equal(customConfig.activeProvider, 'openrouter');
  assert.equal(customConfig.providerConfig.model, DEFAULT_PI_CONFIG.providers.openrouter.model);
  assert.equal(customConfig.thinkingLevel, 'high');
  assert.deepEqual(customConfig.enabledTools, ['bash']);
  assert.deepEqual(customConfig.overrideState, { model: true, tools: true });
  const customToolPrompt = await loadManagedAgentSystemPrompt(customAgent.agentId);
  assert.doesNotMatch(customToolPrompt.systemPrompt, /## Agent-Enabled Runtime Tools/);
  assert.doesNotMatch(customToolPrompt.systemPrompt, /`bash`/);

  const mcpAgent = await createAgentProfile({
    name: 'MCP Agent',
    enabledTools: ['mcp'],
  });
  const mcpPrompt = await loadManagedAgentSystemPrompt(mcpAgent.agentId);
  assert.doesNotMatch(mcpPrompt.systemPrompt, /## Agent-Enabled Runtime Tools/);
  assert.doesNotMatch(mcpPrompt.systemPrompt, /Connector Discovery Hints/);

  const restrictedEmailAgent = await createAgentProfile({
    name: 'Restricted Email Agent',
    enabledTools: ['email_search_messages'],
  });
  const restrictedEmailPrompt = await loadManagedAgentSystemPrompt(restrictedEmailAgent.agentId);
  assert.doesNotMatch(restrictedEmailPrompt.systemPrompt, /`email_search_messages`/);
  assert.doesNotMatch(restrictedEmailPrompt.systemPrompt, /email_send_draft/);

  const legacyAgent = await createAgentProfile({
    name: 'Legacy OpenRouter Agent',
    defaultProviderInstallationId: `aip_${'b'.repeat(24)}`,
    defaultProvider: 'openrouter',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    defaultThinking: 'off',
  });
  const legacyConfig = await resolveAgentRuntimeSettings(legacyAgent.agentId);
  assert.equal(legacyConfig.activeProvider, 'openrouter');
  assert.equal(legacyConfig.providerConfig.model, 'anthropic/claude-3.5-sonnet');
  assert.equal(
    (await resolvePiModel(legacyConfig.activeProvider, legacyConfig.providerConfig.model)).id,
    'anthropic/claude-sonnet-4.5',
  );

  const directOllamaModel = await resolvePiModel('ollama', 'deepseek-r1:32b');
  const directOllamaCompat = (directOllamaModel as OpenAICompletionsCompatProbe).compat;
  assert.equal(directOllamaCompat?.supportsDeveloperRole, false);
  assert.equal(directOllamaCompat?.supportsReasoningEffort, false);
  assert.equal(modelSupportsVision('kimi-k2.6:cloud'), true);
  assert.equal(modelSupportsVision('moonshotai/kimi-k2.6'), true);
  assert.equal(modelSupportsImageInput({ id: 'x-ai/grok-4.20-reasoning', input: ['text'] }), true);
  assert.equal(modelSupportsImageInput({ id: 'x-ai/grok-code-fast-1', input: ['text'] }), false);
  assert.deepEqual(
    resolveModelInputModalities({
      id: 'openrouter/example-vision-model',
      input: ['text'],
      architecture: { input_modalities: ['text', 'image'] },
    }),
    ['text', 'image'],
  );
  assert.equal(isImageInputUnsupportedError('Invalid request content: Image inputs are not supported by this model.'), true);
  assert.match(
    formatImageInputUnsupportedError({
      provider: 'openrouter',
      modelId: 'x-ai/grok-code-fast-1',
      message: 'Image inputs are not supported by this model.',
    }),
    /rejected the attached image input/,
  );
  const kimiVisionModel = await resolvePiModel('ollama', 'kimi-k2.6:cloud');
  assert.deepEqual(kimiVisionModel.input, ['text', 'image']);

  await updateAgentProfile({
    agentId: customAgent.agentId,
    iconId: 'briefcase',
    defaultProviderInstallationId: null,
    defaultProvider: null,
    defaultModel: null,
    defaultThinking: null,
    enabledTools: null,
  });
  const updatedCustomProfile = await getAgentProfile(customAgent.agentId);
  assert.equal(updatedCustomProfile?.iconId, 'briefcase');
  const clearedConfig = await resolveAgentRuntimeSettings(customAgent.agentId);
  assert.equal(clearedConfig.activeProvider, 'google');
  assert.equal(clearedConfig.providerConfig.model, 'gemini-1.5-pro');
  assert.deepEqual(clearedConfig.enabledTools, expectedGoogleTools);
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
  await fs.mkdir(path.join(dataDir, 'skills', 'general-helper'), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'skills', 'general-helper', 'SKILL.md'),
    [
      '---',
      'name: general-helper',
      'description: General helper skill for broad workspace tasks.',
      '---',
      '',
      '# General Helper',
    ].join('\n'),
    'utf8',
  );
  const prompt = await loadManagedAgentSystemPrompt(customAgent.agentId);
  assert.doesNotMatch(prompt.systemPrompt, /# Agent-Relevant Skills/);
  assert.match(prompt.systemPrompt, /# Enabled Skills/);
  assert.match(prompt.systemPrompt, /## Skill: research-notes/);
  assert.doesNotMatch(prompt.systemPrompt, /general-helper/);
  assert.doesNotMatch(prompt.systemPrompt, /## Prioritized Apps & MCP/);
  assert.doesNotMatch(prompt.systemPrompt, /Docs/);
  assert.doesNotMatch(prompt.systemPrompt, /slack/);

  const inheritedPrompt = await loadManagedAgentSystemPrompt(inheritedAgent.agentId);
  assert.match(inheritedPrompt.systemPrompt, /## Skill: research-notes/);
  assert.match(inheritedPrompt.systemPrompt, /## Skill: general-helper/);

  const canvasPrompt = await loadManagedAgentSystemPrompt(DEFAULT_MANAGED_AGENT_ID);
  assert.match(canvasPrompt.systemPrompt, /## Skill: research-notes/);
  assert.match(canvasPrompt.systemPrompt, /## Skill: general-helper/);
  assert.match(canvasPrompt.systemPrompt, /canvas-bradley-identity:v1/u);

  await writeManagedAgentFile('AGENTS.md', 'Original session prompt.\n', customAgent.agentId);
  const originalSnapshot = await createPiSystemPromptSnapshot(customAgent.agentId);
  assert.match(originalSnapshot.systemPrompt, /Original session prompt/);

  await db.insert(users).values({
    id: 'snapshot-user',
    name: 'Snapshot User',
    email: 'snapshot@example.test',
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(piSessions).values({
    sessionId: 'snapshotted-session',
    userId: 'snapshot-user',
    agentId: customAgent.agentId,
    provider: 'google',
    model: 'gemini-1.5-pro',
    thinkingLevel: 'off',
    title: 'Snapshot Test',
    channelId: 'app',
    channelSessionKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...piSystemPromptSnapshotDbFields(originalSnapshot),
  });

  await writeManagedAgentFile('AGENTS.md', 'Changed after session start.\n', customAgent.agentId);
  const snapshottedSession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'snapshotted-session'),
  });
  assert.ok(snapshottedSession);
  const storedSnapshot = await ensurePiSessionSystemPromptSnapshot(snapshottedSession);
  assert.equal(storedSnapshot.systemPrompt, originalSnapshot.systemPrompt);
  assert.doesNotMatch(storedSnapshot.systemPrompt, /Changed after session start/);
  assert.match(storedSnapshot.systemPrompt, new RegExp(CANVAS_MARKDOWN_GUIDANCE_MARKER));

  const preMarkdownGuidancePrompt = originalSnapshot.systemPrompt.replace(
    `${CANVAS_MARKDOWN_AGENT_GUIDANCE}\n\n`,
    '',
  );
  await db.insert(piSessions).values({
    sessionId: 'pre-markdown-guidance-session',
    userId: 'snapshot-user',
    agentId: customAgent.agentId,
    provider: 'google',
    model: 'gemini-1.5-pro',
    thinkingLevel: 'off',
    title: 'Prompt Guidance Migration Test',
    channelId: 'app',
    channelSessionKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    systemPromptSnapshot: preMarkdownGuidancePrompt,
    systemPromptSnapshotHash: hashPiSystemPrompt(preMarkdownGuidancePrompt),
    systemPromptSnapshotCreatedAt: new Date(),
  });
  const preMarkdownGuidanceSession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'pre-markdown-guidance-session'),
  });
  assert.ok(preMarkdownGuidanceSession);
  const migratedGuidanceSnapshot = await ensurePiSessionSystemPromptSnapshot(preMarkdownGuidanceSession);
  assert.match(migratedGuidanceSnapshot.systemPrompt, new RegExp(CANVAS_MARKDOWN_GUIDANCE_MARKER));
  assert.match(migratedGuidanceSnapshot.systemPrompt, /Original session prompt/);
  assert.doesNotMatch(migratedGuidanceSnapshot.systemPrompt, /Changed after session start/);

  const preBradleyIdentityPrompt = canvasPrompt.systemPrompt.replace(
    `${BRADLEY_IDENTITY_SYSTEM_PROMPT}\n\n`,
    '',
  );
  assert.doesNotMatch(preBradleyIdentityPrompt, /canvas-bradley-identity/u);
  await db.insert(piSessions).values({
    sessionId: 'pre-bradley-identity-session',
    userId: 'snapshot-user',
    agentId: DEFAULT_MANAGED_AGENT_ID,
    provider: 'google',
    model: 'gemini-1.5-pro',
    thinkingLevel: 'off',
    title: 'Bradley Identity Migration Test',
    channelId: 'app',
    channelSessionKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    systemPromptSnapshot: preBradleyIdentityPrompt,
    systemPromptSnapshotHash: hashPiSystemPrompt(preBradleyIdentityPrompt),
    systemPromptSnapshotCreatedAt: new Date(),
  });
  const preBradleyIdentitySession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'pre-bradley-identity-session'),
  });
  assert.ok(preBradleyIdentitySession);
  const migratedBradleySnapshot = await ensurePiSessionSystemPromptSnapshot(preBradleyIdentitySession);
  assert.match(migratedBradleySnapshot.systemPrompt, new RegExp(BRADLEY_IDENTITY_PROMPT_MARKER));
  assert.match(migratedBradleySnapshot.systemPrompt, /## Skill: research-notes/u);
  assert.equal(
    migratedBradleySnapshot.systemPrompt.split(BRADLEY_IDENTITY_SYSTEM_PROMPT).length - 1,
    1,
  );

  const oversizedStoredPrompt = 'x'.repeat(MAX_COMPOSED_SYSTEM_PROMPT_BYTES + 1_024);
  await db.insert(piSessions).values({
    sessionId: 'oversized-snapshot-session',
    userId: 'snapshot-user',
    agentId: customAgent.agentId,
    provider: 'google',
    model: 'gemini-1.5-pro',
    thinkingLevel: 'off',
    title: 'Oversized Snapshot Test',
    channelId: 'app',
    channelSessionKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    systemPromptSnapshot: oversizedStoredPrompt,
    systemPromptSnapshotHash: hashPiSystemPrompt(oversizedStoredPrompt),
    systemPromptSnapshotCreatedAt: new Date(),
  });
  const oversizedSession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'oversized-snapshot-session'),
  });
  assert.ok(oversizedSession);
  const boundedSnapshot = await ensurePiSessionSystemPromptSnapshot(oversizedSession);
  assert.ok(Buffer.byteLength(boundedSnapshot.systemPrompt, 'utf8') <= MAX_COMPOSED_SYSTEM_PROMPT_BYTES);
  assert.match(boundedSnapshot.systemPrompt, /<!-- canvas-system-prompt-foundation:v2 -->/);
  const persistedBoundedSession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'oversized-snapshot-session'),
  });
  assert.equal(persistedBoundedSession?.systemPromptSnapshot, boundedSnapshot.systemPrompt);
  assert.equal(persistedBoundedSession?.systemPromptSnapshotHash, boundedSnapshot.systemPromptHash);

  await writeManagedAgentFile('AGENTS.md', 'Snapshot user scoped prompt.\n', customAgent.agentId, {
    userId: 'snapshot-user',
  });
  await db.insert(piSessions).values({
    sessionId: 'legacy-unsnapshotted-session',
    userId: 'snapshot-user',
    agentId: customAgent.agentId,
    provider: 'google',
    model: 'gemini-1.5-pro',
    thinkingLevel: 'off',
    title: 'Legacy Snapshot Test',
    channelId: 'app',
    channelSessionKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const legacySession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'legacy-unsnapshotted-session'),
  });
  assert.ok(legacySession);
  const legacySnapshot = await ensurePiSessionSystemPromptSnapshot(legacySession);
  assert.match(legacySnapshot.systemPrompt, /Snapshot user scoped prompt/);
  assert.match(legacySnapshot.systemPrompt, /User display name: "Snapshot User"/);
  assert.doesNotMatch(legacySnapshot.systemPrompt, /Changed after session start/);
  const updatedLegacySession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, 'legacy-unsnapshotted-session'),
  });
  assert.ok(updatedLegacySession?.systemPromptSnapshot);
  assert.equal(
    updatedLegacySession.systemPromptSnapshotHash,
    hashPiSystemPrompt(updatedLegacySession.systemPromptSnapshot),
  );

  await fs.rm(PI_RUNTIME_CONFIG_PATH, { force: true });
  await fs.rm(path.join(dataDir, 'canvas-agent', 'pi-runtime-config.json'), { force: true });
  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
  process.env.CANVAS_CONTROL_PLANE_URL = 'https://control-plane.example.test';
  process.env.CANVAS_INSTANCE_TOKEN = 'instance-token';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    catalogRevision: 'runtime-config-test-revision',
    defaultModelId: 'deepseek-v4-flash',
    defaultThinkingLevel: 'medium',
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

    const managedModel = await resolvePiModel(
      managedSettings.activeProvider,
      managedSettings.providerConfig.model,
    );
    assert.equal(managedModel.id, 'deepseek-v4-flash');
    const managedCompat = (managedModel as OpenAICompletionsCompatProbe).compat;
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
