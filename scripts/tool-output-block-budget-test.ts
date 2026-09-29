import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

type ToolMessage = Extract<AgentMessage, { role: 'toolResult' }>;
function toolText(message: ToolMessage) { return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'); }
function model(contextWindow: number, provider = 'fixture'): Model<'openai-completions'> {
  return { id: 'budget-fixture', name: 'Budget fixture', api: 'openai-completions', provider, baseUrl: 'https://example.invalid',
    contextWindow, maxTokens: 4_096, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-block-budget-'));
  process.env.DATA = root; process.env.CANVAS_DATA_ROOT = root;
  const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = modules._load;
  modules._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if ((request.startsWith('.') || request.startsWith('@/')) && request.endsWith('/auth')) return { auth: {} };
    if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined,
      toToolDeclaration: (tool: unknown) => tool,
      createInitialSystemMessage: (systemPrompt: string) => ({ role: 'system', content: systemPrompt, timestamp: 0 }),
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { prepareToolOutput } = await import('../app/lib/pi/tool-output-preparation');
    const { prepareWebToolOutput } = await import('../app/lib/pi/web-output-preparation');
    const { finalizeToolOutputBlocks } = await import('../app/lib/pi/tool-output-block-storage');
    const { planToolOutputBlockViews, projectToolOutputBlocks } = await import('../app/lib/pi/tool-output-block-budget');
    const { getToolOutputMetadata } = await import('../app/lib/pi/tool-output-metadata');
    const { readStoredToolOutput, inspectToolOutputUsage } = await import('../app/lib/pi/tool-output-store');
    const { formatTextReadResult } = await import('../app/lib/pi/text-read-result');
    const { preparePiFinalPayload } = await import('../app/lib/pi/multimodal-preparation');
    const { estimatePiTextTokens } = await import('../app/lib/pi/context-budget');
    const { parsePersistedPiMessage } = await import('../app/lib/pi/message-projection');
    const { projectAgentMessageForPersistence } = await import('../app/lib/pi/visual-data-projection');
    const identity = { organizationId: null, userId: 'block-user', sessionId: 'block-session', workspaceId: 'block-workspace' };
    const long = 'Source start '.repeat(1_000) + 'MiddleSourceDetail' + ' source end'.repeat(1_000);
    const prepared: Array<{ name: string; result: AgentToolResult<unknown> }> = [];
    prepared.push({ name: 'web_search', result: await prepareWebToolOutput({ identity, toolCallId: 'block-0', kind: 'search', provider: 'future', heading: 'Search',
      sources: Array.from({ length: 3 }, (_, index) => ({ title: `Search ${index + 1}`, url: `https://example.test/search-${index}`, snippet: long })) }) });
    prepared.push({ name: 'web_fetch', result: await prepareWebToolOutput({ identity, toolCallId: 'block-1', kind: 'pages', provider: 'http', heading: 'Pages',
      sources: Array.from({ length: 2 }, (_, index) => ({ title: `Page ${index + 1}`, url: `https://example.test/page-${index}`, content: long, statusCode: 200 })) }) });
    for (let index = 2; index < 8; index++) {
      prepared.push({ name: 'future_tool', result: await prepareToolOutput({ identity, toolCallId: `block-${index}`, toolName: 'future',
        result: { content: [{ type: 'text', text: JSON.stringify({ body: 'medium '.repeat(400), id: `created-${index}`, success: true }) }], details: { filePath: 'notes/result.txt' } } }) });
    }
    const readBody = '😀a'.repeat(4_000);
    const readOffset = 31;
    const formatted = formatTextReadResult(readBody, { offset: readOffset, nextOffset: readOffset + readBody.length, totalChars: 50_000, eof: false }, 'a'.repeat(64));
    prepared.push({ name: 'read', result: { content: [{ type: 'text', text: formatted.text }], details: { type: 'text', offset: readOffset,
      nextOffset: readOffset + readBody.length, totalChars: 50_000, eof: false, sha256: 'a'.repeat(64), toolOutputReadWindow: formatted.layout } } });
    const baseModel = model(16_000);
    const assistant: Extract<AgentMessage, { role: 'assistant' }> = {
      role: 'assistant', api: baseModel.api, model: baseModel.id, provider: baseModel.provider, timestamp: 2, stopReason: 'toolUse',
      content: prepared.map(({ name }, index) => ({ type: 'toolCall', name, id: `block-${index}`, arguments: {} })),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const messages: AgentMessage[] = [{ role: 'user', content: 'Compare the sources and preserve the created identifiers.', timestamp: 1 }, assistant,
      ...prepared.map(({ name, result }, index) => ({ ...result, details: result.details === undefined ? undefined : JSON.parse(JSON.stringify(result.details)),
        role: 'toolResult' as const, toolName: name, toolCallId: `block-${index}`, isError: false, timestamp: index + 3 })),
    ];
    const originalContent = messages.map(message => JSON.stringify('content' in message ? message.content : undefined));
    const first = await finalizeToolOutputBlocks(messages, baseModel, identity);
    assert.deepEqual(messages.map(message => JSON.stringify('content' in message ? message.content : undefined)), originalContent, 'base contents remain available when model changes');
    const smallDrafts = planToolOutputBlockViews(messages, baseModel).drafts;
    const allocatedBefore = smallDrafts.map(draft => draft.view.text.length);
    for (const draft of smallDrafts) assert.ok(draft.view.estimatedTokens <= 800);
    assert.ok(smallDrafts.reduce((sum, draft) => sum + draft.view.estimatedTokens, 0) <= 2_400);
    assert.match(toolText(first[2] as ToolMessage), /\[S3\]/);
    assert.match(toolText(first[3] as ToolMessage), /\[S2\]/);
    let archivedMediumResults = 0;
    let preservedMediumResults = 0;
    for (let index = 4; index < 10; index++) {
      const original = messages[index] as ToolMessage;
      assert.match(toolText(first[index] as ToolMessage), new RegExp(`created-${index - 2}`));
      const reference = getToolOutputMetadata(original.details)?.references[0];
      if (toolText(first[index] as ToolMessage) === toolText(original)) {
        preservedMediumResults++;
        continue;
      }
      archivedMediumResults++;
      assert.ok(reference, 'trimmed medium results are archived');
      const stored = JSON.parse((await readStoredToolOutput(identity, reference.reference)).content);
      assert.equal(stored.content[0].text, toolText(original));
    }
    assert.ok(archivedMediumResults > 0 && preservedMediumResults > 0, 'largest-first allocation keeps smaller results intact');
    const read = first[10] as ToolMessage;
    const readDetails = read.details as { nextOffset: number; offset: number; toolOutputReadWindow: { bodyStart: number; bodyEnd: number } };
    const visibleReadBody = toolText(read).slice(readDetails.toolOutputReadWindow.bodyStart, readDetails.toolOutputReadWindow.bodyEnd);
    assert.equal(readDetails.nextOffset, readOffset + visibleReadBody.length);
    assert.ok(visibleReadBody.length > 0);
    assert.ok(readBody.startsWith(visibleReadBody));
    assert.ok(!/[\uD800-\uDBFF]$/u.test(visibleReadBody));
    assert.match(toolText(read), new RegExp(`nextOffset: ${readDetails.nextOffset};`));

    // A completed write can carry more than 6k tokens of arguments. Its result
    // still needs to reach the model without executing the write a second time.
    const writeBody = 'Campaign paragraph. '.repeat(1_600);
    const writeAssistant: Extract<AgentMessage, { role: 'assistant' }> = {
      ...assistant,
      content: [{ type: 'toolCall', name: 'create_file', id: 'write-once',
        arguments: { path: 'campaigns/first.md', content: writeBody } }],
    };
    const writeResult: ToolMessage = {
      ...(messages[4] as ToolMessage), toolCallId: 'write-once', toolName: 'create_file',
      content: [{ type: 'text', text: 'Created campaigns/first.md' }],
    };
    const writeRound: AgentMessage[] = [writeAssistant, writeResult];
    assert.ok(estimatePiTextTokens(JSON.stringify({ role: 'assistant', content: writeAssistant.content })) > 6_000);
    const projectedWriteRound = projectToolOutputBlocks(writeRound, model(262_144));
    const projectedCall = (projectedWriteRound[0] as typeof writeAssistant).content.find(part => part.type === 'toolCall');
    assert.ok(projectedCall && projectedCall.type === 'toolCall');
    assert.equal(projectedCall.arguments.content, writeBody);
    assert.equal((projectedWriteRound[1] as ToolMessage).toolCallId, 'write-once');
    const originalCall = writeAssistant.content.find(part => part.type === 'toolCall');
    assert.ok(originalCall && originalCall.type === 'toolCall');
    assert.equal(originalCall.arguments.content, writeBody);
    const finalizedWriteRound = await finalizeToolOutputBlocks(writeRound, model(262_144), identity);
    const resumedWriteRound = writeRound.map(message => parsePersistedPiMessage(JSON.stringify(projectAgentMessageForPersistence(message))));
    assert.deepEqual(projectToolOutputBlocks(resumedWriteRound, model(262_144)).map(message => 'content' in message ? message.content : undefined),
      finalizedWriteRound.map(message => 'content' in message ? message.content : undefined), 'resumed write round uses the same model view');
    const writePayload = await preparePiFinalPayload({ messages: resumedWriteRound, model: model(262_144),
      effectiveInstructions: [{ role: 'system', content: 'Continue the campaign.' }], effectiveTools: [], requestOutputTokenCap: 1_024 });
    assert.equal(writePayload.budgetSnapshot.contextBudgetExceeded, false);
    assert.equal(writePayload.messages.find(message => message.role === 'toolResult')?.toolCallId, 'write-once');

    assert.deepEqual(projectToolOutputBlocks(first, baseModel).map(message => 'content' in message ? message.content : undefined), first.map(message => 'content' in message ? message.content : undefined), 'provider projection is idempotent');
    const resumed = messages.map(message => parsePersistedPiMessage(JSON.stringify(projectAgentMessageForPersistence(message))));
    assert.deepEqual(projectToolOutputBlocks(resumed, baseModel).map(message => 'content' in message ? message.content : undefined), first.map(message => 'content' in message ? message.content : undefined), 'persisted and active views match');
    const appended = [...messages, { role: 'user' as const, content: 'Follow up '.repeat(200), timestamp: 20 }];
    assert.deepEqual(projectToolOutputBlocks(appended, baseModel).slice(0, messages.length).map(message => 'content' in message ? message.content : undefined), first.map(message => 'content' in message ? message.content : undefined), 'later history does not resize a completed block');
    const usage = await inspectToolOutputUsage(identity);
    await Promise.all([finalizeToolOutputBlocks(messages, baseModel, identity), finalizeToolOutputBlocks(messages, baseModel, identity)]);
    assert.deepEqual(await inspectToolOutputUsage(identity), usage, 'repeated/concurrent finalization does not duplicate originals');

    for (const contextWindow of [16_000, 32_000, 262_144]) {
      let comparableText: string[] | null = null;
      for (const provider of ['ollama-fixture', 'anthropic-fixture', 'future-provider']) {
        const effectiveModel = model(contextWindow, provider);
        const view = projectToolOutputBlocks(resumed, effectiveModel);
        const drafts = planToolOutputBlockViews(resumed, effectiveModel).drafts;
        assert.ok(drafts.every(draft => draft.view.estimatedTokens <= Math.floor(contextWindow * 0.05)));
        assert.ok(drafts.reduce((sum, draft) => sum + draft.view.estimatedTokens, 0) <= Math.min(6_000, Math.floor(contextWindow * 0.15)));
        const texts = view.filter((message): message is ToolMessage => message.role === 'toolResult').map(toolText);
        if (comparableText) assert.deepEqual(texts, comparableText, 'provider names do not change budgeting');
        comparableText = texts;
        const payload = await preparePiFinalPayload({ messages: view, model: effectiveModel, effectiveInstructions: [{ role: 'system', content: 'Use sources. '.repeat(100) }],
          effectiveTools: [], requestOutputTokenCap: 1_024 });
        assert.equal(payload.budgetSnapshot.contextBudgetExceeded, false);
        const results = payload.messages.filter(message => message.role === 'toolResult');
        assert.equal(results.length, prepared.length);
        assert.ok(results.every(result => result.details === undefined), 'internal views/details are absent from the provider payload');
        assert.equal(results[2].details, undefined);
        if (contextWindow === 32_000) assert.ok(drafts.reduce((sum, draft) => sum + draft.view.text.length, 0) > allocatedBefore.reduce((sum, value) => sum + value, 0), 'an explicit larger model can restore a larger view');
      }
    }
    const { LivePiRuntime } = await import('../app/lib/pi/live-runtime');
    const { measurePiContextStatus } = await import('../app/lib/pi/context-status-measurement');
    for (const contextWindow of [16_000, 32_000, 262_144]) {
      const effectiveModel = model(contextWindow);
      const runtime = Object.assign(Object.create(LivePiRuntime.prototype), {
        sessionId: identity.sessionId, provider: effectiveModel.provider, model: effectiveModel, executionContext: identity,
        requestOutputTokenCap: 1_024, messageContextSnapshots: new Map(), lastProviderInputUsage: null,
        summary: { summaryText: null, summaryUpdatedAt: null, summaryThroughTimestamp: null, summaryThroughSequence: null, summaryRevision: 0 },
        getRuntimeContextBlock: async () => null, getEffectiveSystemPrompt: () => 'system instructions', getEffectiveTools: () => [],
        coordinateCompaction: async () => { throw new Error('Unexpected compaction for bounded tool block'); },
      });
      const candidate = await runtime.transformContext(structuredClone(resumed));
      const sent = await runtime.prepareFinalPayload(candidate);
      const canonical = await preparePiFinalPayload({ messages: candidate, model: effectiveModel, effectiveInstructions: [{ role: 'system', content: 'system instructions' }], effectiveTools: [], requestOutputTokenCap: 1_024 });
      assert.deepEqual(sent.filter((message: { role: string }) => message.role !== 'system'), canonical.messages, 'real LivePiRuntime sends the canonical bounded view');
      const measured = await measurePiContextStatus(runtime.lastComposition, { messages: candidate, model: effectiveModel,
        effectiveInstructions: [{ role: 'system', content: 'system instructions' }], effectiveTools: [], requestOutputTokenCap: 1_024 });
      assert.equal(measured.components?.messages, canonical.budgetSnapshot.serializedMessageTokens, 'context status measures the same provider messages');
    }
    const overloaded = await preparePiFinalPayload({ messages: [...first, { role: 'user', content: 'x'.repeat(80_000), timestamp: 30 }], model: baseModel,
      effectiveInstructions: [{ role: 'system', content: 'x'.repeat(10_000) }], effectiveTools: [], requestOutputTokenCap: 1_024 });
    assert.equal(overloaded.budgetSnapshot.contextBudgetExceeded, true, 'real conversation/instruction pressure remains visible');
    const tinyView = projectToolOutputBlocks(messages, model(100));
    assert.deepEqual(tinyView.filter(message => message.role === 'toolResult').map(message => message.toolCallId),
      messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId), 'minimum views preserve every result pairing');
    const tinyPayload = await preparePiFinalPayload({ messages: tinyView, model: model(100),
      effectiveInstructions: [{ role: 'system', content: 'Use sources.' }], effectiveTools: [], requestOutputTokenCap: 16 });
    assert.equal(tinyPayload.budgetSnapshot.contextBudgetExceeded, true, 'the final payload reports genuine context overflow');
    const incomplete = messages.slice(0, -1);
    assert.equal(planToolOutputBlockViews(incomplete, baseModel).drafts.length, 0, 'incomplete blocks are not finalized');
    console.log('tool-output-block-budget-test: ok (16k/32k/262k, canonical payload, storage, resume, model switch and offsets)');
  } finally { modules._load = originalLoad; await fs.rm(root, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
