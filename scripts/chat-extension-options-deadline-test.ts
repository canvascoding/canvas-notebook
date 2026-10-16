import assert from 'node:assert/strict';
import Module from 'node:module';
import type { ChatExtensionOptionsTarget, ChatExtensionSearchRequest } from '../app/lib/chat/extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Actual request parsing, deadline composition and dispatch. Context/source transport is deliberately held;
 * this scheduling regression supplies no SQL, authorization, account, provider or runtime evidence. */
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  const nativeAny = AbortSignal.any;
  const deadlines: Array<{ milliseconds: number; controller: AbortController }> = [];
  const listeners: Array<{ signal: AbortSignal; active: Set<EventListenerOrEventListenerObject>; added: number; removed: number }> = [];
  Object.defineProperty(AbortSignal, 'timeout', { ...timeoutDescriptor, value: (milliseconds: number) => {
    const controller = new AbortController(); deadlines.push({ milliseconds, controller }); return controller.signal;
  } });
  Object.defineProperty(AbortSignal, 'any', { ...anyDescriptor, value: (signals: AbortSignal[]) => {
    const signal = nativeAny.call(AbortSignal, signals);
    const observed = { signal, active: new Set<EventListenerOrEventListenerObject>(), added: 0, removed: 0 };
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    Object.defineProperty(signal, 'addEventListener', { configurable: true,
      value: (name: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (name === 'abort' && listener) { observed.active.add(listener); observed.added += 1; }
        if (listener) add(name, listener, options);
      } });
    Object.defineProperty(signal, 'removeEventListener', { configurable: true,
      value: (name: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
        if (name === 'abort' && listener) { observed.active.delete(listener); observed.removed += 1; }
        if (listener) remove(name, listener, options);
      } });
    listeners.push(observed); return signal;
  } });
  const target: ChatExtensionOptionsTarget = { kind: 'draft_turn', agentId: 'deadline-agent', workspaceId: 'deadline-workspace' };
  const context = { actor: { userId: 'deadline-user', workspaceId: 'deadline-workspace' }, target, contextKey: 'controlled-deadline-context' };
  const header = { schemaVersion: 1 as const, target, contextKey: context.contextKey, agentRevision: 1, workflowRevision: 0,
    preferenceRevision: 0, finalSendValidationRequired: true as const, coverage: [], limits: EXTENSION_SELECTION_LIMITS };
  const pagination = { nextCursor: null, hasNextPage: false, loadedItems: 0 };
  let contextHold: ReturnType<typeof deferred<typeof context>> | null = null;
  let searchHold: ReturnType<typeof deferred<unknown>> | null = null;
  let contextCalls = 0, searchCalls = 0, recentCalls = 0, forbiddenCalls = 0;
  const seenSearchSignals: AbortSignal[] = [];
  const searchResult = (request: ChatExtensionSearchRequest) => ({ ...header, operation: 'search' as const, query: request,
    items: [], selectedItem: null, scopes: { choices: ['all'], teams: [] }, pagination });
  const forbidden = () => { forbiddenCalls += 1; throw new Error('This deadline test must never read data, providers or runtime.'); };
  const fixtures = new Map<string, unknown>([
    ['@/app/lib/capabilities/resources/actions', { listCapabilityResources: forbidden }],
    ['@/app/lib/capabilities/resources/store', { findCapabilityResourceRecord: forbidden }],
    ['@/app/lib/agents/extension-package-options', { readAgentExtensionPackageVersion: forbidden }],
    ['@/app/lib/agents/extension-options-search', { searchChatExtensionOptions: async (_context: unknown, request: ChatExtensionSearchRequest, signal: AbortSignal) => {
      searchCalls += 1; seenSearchSignals.push(signal); return searchHold ? searchHold.promise : searchResult(request);
    } }],
    ['@/app/lib/agents/extension-options-connections', { listChatExtensionConnectionChoices: forbidden }],
    ['./extension-options-context', { resolveChatExtensionOptionsContext: async () => { contextCalls += 1; return contextHold ? contextHold.promise : context; },
      chatExtensionOptionsHeader: () => header, revalidateChatExtensionOptionsContext: forbidden }],
    ['./extension-options-eligibility', { chatPackageBinding: forbidden, chatPermittedPackageRoots: forbidden }],
    ['./extension-options-presentation', { presentChatExtensionIcon: forbidden }],
    ['./extension-options-recents', { readChatExtensionRecents: async () => { recentCalls += 1; return { items: [], pagination }; } }],
    ['./extension-options-preview', { previewChatExtensionSelection: forbidden }],
  ]);
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db') return forbidden();
    if (parent?.filename.endsWith('/app/lib/chat/extension-options.ts') && fixtures.has(name)) return fixtures.get(name);
    return originalLoad(name, parent, isMain);
  };
  const pendingFailures: unknown[] = [];
  const unhandled = (reason: unknown) => { pendingFailures.push(reason); };
  process.on('unhandledRejection', unhandled);
  try {
    const { listChatExtensionOptions } = await import('../app/lib/chat/extension-options');
    const actor = { userId: context.actor.userId, workspaceId: context.actor.workspaceId, source: 'api' as const };
    const request = { operation: 'search' as const, target, q: 'deadline', phase: 'local' as const, types: ['skill' as const] };
    const realSignal = () => new Request('https://deadline.example.test/api/chat/extension-options', { method: 'POST' }).signal;
    const assertDetached = () => {
      assert(listeners.every(entry => entry.active.size === 0), 'Every completed wrapper removes its own combined-signal listener.');
      assert(listeners.every(entry => entry.added === entry.removed), 'Each installed abort listener has a matching explicit cleanup.');
    };

    // The presence of a genuine, healthy HTTP Request.signal must not disable the server budget.
    contextHold = deferred();
    const first = listChatExtensionOptions(actor, request, { signal: realSignal() });
    assert.equal(contextCalls, 1); assert.equal(searchCalls, 0);
    assert.equal(deadlines.at(-1)?.milliseconds, 15_000);
    deadlines.at(-1)!.controller.abort(new DOMException('Controlled deadline', 'TimeoutError'));
    await assert.rejects(first, { code: 'CHAT_EXTENSION_OPTIONS_TIMEOUT', status: 504 });
    assertDetached();
    contextHold.resolve(context); await flush(); contextHold = null;
    assert.equal(searchCalls, 0, 'An obsolete context completion must not start a late catalogue search.');
    assert.equal(recentCalls, 0);

    // An already cancelled browser request performs no context/data work.
    const beforeContext = contextCalls, early = new AbortController(), earlyReason = new Error('Controlled obsolete request');
    early.abort(earlyReason);
    const earlyRequest = new Request('https://deadline.example.test/early', { signal: early.signal });
    await assert.rejects(listChatExtensionOptions(actor, request, { signal: earlyRequest.signal }), error => error === earlyReason);
    assert.equal(contextCalls, beforeContext); assertDetached();

    // Cancellation during genuine context transport settles immediately and still fences late work.
    contextHold = deferred();
    const caller = new AbortController(), callerReason = new Error('Controlled caller cancellation');
    const during = listChatExtensionOptions(actor, request, { signal: new Request('https://deadline.example.test/during', { signal: caller.signal }).signal });
    caller.abort(callerReason);
    await assert.rejects(during, error => error === callerReason);
    assertDetached(); contextHold.resolve(context); await flush(); contextHold = null;
    assert.equal(searchCalls, 0);

    // Calls without an HTTP signal still have the same fixed server deadline.
    contextHold = deferred();
    const without = listChatExtensionOptions(actor, request);
    assert.equal(deadlines.at(-1)?.milliseconds, 15_000);
    deadlines.at(-1)!.controller.abort(new DOMException('Controlled deadline', 'TimeoutError'));
    await assert.rejects(without, { code: 'CHAT_EXTENSION_OPTIONS_TIMEOUT', status: 504 });
    contextHold.resolve(context); await flush(); contextHold = null; assertDetached();

    // Success and parse errors detach their listeners too; an older deadline cannot affect the next request.
    const success = await listChatExtensionOptions(actor, request, { signal: realSignal() });
    assert.equal(success.operation, 'search'); assert.equal(searchCalls, 1); assertDetached();
    const completedDeadline = deadlines.at(-1)!;
    contextHold = deferred();
    const next = listChatExtensionOptions(actor, request, { signal: realSignal() });
    const nextSignal = listeners.at(-1)!.signal;
    completedDeadline.controller.abort(new DOMException('Old deadline', 'TimeoutError'));
    assert.equal(nextSignal.aborted, false);
    contextHold.resolve(context); contextHold = null;
    assert.equal((await next).operation, 'search'); assertDetached();
    const beforeInvalid = contextCalls;
    await assert.rejects(listChatExtensionOptions(actor, { operation: 'not-an-operation' }, { signal: realSignal() }), { code: 'CHAT_EXTENSION_OPTIONS_INVALID' });
    assert.equal(contextCalls, beforeInvalid); assertDetached();

    // A source may ignore AbortSignal. Its late completion must not launch a new recents phase after the response timed out.
    searchHold = deferred();
    const blank = { ...request, q: '' };
    const late = listChatExtensionOptions(actor, blank, { signal: realSignal() });
    await flush();
    assert.equal(searchCalls, 3);
    assert.equal(seenSearchSignals.at(-1)?.aborted, false);
    deadlines.at(-1)!.controller.abort(new DOMException('Controlled source deadline', 'TimeoutError'));
    await assert.rejects(late, { code: 'CHAT_EXTENSION_OPTIONS_TIMEOUT', status: 504 });
    assert.equal(seenSearchSignals.at(-1)?.aborted, true); assertDetached();
    searchHold.resolve(searchResult(blank as ChatExtensionSearchRequest)); await flush(); searchHold = null;
    assert.equal(recentCalls, 0, 'A late source completion cannot start recents after the outer deadline.');
    assert.equal(forbiddenCalls, 0); assert.equal(pendingFailures.length, 0);
    assert(deadlines.every(entry => entry.milliseconds === 15_000));
    console.log(`PASS actual Chat options deadline wrapper: healthy Request.signal keeps the fixed 15000ms budget, early/during-context cancellation fences late searches, caller reasons and 504 timeout mapping, old-deadline isolation, normal/error/abort listener cleanup, late-source follow-up fence; ${deadlines.length} controlled budgets, no real wait/SQL/UI/provider/runtime.`);
  } finally {
    loader._load = originalLoad;
    Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    process.removeListener('unhandledRejection', unhandled);
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
