import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

type RuntimeSelection = {
  providerInstallationId: string;
  providerId: string;
  modelId: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

type RuntimeResolutionContext = {
  organizationId: string;
  userId: string;
  workspaceId: string;
  workspaceType: string;
  agentId: string;
  sessionId: string | null;
  requestedSelection: RuntimeSelection | null;
};

type FileOperationOptions = {
  workspace?: typeof teamWorkspace;
  includeMetadata?: boolean;
};

type TestTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
};

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'canvas-email-ai-runtime-scope-'));
process.env.DATA = tempRoot;
process.env.CANVAS_DATA_ROOT = tempRoot;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

const organizationId = 'org-email-runtime';
const userId = 'user-email-runtime';
const workspaceId = 'workspace-email-team';

const teamWorkspace = {
  organizationId,
  customerId: 'customer-email-runtime',
  projectId: 'project-email-runtime',
  workspaceId,
  workspaceType: 'team' as const,
  displayName: 'Email Runtime Team',
  rootPath: path.join(tempRoot, 'team-root'),
  rootRelativePath: 'workspaces/team/email-runtime',
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: false,
    canRunAgent: true,
  },
  legacy: false,
};

const personalRoot = path.join(tempRoot, 'personal-root');

const selectionA: RuntimeSelection = {
  providerInstallationId: 'aip_email_runtime_a',
  providerId: 'email-provider-a',
  modelId: 'email-model-a',
  thinkingLevel: 'high',
};

const selectionB: RuntimeSelection = {
  providerInstallationId: 'aip_email_runtime_b',
  providerId: 'email-provider-b',
  modelId: 'email-model-b',
  thinkingLevel: 'off',
};

function cloneSelection(selection: RuntimeSelection): RuntimeSelection {
  return { ...selection };
}

function modelFor(selection: RuntimeSelection) {
  return {
    id: selection.modelId,
    name: selection.modelId,
    provider: selection.providerId,
    api: 'openai-completions',
    baseUrl: 'https://email-runtime.example.test/v1',
    reasoning: selection.thinkingLevel !== 'off',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
}

function assistantStream(model: ReturnType<typeof modelFor>) {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Scoped email runtime response' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: 'stop', message };
    },
    result: async () => message,
  };
}

const runtimeResolutionCalls: RuntimeResolutionContext[] = [];
const providerCalls: Array<{
  materializedSelection: RuntimeSelection;
  effectiveSelection: RuntimeSelection;
  modelId: string;
  options?: Record<string, unknown>;
}> = [];
const workspaceResolutionCalls: Array<{ userId: string; workspaceId?: string | null }> = [];
const workspaceFileCalls: Array<{
  operation: string;
  requestedPath: string;
  options?: FileOperationOptions;
  resolvedPath?: string;
}> = [];
const fileReferenceCalls: Array<{ forceRefresh: boolean; options?: FileOperationOptions }> = [];
const forbiddenLoads: string[] = [];

let activePreference = cloneSelection(selectionA);
let workspaceAuthorized = true;

async function resolveExecutableAgentRuntime(context: RuntimeResolutionContext) {
  const recordedContext = {
    ...context,
    requestedSelection: context.requestedSelection
      ? cloneSelection(context.requestedSelection)
      : null,
  };
  runtimeResolutionCalls.push(recordedContext);

  const materializedSelection = cloneSelection(context.requestedSelection ?? activePreference);
  const model = modelFor(materializedSelection);
  const resolvedSelection = {
    selection: materializedSelection,
    catalogRevision: 7,
    policyRevision: 11,
    selectionSource: context.requestedSelection ? 'session' : 'user_preference',
    credentialScope: 'organization',
  };

  return {
    resolution: {
      context,
      catalogRevision: 7,
      policyRevision: 11,
      valid: true,
    },
    selection: resolvedSelection,
    providerInstallation: {
      installationId: materializedSelection.providerInstallationId,
      providerId: materializedSelection.providerId,
    },
    catalogModel: { id: materializedSelection.modelId },
    model,
    getApiKey: async () => undefined,
    streamFn: async (
      requestedModel: ReturnType<typeof modelFor>,
      _context: unknown,
      options?: Record<string, unknown>,
    ) => {
      // Model the production provider-runtime behavior: a requestedSelection is
      // authoritative on every provider turn, while a null selection would
      // inherit the user's mutable preference again.
      const effectiveSelection = cloneSelection(context.requestedSelection ?? activePreference);
      providerCalls.push({
        materializedSelection: cloneSelection(materializedSelection),
        effectiveSelection,
        modelId: requestedModel.id,
        options,
      });
      assert.equal(requestedModel.id, effectiveSelection.modelId);
      return assistantStream(requestedModel);
    },
    requiresRecreation: () => false,
  };
}

async function resolveAgentSessionWorkspaceForUser(input: {
  userId: string;
  workspaceId?: string | null;
}) {
  workspaceResolutionCalls.push({ ...input });
  assert.equal(input.userId, userId);
  assert.equal(input.workspaceId, workspaceId);
  if (!workspaceAuthorized) {
    throw new Error('Workspace permission denied for Email AI.');
  }
  return teamWorkspace;
}

type FakeAgentOptions = {
  initialState: {
    model: ReturnType<typeof modelFor>;
    thinkingLevel?: string;
    systemPrompt: string;
    tools: TestTool[];
  };
  streamFn: (
    model: ReturnType<typeof modelFor>,
    context: unknown,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  sessionId: string;
};

let latestAgentOptions: FakeAgentOptions | null = null;

function requireLatestAgentOptions(): FakeAgentOptions {
  if (!latestAgentOptions) throw new Error('Email Workspace Agent was not constructed.');
  return latestAgentOptions;
}

class FakeAgent {
  readonly state: {
    messages: Array<Record<string, unknown>>;
  };
  private readonly subscribers = new Set<(event: Record<string, unknown>) => void | Promise<void>>();

  constructor(private readonly options: FakeAgentOptions) {
    latestAgentOptions = options;
    this.state = { messages: [] };
  }

  subscribe(subscriber: (event: Record<string, unknown>) => void | Promise<void>) {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async prompt(prompt: string) {
    for (const subscriber of this.subscribers) {
      await subscriber({ type: 'agent_start' });
    }

    await this.options.streamFn(
      this.options.initialState.model,
      { systemPrompt: this.options.initialState.systemPrompt, messages: [{ role: 'user', content: prompt }] },
      { sessionId: this.options.sessionId },
    );

    // A concurrent UI preference update must not affect the second model turn
    // of the already materialized Email Workspace Agent run.
    activePreference = cloneSelection(selectionB);

    await this.options.streamFn(
      this.options.initialState.model,
      { systemPrompt: this.options.initialState.systemPrompt, messages: [{ role: 'user', content: prompt }] },
      { sessionId: this.options.sessionId },
    );

    this.state.messages.push({
      role: 'assistant',
      content: [{
        type: 'text',
        text: JSON.stringify({
          body: 'Team-scoped draft',
          bodyHtml: '<p>Team-scoped draft</p>',
          usedContext: [],
        }),
      }],
      timestamp: Date.now(),
    });
  }

  abort() {}
}

function matchesModule(request: string, suffix: string): boolean {
  const normalized = request.replace(/\\/gu, '/').replace(/\.(?:c|m)?(?:js|ts)$/u, '');
  const normalizedSuffix = suffix.replace(/\.(?:c|m)?(?:js|ts)$/u, '');
  return normalized === `@/${normalizedSuffix}`
    || normalized.endsWith(`/${normalizedSuffix}`)
    || normalized === `./${normalizedSuffix.split('/').pop()}`;
}

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};

  if (
    request === '@earendil-works/pi-ai'
    || request === '@earendil-works/pi-ai/compat'
    || matchesModule(request, 'app/lib/agents/effective-runtime-config')
    || matchesModule(request, 'app/lib/pi/api-key-resolver')
  ) {
    forbiddenLoads.push(request);
    throw new Error(`Forbidden legacy/direct Email AI dependency loaded: ${request}`);
  }

  if (request === '@earendil-works/pi-agent-core') {
    return { Agent: FakeAgent };
  }

  if (request === 'pdf-parse') {
    return {
      PDFParse: class {
        async getInfo() { return { total: 0 }; }
        async getText() { return { text: '' }; }
        async destroy() {}
      },
    };
  }

  if (matchesModule(request, 'app/lib/agent-runtime-policy/provider-runtime')) {
    return { resolveExecutableAgentRuntime };
  }

  if (matchesModule(request, 'app/lib/pi/session-workspace-context')) {
    return { resolveAgentSessionWorkspaceForUser };
  }

  if (matchesModule(request, 'app/lib/email/service')) {
    return {
      readEmailMessage: async () => {
        throw new Error('The compose-agent runtime test did not request an original email.');
      },
    };
  }

  if (matchesModule(request, 'app/lib/filesystem/workspace-files')) {
    const loaded = originalLoad(request, parent, isMain) as Record<string, unknown> & {
      listDirectory: (requestedPath?: string, options?: FileOperationOptions) => Promise<unknown>;
      getFileStats: (requestedPath: string, options?: FileOperationOptions) => Promise<unknown>;
      readFile: (requestedPath: string, options?: FileOperationOptions) => Promise<Buffer>;
      resolveExistingWorkspacePath: (requestedPath: string, options?: FileOperationOptions) => Promise<string>;
    };
    return {
      ...loaded,
      listDirectory: async (requestedPath = '.', options?: FileOperationOptions) => {
        workspaceFileCalls.push({ operation: 'listDirectory', requestedPath, options });
        return loaded.listDirectory(requestedPath, options);
      },
      getFileStats: async (requestedPath: string, options?: FileOperationOptions) => {
        workspaceFileCalls.push({ operation: 'getFileStats', requestedPath, options });
        return loaded.getFileStats(requestedPath, options);
      },
      readFile: async (requestedPath: string, options?: FileOperationOptions) => {
        workspaceFileCalls.push({ operation: 'readFile', requestedPath, options });
        return loaded.readFile(requestedPath, options);
      },
      resolveExistingWorkspacePath: async (requestedPath: string, options?: FileOperationOptions) => {
        // Deterministically model a parent-symlink swap after the path guard
        // has approved a workspace-relative path but before open(). The
        // production descriptor-path verification must still reject it.
        const resolvedPath = requestedPath === 'simulated-race.txt'
          ? await fs.realpath(path.join(personalRoot, 'personal-only.txt'))
          : await loaded.resolveExistingWorkspacePath(requestedPath, options);
        workspaceFileCalls.push({
          operation: 'resolveExistingWorkspacePath',
          requestedPath,
          options,
          resolvedPath,
        });
        return resolvedPath;
      },
    };
  }

  if (matchesModule(request, 'app/lib/filesystem/file-reference-cache')) {
    const loaded = originalLoad(request, parent, isMain) as Record<string, unknown> & {
      getCachedFileReferenceEntries: (
        forceRefresh?: boolean,
        options?: FileOperationOptions,
      ) => Promise<unknown>;
    };
    return {
      ...loaded,
      getCachedFileReferenceEntries: async (
        forceRefresh = false,
        options?: FileOperationOptions,
      ) => {
        fileReferenceCalls.push({ forceRefresh, options });
        return loaded.getCachedFileReferenceEntries(forceRefresh, options);
      },
    };
  }

  return originalLoad(request, parent, isMain);
};

async function prepareWorkspaceRoots() {
  await fs.mkdir(path.join(teamWorkspace.rootPath, 'shared'), { recursive: true });
  await fs.mkdir(path.join(personalRoot, 'shared'), { recursive: true });
  await fs.writeFile(path.join(teamWorkspace.rootPath, 'shared', 'context.txt'), 'TEAM ROOT CONTENT\n', 'utf8');
  await fs.writeFile(path.join(teamWorkspace.rootPath, 'team-only.txt'), 'team-only\n', 'utf8');
  const oversizedTextPath = path.join(teamWorkspace.rootPath, 'oversized.txt');
  await fs.writeFile(oversizedTextPath, 'x', 'utf8');
  await fs.truncate(oversizedTextPath, 5 * 1024 * 1024 + 1);
  await fs.writeFile(path.join(personalRoot, 'shared', 'context.txt'), 'PERSONAL ROOT DECOY\n', 'utf8');
  await fs.writeFile(path.join(personalRoot, 'personal-only.txt'), 'personal-only\n', 'utf8');
}

async function testPinnedRuntimeAcrossAgentTurns() {
  runtimeResolutionCalls.length = 0;
  providerCalls.length = 0;
  workspaceResolutionCalls.length = 0;
  activePreference = cloneSelection(selectionA);
  workspaceAuthorized = true;
  latestAgentOptions = null;

  const { runEmailWorkspaceComposeAgent } = await import('../app/lib/email/compose-agent/runner');
  const emitted: Array<Record<string, unknown>> = [];
  const result = await runEmailWorkspaceComposeAgent(
    userId,
    {
      accountId: 'account-email-runtime',
      instruction: 'Draft a short team update.',
      mode: 'compose',
      workspaceId,
    },
    (event) => {
      emitted.push(event as unknown as Record<string, unknown>);
    },
  );

  assert.equal(result.body, 'Team-scoped draft');
  assert.equal(emitted.some((event) => event.type === 'final'), true);
  const agentOptions = requireLatestAgentOptions();
  assert.equal(agentOptions.initialState.model.id, selectionA.modelId);
  assert.equal(agentOptions.initialState.thinkingLevel, selectionA.thinkingLevel);
  assert.deepEqual(
    agentOptions.initialState.tools.map((tool) => tool.name),
    ['email_workspace_search', 'email_workspace_read'],
  );

  assert.equal(runtimeResolutionCalls.length, 2);
  assert.equal(runtimeResolutionCalls[0].requestedSelection, null);
  assert.deepEqual(runtimeResolutionCalls[1].requestedSelection, selectionA);
  assert.equal(runtimeResolutionCalls[1].organizationId, organizationId);
  assert.equal(runtimeResolutionCalls[1].userId, userId);
  assert.equal(runtimeResolutionCalls[1].workspaceId, workspaceId);
  assert.equal(runtimeResolutionCalls[1].workspaceType, 'team');
  assert.equal(runtimeResolutionCalls[1].agentId, 'canvas-agent');

  assert.equal(providerCalls.length, 2);
  for (const call of providerCalls) {
    assert.deepEqual(call.materializedSelection, selectionA);
    assert.deepEqual(call.effectiveSelection, selectionA);
    assert.equal(call.modelId, selectionA.modelId);
  }
  assert.deepEqual(activePreference, selectionB);

  // One initial workspace resolution plus one reauthorization for each of the
  // two provider turns.
  assert.equal(workspaceResolutionCalls.length, 3);
  assert.deepEqual(
    workspaceResolutionCalls.map((call) => call.workspaceId),
    [workspaceId, workspaceId, workspaceId],
  );
}

async function testThinkingAndAbortPropagation() {
  runtimeResolutionCalls.length = 0;
  providerCalls.length = 0;
  workspaceResolutionCalls.length = 0;
  activePreference = cloneSelection(selectionA);
  workspaceAuthorized = true;

  const { draftEmailComposeWithAiStream } = await import('../app/lib/email/ai-service');
  const abortController = new AbortController();
  const stream = await draftEmailComposeWithAiStream(
    { userId, workspaceId },
    { instruction: 'Write a concise update.' },
    { signal: abortController.signal },
  );

  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.length, 1);

  assert.equal(runtimeResolutionCalls.length, 2);
  assert.equal(runtimeResolutionCalls[0].requestedSelection, null);
  assert.deepEqual(runtimeResolutionCalls[1].requestedSelection, selectionA);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].options?.reasoning, selectionA.thinkingLevel);
  assert.equal(providerCalls[0].options?.signal, abortController.signal);
  assert.equal(workspaceResolutionCalls.length, 2);

  abortController.abort();
  assert.equal((providerCalls[0].options?.signal as AbortSignal).aborted, true);
}

async function testTeamScopedWorkspaceTools() {
  workspaceResolutionCalls.length = 0;
  workspaceFileCalls.length = 0;
  fileReferenceCalls.length = 0;
  workspaceAuthorized = true;

  const { createEmailWorkspaceTools } = await import('../app/lib/email/compose-agent/workspace-tools');
  const tools = createEmailWorkspaceTools({ userId, workspace: teamWorkspace }) as TestTool[];
  const searchTool = tools.find((tool) => tool.name === 'email_workspace_search');
  const readTool = tools.find((tool) => tool.name === 'email_workspace_read');
  assert.ok(searchTool);
  assert.ok(readTool);

  const teamSearch = await searchTool.execute('search-team', { query: 'team-only' });
  assert.match(teamSearch.content[0].text, /team-only\.txt/u);

  const personalSearch = await searchTool.execute('search-personal', { query: 'personal-only' });
  assert.doesNotMatch(personalSearch.content[0].text, /personal-only\.txt/u);

  const readResult = await readTool.execute(
    'read-shared',
    { path: 'shared/context.txt' },
    new AbortController().signal,
  );
  assert.match(readResult.content[0].text, /TEAM ROOT CONTENT/u);
  assert.doesNotMatch(readResult.content[0].text, /PERSONAL ROOT DECOY/u);

  await assert.rejects(
    () => readTool.execute('read-symlink-race', { path: 'simulated-race.txt' }),
    /changed outside the authorized workspace/u,
  );

  const readFileCallsBeforeOversized = workspaceFileCalls.filter((call) => call.operation === 'readFile').length;
  await assert.rejects(
    () => readTool.execute('read-oversized', { path: 'oversized.txt' }),
    /too large for email compose context/u,
  );
  assert.equal(
    workspaceFileCalls.filter((call) => call.operation === 'readFile').length,
    readFileCallsBeforeOversized,
    'oversized files must be rejected before readFile allocates their contents',
  );

  assert.ok(fileReferenceCalls.length > 0);
  assert.ok(workspaceFileCalls.length > 0);
  const teamRootRealPath = await fs.realpath(teamWorkspace.rootPath);
  for (const call of fileReferenceCalls) {
    assert.equal(call.options?.workspace, teamWorkspace, 'File-reference search lost the selected team workspace.');
  }
  for (const call of workspaceFileCalls) {
    assert.equal(call.options?.workspace, teamWorkspace, `${call.operation} lost the selected team workspace.`);
    if (call.resolvedPath) {
      const relative = path.relative(teamRootRealPath, call.resolvedPath);
      if (call.requestedPath === 'simulated-race.txt') {
        assert.equal(relative.startsWith('..') || path.isAbsolute(relative), true);
        continue;
      }
      assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
    }
  }

  // Revoke permission after a successful first tool call. The next tool call
  // must fail during reauthorization, before touching the filesystem/cache.
  workspaceResolutionCalls.length = 0;
  workspaceFileCalls.length = 0;
  fileReferenceCalls.length = 0;
  workspaceAuthorized = true;
  await searchTool.execute('search-before-revoke', { query: 'context' });
  const fileCallsBeforeRevoke = workspaceFileCalls.length;
  const referenceCallsBeforeRevoke = fileReferenceCalls.length;
  workspaceAuthorized = false;

  await assert.rejects(
    () => readTool.execute('read-after-revoke', { path: 'shared/context.txt' }),
    /Workspace permission denied/u,
  );
  assert.equal(workspaceResolutionCalls.length, 2);
  assert.equal(workspaceFileCalls.length, fileCallsBeforeRevoke);
  assert.equal(fileReferenceCalls.length, referenceCallsBeforeRevoke);
  workspaceAuthorized = true;
}

async function main() {
  await prepareWorkspaceRoots();
  await testPinnedRuntimeAcrossAgentTurns();
  await testThinkingAndAbortPropagation();
  await testTeamScopedWorkspaceTools();
  assert.deepEqual(forbiddenLoads, []);
  console.log('Email AI runtime scope tests passed.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(tempRoot, { recursive: true, force: true });
  });
