import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';

/** Actual service/factory/runtime plumbing; provider, model and authority
 * boundaries are fixture seams. Actual ACL/SDK isolation has its own PG gate. */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-runtime-planning-'));
  const previousData = process.env.DATA; process.env.DATA = root;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  const calls: Array<{ sessionId: string; planningMode?: boolean; metadataOnlyExternal?: boolean }> = [];
  let externalConstructions = 0;
  const context = (sessionId: string): AgentExecutionContext => ({ userId: 'planning-user', sessionId, agentId: 'planning-agent',
    workspaceId: 'planning-workspace', workspaceType: 'personal', workspaceName: 'Planning', organizationId: 'planning-org',
    projectId: null, customerId: null, workspaceRoot: root, workspaceRootRelativePath: 'fixture',
    canWrite: true, canDelete: true, canShare: false, legacy: false, skillReadRoots: [], skillPackageBindings: [] });
  const session = (sessionId: string) => ({ sessionId, userId: 'planning-user', agentId: 'planning-agent', organizationId: 'planning-org',
    workspaceId: 'planning-workspace', workspaceType: 'personal', sessionKind: 'chat' });
  const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://localhost.invalid',
    reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 8_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  class FixtureAgent {
    state: Record<string, unknown>;
    constructor(options: { initialState: Record<string, unknown> }) { this.state = { ...options.initialState, pendingToolCalls: new Set(), isStreaming: false }; }
    subscribe() { return () => {}; }
    abort() {}
  }
  const tool = (name: string): AgentTool => ({ name, label: name, description: name, parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: {} }) });
  loader._load = (name, parent, mainModule) => {
    if (name === 'server-only') return {};
    if (name === '@earendil-works/pi-agent-core') return { Agent: FixtureAgent };
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined,
      createInitialSystemMessage: (value: unknown) => value, normalizeContext: (value: unknown) => value,
      toToolDeclaration: (value: unknown) => value,
    };
    if (name === '@/app/lib/pi/session-runtime-access') return { findUnambiguousOwnedPiSessionForRuntime: async ({ sessionId }: { sessionId: string }) => session(sessionId) };
    if (name === '@/app/lib/pi/session-workspace-context') return {
      resolveAgentExecutionContextForSession: async ({ sessionId }: { sessionId: string }) => context(sessionId),
      ensurePiSessionWorkspaceSnapshot: async ({ sessionId }: { sessionId: string }) => context(sessionId),
      requestedWorkspaceIdFromChatContext: () => 'planning-workspace', workspaceToChatRequestWorkspace: () => ({ workspaceId: 'planning-workspace', workspaceType: 'personal' }),
    };
    if (name === '@/app/lib/pi/system-prompt-snapshot') return {
      ensurePiSessionSystemPromptSnapshot: async () => ({ systemPrompt: 'Fixture prompt' }),
      createPiSystemPromptSnapshot: async () => ({ systemPrompt: 'Fixture prompt' }),
    };
    if (name === '@/app/lib/agent-runtime-policy/provider-runtime') return {
      resolveAndPinSessionRuntime: async () => ({ selection: { selection: { providerId: 'fixture', thinkingLevel: 'off' } }, model,
        requiresRecreation: () => false, streamFn: async () => { throw new Error('The fixture must not call a model.'); } }),
      resolveCompactionSummaryRuntime: async () => null,
    };
    if (name === '@/app/lib/pi/compaction/runtime-policy') return { loadPiEffectiveCompactionPolicy: async () => ({ summaryModel: null }) };
    if (name === '@/app/lib/pi/session-store') return { loadPiSessionWithSummary: async () => null };
    if (name === '@/app/lib/pi/usage-events') return { loadLatestPiSessionInputUsage: async () => null };
    if (name === '@/app/lib/memory/prompt-projection') return { buildMemoryPromptProjection: async () => '' };
    if (name === '@/app/lib/pi/browser/session-state-service') return { refreshBrowserSessionSnapshot: async () => ({ running: false }) };
    if (name === '@/app/lib/server-settings') return { getServerPreferredTimeZone: async () => 'UTC' };
    if (name === '@/app/lib/pi/tool-registry') return { getPiTools: async (_user: string, _agent: string, sessionId: string,
      options: { planningMode?: boolean; metadataOnlyExternal?: boolean }) => {
      calls.push({ sessionId, planningMode: options.planningMode, metadataOnlyExternal: options.metadataOnlyExternal });
      if (!options.planningMode && !options.metadataOnlyExternal) externalConstructions++;
      return options.planningMode ? [tool('read')] : [tool('read'), tool('write')];
    } };
    return original(name, parent, mainModule);
  };
  const host = globalThis as typeof globalThis & { __canvasPiRuntimeStore?: unknown };
  const oldStore = host.__canvasPiRuntimeStore;
  host.__canvasPiRuntimeStore = { runtimes: new Map(), statusRevisions: new Map(), cleanupStarted: true };
  try {
    const live = await import('../app/lib/pi/live-runtime');
    const status = { phase: 'idle', canAbort: false, contextWindow: 128_000 };
    // Token measurement and prompt streaming are outside this plumbing test.
    // The real creation, registry option forwarding and reload methods remain.
    Object.assign(live.LivePiRuntime.prototype, { getStatus: () => status, refreshWorkspaceFileTreePrompt: async () => {},
      refreshMemoryPrompt: async () => {}, reloadCompactionPolicyForNextRequest: async () => {}, startPrompt: () => {} });
    const service = await import('../app/lib/pi/runtime-service');
    await service.prepareRuntimePrompt('first-planning', 'planning-user', { context: { planningMode: true }, message: { role: 'user', content: 'Plan only', timestamp: 1 } });
    assert.deepEqual(calls[0], { sessionId: 'first-planning', planningMode: true, metadataOnlyExternal: false },
      'The first actual runtime construction receives normalized planning mode before constructing tools.');
    assert.equal(externalConstructions, 0);
    const first = (await live.getExistingPiRuntime('first-planning', 'planning-user'))!;
    assert.deepEqual(first.agent.state.tools.map(entry => entry.name), ['read']);
    first.setPlanningMode(false); await first.reloadTools();
    assert.equal(calls.at(-1)?.planningMode, false, 'Tool reload uses the current runtime mode.');
    const beforePrewarm = externalConstructions;
    await service.prewarmSessionRuntime('prewarmed', 'planning-user');
    assert.deepEqual(calls.at(-1), { sessionId: 'prewarmed', planningMode: false, metadataOnlyExternal: true });
    assert.equal(externalConstructions, beforePrewarm, 'Prewarm asks only for cached external metadata.');
    await service.prepareRuntimePrompt('prewarmed', 'planning-user', { context: { planningMode: false }, message: { role: 'user', content: 'Now run', timestamp: 2 } });
    assert.equal(calls.at(-1)?.metadataOnlyExternal, undefined, 'An actual turn reloads ordinary tools after a cached prewarm.');
    assert.equal(externalConstructions, beforePrewarm + 1);
    await live.dispatchPiRuntimeUserMessage('dispatch-planning', 'planning-user', { role: 'user', content: 'Plan', timestamp: 3 }, { planningMode: true });
    assert.deepEqual(calls.at(-1), { sessionId: 'dispatch-planning', planningMode: true, metadataOnlyExternal: false });
    assert.equal(externalConstructions, beforePrewarm + 1, 'Direct user-message dispatch does not construct external tools in planning mode.');
    console.log('pi-runtime-initial-planning-test: PASS (actual initial factory + prompt service + dispatch + reload/prewarm plumbing; model/provider/authority boundaries are fixtures)');
  } finally {
    loader._load = original; host.__canvasPiRuntimeStore = oldStore;
    if (previousData === undefined) delete process.env.DATA; else process.env.DATA = previousData;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
