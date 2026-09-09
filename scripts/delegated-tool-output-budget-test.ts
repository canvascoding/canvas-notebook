import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Message, Model } from '@earendil-works/pi-ai';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-delegated-output-'));
  process.env.DATA = root; process.env.CANVAS_DATA_ROOT = root;
  const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = modules._load;
  let saved: AgentMessage[] = [];
  let savedModel: unknown;
  let sent: Message[] = [];
  let sentOutputCap: number | undefined;
  let effectiveInstructions = '';
  modules._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    // CommonJS-only dependency consumers need a shim; the worker's dynamic
    // import executes the real ESM runAgentLoop implementation below.
    if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
    if ((request.startsWith('.') || request.startsWith('@/')) && request.endsWith('/auth')) return { auth: {} };
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    if (request === '@/app/lib/pi/session-store') return { savePiSession: async (_session: string, _user: string, _provider: string, _model: string, messages: AgentMessage[], _summary: unknown, options: { toolOutputModel?: unknown }) => {
      saved = structuredClone(messages); savedModel = options.toolOutputModel;
    } };
    if (request === '@/app/lib/agents/workspace-file-tree-context') return {
      buildWorkspaceFileTreePrompt: async () => ({ promptBlock: 'workspace updated' }),
      replaceWorkspaceFileTreePromptBlock: () => 'updated system instructions',
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { runEphemeralWorker } = await import('../app/lib/pi/delegate-task-tool');
    const { prepareToolOutput } = await import('../app/lib/pi/tool-output-preparation');
    const { getPiRequestOutputTokenCap } = await import('../app/lib/pi/context-budget');
    const model: Model<'openai-completions'> = { id: 'delegate-test', provider: 'future-provider', name: 'Delegate', api: 'openai-completions',
      baseUrl: 'https://example.invalid', contextWindow: 16_000, maxTokens: 4_096, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const identity = { organizationId: null, userId: 'worker-user', sessionId: 'worker-session', workspaceId: 'worker-workspace',
      agentId: null, workspaceType: 'personal' as const, workspaceName: null, customerId: null, projectId: null, workspaceRoot: root,
      workspaceRootRelativePath: null, canWrite: false, canDelete: false, canShare: false, legacy: false };
    const promptMessage = { role: 'user' as const, content: 'Collect six results.', timestamp: 1 };
    const assistant: Extract<AgentMessage, { role: 'assistant' }> = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      timestamp: 2, stopReason: 'toolUse', content: Array.from({ length: 6 }, (_, index) => ({ type: 'toolCall', name: 'fixture', id: `call-${index}`, arguments: {} })),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const fixtureTool = { name: 'fixture', label: 'Fixture', description: 'Fixture tool', parameters: Type.Object({}),
      execute: async (toolCallId: string) => prepareToolOutput({ identity, toolCallId, toolName: 'fixture',
        result: { content: [{ type: 'text', text: 'medium '.repeat(1_000) }], details: {} } }),
    };
    const params: Parameters<typeof runEphemeralWorker>[0] = {
      request: { userId: identity.userId, sourceAgentId: 'source-agent', sourceSessionId: 'source-session', goal: promptMessage.content,
        workerRole: 'researcher', toolsets: ['web'], waitForResult: true, timeoutSeconds: 30 }, sessionId: identity.sessionId,
      promptMessage, executionContext: identity, baseSystemPrompt: 'base instructions', systemPrompt: 'old instructions', tools: [fixtureTool], signal: new AbortController().signal,
      runtime: { model, selection: { selection: { providerId: model.provider, thinkingLevel: 'off' } },
        streamFn: async (_model: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2]) => {
          sentOutputCap = options?.maxTokens; sent = context.messages; effectiveInstructions = context.systemPrompt || '';
          const reply = context.messages.some(message => message.role === 'toolResult')
            ? { ...assistant, content: [{ type: 'text' as const, text: 'Collected six results.' }], stopReason: 'stop' as const, timestamp: 20 }
            : assistant;
          return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: reply.stopReason, message: reply }; }, result: async () => reply } as unknown as Awaited<ReturnType<StreamFn>>;
        },
      } as unknown as Parameters<typeof runEphemeralWorker>[0]['runtime'],
    };
    const result = await runEphemeralWorker(params);
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(effectiveInstructions, 'updated system instructions', 'canonical guard uses the refreshed prompt');
    assert.equal(sentOutputCap, getPiRequestOutputTokenCap(model), 'reserved and sent output caps match');
    assert.deepEqual(savedModel, model, 'persistence receives the effective model for stable views');
    const savedResults = saved.filter(message => message.role === 'toolResult');
    assert.equal(savedResults.length, 6);
    assert.ok(savedResults.every(message => (message.details as { toolOutputView?: unknown }).toolOutputView));
    assert.ok(sent.filter(message => message.role === 'toolResult').every(message => !message.details));
    sentOutputCap = undefined;
    const tooLarge = await runEphemeralWorker({ ...params, promptMessage: { ...promptMessage, content: 'x'.repeat(100_000) } });
    assert.equal(tooLarge.status, 'error');
    assert.match(tooLarge.error || '', /exceeds.*budget/);
    assert.equal(sentOutputCap, undefined, 'an oversized canonical payload never reaches the stream');
    console.log('delegated-tool-output-budget-test: ok (real worker and agent loop, mocked persistence/transport)');
  } finally { modules._load = originalLoad; await fs.rm(root, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
