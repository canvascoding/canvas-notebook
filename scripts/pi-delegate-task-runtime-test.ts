import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DelegateTaskResult } from '../app/lib/pi/delegate-task-tool';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-pi-delegate-runtime-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.QMD_ENABLED = 'false';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
type RuntimeContext = Record<string, unknown>;
type RuntimeEvent = {
  type: string;
  status?: { phase: string; canAbort: boolean };
  error?: string;
};
type RuntimeSubscriber = (event: RuntimeEvent) => void;

function matchesModule(request: string, suffix: string): boolean {
  const normalized = request.replace(/\\/gu, '/').replace(/\.(?:c|m)?(?:js|ts)$/u, '');
  return normalized === `@/${suffix}`
    || normalized.endsWith(`/${suffix}`)
    || normalized === `./${suffix.split('/').pop()}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const organizationId = 'org-delegation-runtime';
const userId = 'delegation-runtime-user';
const sourceAgentId = 'canvas-agent';
const targetAgentId = 'research-agent';
const sourceSessionId = 'sess-delegation-source';
const sourceWorkspaceId = 'workspace-delegation-team';
const otherWorkspaceId = 'workspace-delegation-other';
const installationId = `aip_${'d'.repeat(24)}`;

function workspace(workspaceId: string, displayName: string) {
  return {
    organizationId,
    customerId: null,
    projectId: workspaceId === sourceWorkspaceId ? 'project-delegation' : 'project-other',
    workspaceId,
    workspaceType: 'team' as const,
    displayName,
    rootPath: path.join(dataDir, 'workspaces', workspaceId),
    rootRelativePath: `workspaces/${workspaceId}`,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canRunAgent: true,
    },
    legacy: false,
  };
}

const sourceWorkspace = workspace(sourceWorkspaceId, 'Delegation Team');
const otherWorkspace = workspace(otherWorkspaceId, 'Other Team');
const workspaces = new Map([
  [sourceWorkspaceId, sourceWorkspace],
  [otherWorkspaceId, otherWorkspace],
]);

function executionContext(input: {
  sessionId: string;
  agentId: string;
  workspace: ReturnType<typeof workspace>;
}) {
  return {
    userId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    workspaceId: input.workspace.workspaceId,
    workspaceType: input.workspace.workspaceType,
    workspaceName: input.workspace.displayName,
    organizationId: input.workspace.organizationId,
    customerId: input.workspace.customerId,
    projectId: input.workspace.projectId,
    workspaceRoot: input.workspace.rootPath,
    workspaceRootRelativePath: input.workspace.rootRelativePath,
    canWrite: input.workspace.permissions.canWrite,
    canDelete: input.workspace.permissions.canDelete,
    canShare: input.workspace.permissions.canCreatePublicLinks,
    legacy: false,
  };
}

const sessionContexts = new Map<string, ReturnType<typeof executionContext>>();
function sessionContextKey(sessionId: string, agentId: string) {
  return `${userId}\0${sessionId}\0${agentId}`;
}
sessionContexts.set(
  sessionContextKey(sourceSessionId, sourceAgentId),
  executionContext({ sessionId: sourceSessionId, agentId: sourceAgentId, workspace: sourceWorkspace }),
);

const runtimeSnapshot = {
  selection: {
    providerInstallationId: installationId,
    providerId: 'test-provider',
    modelId: 'delegation-model',
    thinkingLevel: 'high' as const,
  },
  catalogRevision: 0,
  policyRevision: 0,
  selectionSource: 'user_preference' as const,
};
const testModel = {
  id: runtimeSnapshot.selection.modelId,
  name: 'Delegation Model',
  provider: runtimeSnapshot.selection.providerId,
  api: 'openai-completions',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
};
const streamCalls: Array<{
  sessionId?: string;
  thinkingLevel?: string;
  signal?: AbortSignal;
  toolNames: string[];
  systemPrompt: string;
}> = [];
const testStreamFn = async (
  _model: unknown,
  context: { systemPrompt?: string; tools?: Array<{ name: string }> },
  options?: { sessionId?: string; thinkingLevel?: string; signal?: AbortSignal },
) => {
  streamCalls.push({
    sessionId: options?.sessionId,
    thinkingLevel: options?.thinkingLevel,
    signal: options?.signal,
    toolNames: context.tools?.map((tool) => tool.name) ?? [],
    systemPrompt: context.systemPrompt || '',
  });
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Ephemeral delegation finished.' }],
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
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: 'stop', message: assistant };
    },
    result: async () => assistant,
  };
};
const executableRuntime = {
  resolution: {
    valid: true,
    catalogRevision: runtimeSnapshot.catalogRevision,
    policyRevision: runtimeSnapshot.policyRevision,
  },
  selection: {
    ...runtimeSnapshot,
    catalogRevision: 17,
    policyRevision: 23,
    credentialScope: 'organization',
  },
  providerInstallation: {},
  catalogModel: {},
  model: testModel,
  getApiKey: async () => undefined,
  streamFn: testStreamFn,
  requiresRecreation: () => false,
};

const preparedContexts: Array<{
  context: RuntimeContext;
  update?: { selection?: RuntimeContext; expectedCatalogRevision?: number; expectedPolicyRevision?: number };
}> = [];
const materializationContexts: RuntimeContext[] = [];
const toolContexts: Array<{
  userId?: string;
  agentId?: string | null;
  sessionId?: string | null;
  executionContext?: RuntimeContext;
}> = [];
let legacyResolverLoads = 0;
let managedRuntimeLookups = 0;

class FakeManagedRuntime {
  readonly subscribers = new Set<RuntimeSubscriber>();
  readonly started = deferred();
  readonly agent: { state: { messages: Array<Record<string, unknown>> } };
  phase = 'idle';
  canAbort = false;
  abortCalls = 0;
  reloadCalls = 0;
  onReload: (() => void) | null = null;
  private activePrompt: Record<string, unknown> | null = null;

  constructor(
    readonly agentId: string,
    initialMessages: Array<Record<string, unknown>> = [],
    private readonly prependRuntimeContinuation = false,
  ) {
    this.agent = { state: { messages: [...initialMessages] } };
  }

  getStatus() {
    return { phase: this.phase, canAbort: this.canAbort };
  }

  subscribe(subscriber: RuntimeSubscriber) {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async reloadTools() {
    this.reloadCalls += 1;
    this.onReload?.();
  }

  startPrompt(message: Record<string, unknown>) {
    if (this.canAbort || this.phase !== 'idle') {
      throw new Error('fake runtime already busy');
    }
    this.activePrompt = message;
    this.phase = 'streaming';
    this.canAbort = true;
    this.emit({ type: 'runtime_status', status: this.getStatus() });
    this.started.resolve();
  }

  finish(reply: string) {
    if (this.prependRuntimeContinuation) {
      this.agent.state.messages.push({
        role: 'runtime_continuation',
        reason: 'tool_tail',
        content: 'Continue after the stored tool tail.',
        timestamp: Date.now(),
      });
    }
    if (this.activePrompt) this.agent.state.messages.push(this.activePrompt);
    this.agent.state.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: reply }],
      timestamp: Date.now(),
    });
    this.activePrompt = null;
    this.phase = 'idle';
    this.canAbort = false;
    this.emit({ type: 'runtime_status', status: this.getStatus() });
  }

  async abort() {
    this.abortCalls += 1;
    this.activePrompt = null;
    this.phase = 'idle';
    this.canAbort = false;
    this.emit({ type: 'error', error: 'managed delegation aborted' });
    this.emit({ type: 'runtime_status', status: this.getStatus() });
  }

  private emit(event: RuntimeEvent) {
    for (const subscriber of [...this.subscribers]) subscriber(event);
  }
}

const managedRuntimes = new Map<string, FakeManagedRuntime>();

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (
    request === '@earendil-works/pi-ai'
    || request === '@earendil-works/pi-ai/compat'
    || request === '@earendil-works/pi-ai/oauth'
  ) {
    return {
      registerBuiltInApiProviders: () => undefined,
      getProviders: () => [],
      getModels: () => [],
    };
  }
  if (
    matchesModule(request, 'app/lib/agents/effective-runtime-config')
    || matchesModule(request, 'app/lib/pi/api-key-resolver')
  ) {
    legacyResolverLoads += 1;
    throw new Error('Delegation runtime must not load a legacy model or credential resolver.');
  }
  if (
    matchesModule(request, 'app/lib/agent-runtime-policy/session-runtime-service')
  ) {
    return {
      prepareSessionRuntimeSnapshot: async (input: {
        context: RuntimeContext;
        update?: { selection?: RuntimeContext; expectedCatalogRevision?: number; expectedPolicyRevision?: number };
      }) => {
        preparedContexts.push(input);
        return { snapshot: runtimeSnapshot, resolution: { valid: true } };
      },
    };
  }
  if (
    matchesModule(request, 'app/lib/agent-runtime-policy/provider-runtime')
  ) {
    return {
      resolveAndPinSessionRuntime: async (context: RuntimeContext) => {
        materializationContexts.push(context);
        return executableRuntime;
      },
    };
  }
  if (matchesModule(request, 'app/lib/agents/system-prompt')) {
    return {
      loadManagedAgentSystemPrompt: async () => ({
        systemPrompt: 'Delegation runtime test prompt',
        diagnostics: {
          loadedFiles: [],
          includedFiles: [],
          emptyFiles: [],
          usedFallback: false,
        },
      }),
    };
  }
  if (matchesModule(request, 'app/lib/pi/tool-registry')) {
    return {
      getPiTools: async (
        requestedUserId?: string,
        agentId?: string | null,
        sessionId?: string | null,
        options?: { executionContext?: RuntimeContext },
      ) => {
        toolContexts.push({
          userId: requestedUserId,
          agentId,
          sessionId,
          executionContext: options?.executionContext,
        });
        return [
          { name: 'read', execute: async () => ({ content: [] }) },
          { name: 'delegate_task', execute: async () => ({ content: [] }) },
        ];
      },
    };
  }
  if (
    matchesModule(request, 'app/lib/pi/session-workspace-context')
  ) {
    return {
      resolveAgentExecutionContextForSession: async (input: {
        sessionId: string;
        userId: string;
        agentId?: string | null;
      }) => {
        const context = sessionContexts.get(sessionContextKey(input.sessionId, input.agentId || sourceAgentId));
        if (!context || input.userId !== userId) {
          throw new Error('Test session workspace context not found.');
        }
        return context;
      },
      resolveAgentSessionWorkspaceForUser: async (input: { userId: string; workspaceId?: string | null }) => {
        const resolved = input.workspaceId ? workspaces.get(input.workspaceId) : undefined;
        if (!resolved || input.userId !== userId) throw new Error('Test workspace not found.');
        return resolved;
      },
      workspaceToPiSessionFields: (resolved: ReturnType<typeof workspace>) => ({
        organizationId: resolved.organizationId,
        customerId: resolved.customerId,
        projectId: resolved.projectId,
        workspaceId: resolved.workspaceId,
        workspaceType: resolved.workspaceType,
        workspaceName: resolved.displayName,
        workspaceRootRelativePath: resolved.rootRelativePath,
      }),
    };
  }
  if (matchesModule(request, 'app/lib/pi/live-runtime')) {
    return {
      getExistingPiRuntime: async (sessionId: string) => managedRuntimes.get(sessionId) ?? null,
      invalidatePiRuntime: async () => true,
      getOrCreatePiRuntimeWithState: async (sessionId: string) => {
        managedRuntimeLookups += 1;
        const runtime = managedRuntimes.get(sessionId);
        if (!runtime) throw new Error(`Test managed runtime missing for ${sessionId}.`);
        return { runtime, created: false };
      },
    };
  }
  if (matchesModule(request, 'app/lib/pi/message-normalization')) {
    return { normalizePiMessagesForLlm: async (messages: unknown[]) => messages };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const { and, eq } = await import('drizzle-orm');
    const { db } = await import('../app/lib/db');
    const { piMessages, piSessions, user } = await import('../app/lib/db/schema');
    const { startDelegatedRun } = await import('../app/lib/pi/delegate-task-tool');

    const now = new Date();
    await db.insert(user).values({
      id: userId,
      name: 'Delegation Runtime User',
      email: 'delegation-runtime@example.test',
      emailVerified: true,
      image: null,
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });

    const insertSession = async (input: {
      sessionId: string;
      agentId: string;
      workspace: ReturnType<typeof workspace>;
      title?: string;
    }) => {
      await db.insert(piSessions).values({
        sessionId: input.sessionId,
        userId,
        agentId: input.agentId,
        provider: 'stored-provider',
        model: 'stored-model',
        thinkingLevel: 'off',
        title: input.title ?? input.sessionId,
        channelId: 'app',
        channelSessionKey: null,
        organizationId,
        customerId: null,
        projectId: input.workspace.projectId,
        workspaceId: input.workspace.workspaceId,
        workspaceType: input.workspace.workspaceType,
        workspaceName: input.workspace.displayName,
        workspaceRootRelativePath: input.workspace.rootRelativePath,
        createdAt: now,
        updatedAt: now,
      });
    };

    await insertSession({
      sessionId: sourceSessionId,
      agentId: sourceAgentId,
      workspace: sourceWorkspace,
      title: 'Delegating source',
    });

    const ephemeralResult = await startDelegatedRun({
      delegationId: 'delegation-direct-ephemeral',
      userId,
      sourceAgentId,
      sourceSessionId,
      goal: 'Inspect the current team workspace',
      toolsets: ['file'],
      waitForResult: true,
      timeoutSeconds: 2,
    });
    assert.equal(ephemeralResult.status, 'ok');
    assert.equal(ephemeralResult.reply, 'Ephemeral delegation finished.');
    assert.notEqual(ephemeralResult.session_id, sourceSessionId);

    const childSession = await db.query.piSessions.findFirst({
      where: and(
        eq(piSessions.sessionId, ephemeralResult.session_id),
        eq(piSessions.userId, userId),
        eq(piSessions.agentId, sourceAgentId),
      ),
    });
    assert.ok(childSession);
    assert.equal(childSession.workspaceId, sourceWorkspaceId);
    assert.equal(childSession.workspaceType, 'team');
    assert.equal(childSession.organizationId, organizationId);
    assert.equal(childSession.runtimeProviderInstallationId, installationId);
    assert.equal(childSession.provider, runtimeSnapshot.selection.providerId);
    assert.equal(childSession.model, runtimeSnapshot.selection.modelId);
    assert.equal(childSession.thinkingLevel, runtimeSnapshot.selection.thinkingLevel);
    assert.equal(childSession.runtimeCatalogRevision, runtimeSnapshot.catalogRevision);
    assert.equal(childSession.runtimePolicyRevision, runtimeSnapshot.policyRevision);
    assert.equal(childSession.runtimeSelectionSource, runtimeSnapshot.selectionSource);
    assert.equal(childSession.sessionKind, 'delegation_worker');
    assert.equal(childSession.parentSessionId, sourceSessionId);
    assert.equal(childSession.delegationId, 'delegation-direct-ephemeral');
    assert.equal(childSession.delegationDepth, 1);

    await assert.rejects(
      () => startDelegatedRun({
        delegationId: 'delegation-recursive-attempt',
        userId,
        sourceAgentId,
        sourceSessionId: childSession.sessionId,
        goal: 'This must never run.',
        toolsets: ['file'],
        waitForResult: false,
        timeoutSeconds: 0,
      }),
      /Sub-agents cannot start another sub-agent/,
    );

    assert.equal(preparedContexts.length, 1);
    assert.equal(preparedContexts[0]?.context.organizationId, organizationId);
    assert.equal(preparedContexts[0]?.context.workspaceId, sourceWorkspaceId);
    assert.equal(preparedContexts[0]?.context.workspaceType, 'team');
    assert.equal(preparedContexts[0]?.context.agentId, sourceAgentId);
    assert.equal(preparedContexts[0]?.context.sessionId, null);
    assert.deepEqual(preparedContexts[0]?.update?.selection, runtimeSnapshot.selection);
    assert.notEqual(executableRuntime.selection.catalogRevision, executableRuntime.resolution.catalogRevision);
    assert.notEqual(executableRuntime.selection.policyRevision, executableRuntime.resolution.policyRevision);
    assert.equal(
      preparedContexts[0]?.update?.expectedCatalogRevision,
      executableRuntime.resolution.catalogRevision,
      'the child selection must use the current resolved catalog revision, not the older pinned selection revision',
    );
    assert.equal(
      preparedContexts[0]?.update?.expectedPolicyRevision,
      executableRuntime.resolution.policyRevision,
      'the child selection must use the current resolved policy revision, not the older pinned selection revision',
    );

    const childMaterialization = materializationContexts.find((context) => (
      context.sessionId === ephemeralResult.session_id
    ));
    assert.ok(childMaterialization, 'the child session ID must be used when materializing its executable runtime');
    assert.equal(childMaterialization.workspaceId, sourceWorkspaceId);
    assert.equal(childMaterialization.agentId, sourceAgentId);
    assert.ok(materializationContexts.some((context) => context.sessionId === sourceSessionId));

    assert.equal(toolContexts.length, 1);
    assert.equal(toolContexts[0]?.sessionId, ephemeralResult.session_id);
    assert.equal(toolContexts[0]?.executionContext?.sessionId, ephemeralResult.session_id);
    assert.equal(toolContexts[0]?.executionContext?.workspaceId, sourceWorkspaceId);
    assert.equal(toolContexts[0]?.executionContext?.organizationId, organizationId);
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0]?.sessionId, ephemeralResult.session_id);
    assert.equal(streamCalls[0]?.thinkingLevel, 'high');
    assert.equal(streamCalls[0]?.signal?.aborted, false);
    assert.deepEqual(streamCalls[0]?.toolNames, ['read']);
    assert.match(streamCalls[0]?.systemPrompt || '', /## Current Workspace File Tree/);
    assert.doesNotMatch(childSession.systemPromptSnapshot || '', /## Current Workspace File Tree/);
    assert.equal(legacyResolverLoads, 0);

    const childMessages = await db
      .select()
      .from(piMessages)
      .where(eq(piMessages.piSessionDbId, childSession.id));
    assert.equal(childMessages.length, 2, 'the final save must append without duplicating or replacing the child prompt');

    const otherWorkspaceSessionId = 'sess-target-other-workspace';
    await insertSession({
      sessionId: otherWorkspaceSessionId,
      agentId: targetAgentId,
      workspace: otherWorkspace,
    });
    sessionContexts.set(
      sessionContextKey(otherWorkspaceSessionId, targetAgentId),
      executionContext({ sessionId: otherWorkspaceSessionId, agentId: targetAgentId, workspace: otherWorkspace }),
    );
    const lookupsBeforeOtherWorkspace = managedRuntimeLookups;
    await assert.rejects(
      startDelegatedRun({
        userId,
        sourceAgentId,
        sourceSessionId,
        targetAgentId,
        sessionId: otherWorkspaceSessionId,
        goal: 'Must not cross workspaces',
        toolsets: [],
        waitForResult: false,
        timeoutSeconds: 0,
      }),
      /different workspace/,
    );
    assert.equal(managedRuntimeLookups, lookupsBeforeOtherWorkspace);

    const ambiguousSessionId = 'sess-target-agent-collision';
    await insertSession({
      sessionId: ambiguousSessionId,
      agentId: targetAgentId,
      workspace: sourceWorkspace,
    });
    // Simulate a pre-migration database so the runtime guard remains covered.
    const { openDb } = await import('../app/lib/db');
    const duplicateSeedConnection = await openDb();
    try {
      await duplicateSeedConnection.run('DROP INDEX IF EXISTS idx_pi_sessions_user_session');
    } finally {
      await duplicateSeedConnection.close();
    }
    await insertSession({
      sessionId: ambiguousSessionId,
      agentId: 'other-agent',
      workspace: sourceWorkspace,
    });
    sessionContexts.set(
      sessionContextKey(ambiguousSessionId, targetAgentId),
      executionContext({ sessionId: ambiguousSessionId, agentId: targetAgentId, workspace: sourceWorkspace }),
    );
    await assert.rejects(
      startDelegatedRun({
        userId,
        sourceAgentId,
        sourceSessionId,
        targetAgentId,
        sessionId: ambiguousSessionId,
        goal: 'Must reject an ambiguous target',
        toolsets: [],
        waitForResult: false,
        timeoutSeconds: 0,
      }),
      /ambiguous across multiple agents/,
    );

    const busySessionId = 'sess-target-managed-busy';
    await insertSession({ sessionId: busySessionId, agentId: targetAgentId, workspace: sourceWorkspace });
    sessionContexts.set(
      sessionContextKey(busySessionId, targetAgentId),
      executionContext({ sessionId: busySessionId, agentId: targetAgentId, workspace: sourceWorkspace }),
    );
    const busyRuntime = new FakeManagedRuntime(
      targetAgentId,
      [{
        role: 'assistant',
        content: [{ type: 'text', text: 'STALE REPLY' }],
        timestamp: Date.now() - 1_000,
      }],
      true,
    );
    managedRuntimes.set(busySessionId, busyRuntime);
    const firstManagedRun = startDelegatedRun({
      userId,
      sourceAgentId,
      sourceSessionId,
      targetAgentId,
      sessionId: busySessionId,
      goal: 'Produce a fresh managed reply',
      toolsets: [],
      waitForResult: true,
      timeoutSeconds: 2,
    });
    await busyRuntime.started.promise;
    await assert.rejects(
      startDelegatedRun({
        userId,
        sourceAgentId,
        sourceSessionId,
        targetAgentId,
        sessionId: busySessionId,
        goal: 'Must fail while the target is busy',
        toolsets: [],
        waitForResult: false,
        timeoutSeconds: 0,
      }),
      /already running/,
    );
    busyRuntime.finish('FRESH REPLY');
    const firstManagedResult = await firstManagedRun;
    const delegatedPromptIndex = busyRuntime.agent.state.messages.findIndex((message) => message.role === 'user');
    assert.ok(delegatedPromptIndex > 0);
    assert.equal(
      busyRuntime.agent.state.messages[delegatedPromptIndex - 1]?.role,
      'runtime_continuation',
      'the fixture must cover a runtime continuation inserted directly before the delegated prompt',
    );
    assert.equal(firstManagedResult.status, 'ok');
    assert.equal(firstManagedResult.reply, 'FRESH REPLY');
    assert.notEqual(firstManagedResult.reply, 'STALE REPLY');

    const permissionFlipSessionId = 'sess-target-managed-permission-flip';
    await insertSession({
      sessionId: permissionFlipSessionId,
      agentId: targetAgentId,
      workspace: sourceWorkspace,
    });
    const permissionFlipContextKey = sessionContextKey(permissionFlipSessionId, targetAgentId);
    const initialPermissionFlipContext = executionContext({
      sessionId: permissionFlipSessionId,
      agentId: targetAgentId,
      workspace: sourceWorkspace,
    });
    sessionContexts.set(permissionFlipContextKey, initialPermissionFlipContext);
    const permissionFlipRuntime = new FakeManagedRuntime(targetAgentId);
    permissionFlipRuntime.onReload = () => {
      sessionContexts.set(permissionFlipContextKey, {
        ...initialPermissionFlipContext,
        canWrite: false,
      });
    };
    managedRuntimes.set(permissionFlipSessionId, permissionFlipRuntime);
    await assert.rejects(
      startDelegatedRun({
        userId,
        sourceAgentId,
        sourceSessionId,
        targetAgentId,
        sessionId: permissionFlipSessionId,
        goal: 'Must stop when target permissions change after tool reload',
        toolsets: [],
        waitForResult: false,
        timeoutSeconds: 0,
      }),
      /permissions changed after its tools were loaded/,
    );
    assert.equal(permissionFlipRuntime.phase, 'idle');
    assert.equal(permissionFlipRuntime.canAbort, false);

    const abortSessionId = 'sess-target-managed-abort';
    await insertSession({ sessionId: abortSessionId, agentId: targetAgentId, workspace: sourceWorkspace });
    sessionContexts.set(
      sessionContextKey(abortSessionId, targetAgentId),
      executionContext({ sessionId: abortSessionId, agentId: targetAgentId, workspace: sourceWorkspace }),
    );
    const abortRuntime = new FakeManagedRuntime(targetAgentId);
    managedRuntimes.set(abortSessionId, abortRuntime);
    const abortController = new AbortController();
    const abortedRun = startDelegatedRun({
      userId,
      sourceAgentId,
      sourceSessionId,
      abortSignal: abortController.signal,
      targetAgentId,
      sessionId: abortSessionId,
      goal: 'Abort this managed delegation',
      toolsets: [],
      waitForResult: true,
      timeoutSeconds: 2,
    });
    await abortRuntime.started.promise;
    abortController.abort(new Error('parent delegation aborted'));
    const abortedResult = await abortedRun;
    assert.equal(abortRuntime.abortCalls, 1);
    assert.equal(abortedResult.status, 'error');
    assert.match(abortedResult.error ?? '', /managed delegation aborted/);

    const preAbortedController = new AbortController();
    preAbortedController.abort(new Error('pre-aborted delegation'));
    await assert.rejects(
      startDelegatedRun({
        userId,
        sourceAgentId,
        sourceSessionId,
        abortSignal: preAbortedController.signal,
        goal: 'Must not create a child session',
        toolsets: ['file'],
        waitForResult: true,
        timeoutSeconds: 2,
      }),
      /pre-aborted delegation/,
    );
    assert.equal(legacyResolverLoads, 0);

    let resolveEphemeralCompletion!: (result: DelegateTaskResult) => void;
    const ephemeralCompletion = new Promise<DelegateTaskResult>((resolve) => {
      resolveEphemeralCompletion = resolve;
    });
    const backgroundEphemeral = await startDelegatedRun({
      delegationId: 'delegation-background-ephemeral',
      userId,
      sourceAgentId,
      sourceSessionId,
      workerSessionId: 'sess-delegation-background-ephemeral',
      goal: 'Complete in the background',
      toolsets: ['file'],
      waitForResult: false,
      timeoutSeconds: 0,
      onCompletion: resolveEphemeralCompletion,
    });
    assert.equal(backgroundEphemeral.status, 'accepted');
    assert.equal(backgroundEphemeral.delegation_id, 'delegation-background-ephemeral');
    const backgroundEphemeralResult = await ephemeralCompletion;
    assert.equal(backgroundEphemeralResult.status, 'ok');
    assert.equal(backgroundEphemeralResult.reply, 'Ephemeral delegation finished.');

    const backgroundManagedSessionId = 'sess-delegation-background-managed';
    await insertSession({
      sessionId: backgroundManagedSessionId,
      agentId: targetAgentId,
      workspace: sourceWorkspace,
    });
    sessionContexts.set(
      sessionContextKey(backgroundManagedSessionId, targetAgentId),
      executionContext({
        sessionId: backgroundManagedSessionId,
        agentId: targetAgentId,
        workspace: sourceWorkspace,
      }),
    );
    const backgroundManagedRuntime = new FakeManagedRuntime(targetAgentId);
    managedRuntimes.set(backgroundManagedSessionId, backgroundManagedRuntime);
    let resolveManagedCompletion!: (result: DelegateTaskResult) => void;
    const managedCompletion = new Promise<DelegateTaskResult>((resolve) => {
      resolveManagedCompletion = resolve;
    });
    const backgroundManaged = await startDelegatedRun({
      delegationId: 'delegation-background-managed',
      userId,
      sourceAgentId,
      sourceSessionId,
      targetAgentId,
      sessionId: backgroundManagedSessionId,
      goal: 'Complete a managed run in the background',
      toolsets: [],
      waitForResult: false,
      timeoutSeconds: 0,
      onCompletion: resolveManagedCompletion,
    });
    assert.equal(backgroundManaged.status, 'accepted');
    await backgroundManagedRuntime.started.promise;
    backgroundManagedRuntime.finish('Managed background delegation finished.');
    const backgroundManagedResult = await managedCompletion;
    assert.equal(backgroundManagedResult.status, 'ok');
    assert.equal(backgroundManagedResult.reply, 'Managed background delegation finished.');

    console.log('pi-delegate-task-runtime-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
