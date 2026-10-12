import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import type { CallToolResult } from '@modelcontextprotocol/client';
import messages from '../messages/en.json';
import { invalidateOpenedDocumentAuth, observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import type { ToolAppInvocation } from '../app/lib/tool-apps/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://canvas.fixture.invalid/en/notebook' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

type Auth = { data: { user: { id: string }; session: { id: string } } | null; isPending: boolean };
type RecordedRequest = { body: Record<string, unknown>; signal: AbortSignal | null | undefined };
type HeldResponse = { promise: Promise<Response>; release(response: Response): void };
type BridgeCall = { name: string; arguments?: Record<string, unknown> };
type HostContext = { locale?: string; theme?: string };
const bridges: FixtureAppBridge[] = [];
class FixtureAppBridge {
  oninitialized?: () => void;
  onerror?: () => void;
  onsizechange?: (size: { height: number }) => void;
  oncalltool?: (request: BridgeCall) => Promise<CallToolResult>;
  inputs: unknown[] = [];
  results: unknown[] = [];
  contexts: HostContext[] = [];
  closed = false;
  transport: unknown;
  constructor(_client: unknown, _identity: unknown, readonly capabilities: unknown, options: { hostContext: HostContext }) {
    this.contexts.push(options.hostContext); bridges.push(this);
  }
  async connect(transport: unknown) { this.transport = transport; }
  setHostContext(value: HostContext) { this.contexts.push(value); }
  async sendToolInput(value: unknown) { this.inputs.push(value); }
  async sendToolResult(value: unknown) { this.results.push(value); }
  async teardownResource() {}
  async close() { this.closed = true; }
}

/** Actual mounted host component; only auth, AppBridge and HTTP replies are controlled. No provider/server/browser acceptance claim. */
async function main(): Promise<void> {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  let auth: Auth = { data: { user: { id: 'widget-user' }, session: { id: 'auth-original' } }, isPending: false };
  loader._load = (name, parent, isMain) => {
    if (name === '@/app/lib/auth-client') return { authClient: { useSession: () => auth } };
    if (name === '@modelcontextprotocol/ext-apps/app-bridge') return { AppBridge: FixtureAppBridge };
    if (name === '@/components/ui/button') return { Button: ({ size: _size, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props} /> };
    if (name === './McpReconnectNotice' && parent?.filename.endsWith('/ToolAppWidget.tsx')) return { McpReconnectNotice: () => <p>Reconnect fixture</p> };
    return originalLoad(name, parent, isMain);
  };
  const { render, screen, fireEvent, cleanup, act, waitFor, configure } = await import('@testing-library/react');
  // Observation deadlines must not collide with the widget's intercepted retry delays.
  configure({ asyncUtilTimeout: 5000 });
  const { ToolAppWidget } = await import('../app/components/canvas-agent-chat/ToolAppWidget');
  const result: CallToolResult = { content: [{ type: 'text', text: 'Saved result' }] };
  const shared: ToolAppInvocation = { kind: 'mcp', descriptor: { version: 2,
    connectionRef: 'connection-org', toolCallId: 'tool-call-original', toolName: 'canva_describe', resourceUri: 'ui://fixture/design', bindingRevision: 'a'.repeat(64) },
  input: { design: 'original' }, result };
  const personal: ToolAppInvocation = { ...shared, descriptor: { version: 1, connectionId: '11111111-1111-4111-8111-111111111111',
    toolName: 'canva_describe', resourceUri: 'ui://fixture/design' } };
  const builtin: ToolAppInvocation = { kind: 'builtin', descriptor: { kind: 'builtin', version: 1, resourceUri: 'ui://canvas/automation-job/v1',
    entityId: 'job-11111111-1111-4111-8111-111111111111', toolCallId: 'builtin-call', operation: 'inspect_automation_job' } };
  const token = 'T'.repeat(43);
  const frameUrl = `https://preview.fixture.invalid/__preview/${token}/mcp-app/frame`;
  const rendered = (url = frameUrl) => Response.json({ success: true, data: { frameUrl: url, frameOrigin: new URL(url).origin, result } });
  const requests: RecordedRequest[] = [], pending: HeldResponse[] = [];
  const retryTimers = new Map<ReturnType<typeof setTimeout>, { callback(): void; delay: number }>();
  let retrySequence = 0;
  let handle: (request: RecordedRequest) => Response | Promise<Response> = () => rendered();
  const retain = (): HeldResponse => {
    let resolve!: (response: Response) => void;
    const held = { promise: new Promise<Response>(done => { resolve = done; }), release: (response: Response) => resolve(response) };
    pending.push(held); return held;
  };
  globalThis.fetch = async (input, init) => {
    assert(['/api/mcp/apps', '/api/chat/tool-apps'].includes(String(input)), 'the host uses only the expected render/call API');
    assert.equal(init?.method, 'POST'); assert.equal(init?.credentials, 'include');
    const request = { body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal };
    requests.push(request); return handle(request);
  };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if ([500, 1000, 2000, 4000, 8000].includes(delay ?? 0)) {
      const timer = { widgetRetry: ++retrySequence } as unknown as ReturnType<typeof setTimeout>;
      retryTimers.set(timer, { callback: () => callback(...args), delay: delay! }); return timer;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    if (!retryTimers.delete(timer)) originalClearTimeout(timer);
  }) as typeof clearTimeout;
  const setAuth = (userId = 'widget-user', sessionId = 'auth-original') => {
    auth = { data: { user: { id: userId }, session: { id: sessionId } }, isPending: false };
    observeOpenedDocumentAuth({ data: auth.data });
  };
  const view = (invocation: ToolAppInvocation = shared, sessionId = 'chat-original', agentId = 'agent-original') => <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <ToolAppWidget invocation={invocation} sessionId={sessionId} agentId={agentId} />
  </NextIntlClientProvider>;
  const mount = (invocation: ToolAppInvocation = shared) => {
    cleanup(); requests.length = 0; bridges.length = 0; retryTimers.clear(); setAuth();
    return render(view(invocation));
  };
  const frame = () => document.querySelector('iframe');
  const ready = async () => {
    await waitFor(() => { assert(frame()); assert(bridges.at(-1)); }); const bridge = bridges.at(-1)!;
    await act(async () => { bridge.oninitialized?.(); bridge.onsizechange?.({ height: 360 }); });
    assert.equal(frame()?.style.visibility, 'visible'); return bridge;
  };
  const runRetry = async () => {
    await waitFor(() => assert(retryTimers.size > 0, 'the completed 425 response schedules its read-only retry'));
    const entry = retryTimers.entries().next().value; assert(entry, 'the read-only retry is scheduled');
    retryTimers.delete(entry[0]); await act(async () => { entry[1].callback(); }); return entry[1].delay;
  };
  let cases = 0;
  try {
    handle = () => Response.json({ success: false }, { status: 425 }); mount();
    await waitFor(() => assert.equal(requests.length, 1));
    const delays: number[] = [];
    for (let index = 0; index < 8; index++) delays.push(await runRetry());
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000]);
    assert.equal(requests.length, 9); assert.equal(retryTimers.size, 0);
    assert(requests.every(request => request.body.action === 'render'));
    await screen.findByText(messages.chat.mcpApp.waitingForSave);
    assert.equal(frame(), null); cases++;

    const personalReply = retain(); handle = () => personalReply.promise; mount(personal);
    await waitFor(() => assert.equal(requests.length, 1));
    assert(screen.getByTestId('tool-app-loading-skeleton'));
    assert.equal(screen.queryByText(messages.chat.mcpApp.unavailable), null, 'a recorded request is not completed UI state');
    await act(async () => personalReply.release(Response.json({ success: false }, { status: 425 })));
    await screen.findByText(messages.chat.mcpApp.unavailable);
    assert.equal(requests.length, 1); assert.equal(retryTimers.size, 0); assert.equal(frame(), null); cases++;

    handle = () => Response.json({ success: false }, { status: 425 }); mount(builtin);
    await waitFor(() => assert.equal(requests.length, 1)); handle = () => rendered(); await runRetry();
    await ready(); assert.equal(requests.length, 2); cases++;

    let reads = 0; handle = () => ++reads === 1 ? Response.json({ success: false }, { status: 425 }) : rendered(); mount();
    await waitFor(() => assert.equal(requests.length, 1)); await runRetry(); const bridge = await ready();
    assert.equal(frame()?.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
    assert.equal(frame()?.getAttribute('referrerpolicy'), 'no-referrer'); assert.equal(frame()?.src, frameUrl);
    assert.deepEqual(bridge.capabilities, { serverTools: {} }); assert.equal(bridge.contexts[0].locale, 'en');
    await act(async () => { document.documentElement.classList.add('dark'); });
    assert.equal(bridge.contexts.at(-1)?.theme, 'dark'); document.documentElement.classList.remove('dark');
    let rejected!: Promise<CallToolResult>;
    await act(async () => { rejected = bridge.oncalltool!({ name: 'canva_update', arguments: { title: 'draft' } }); });
    assert.equal(requests.filter(request => request.body.action === 'call').length, 0, 'showing an approval causes no mutation');
    fireEvent.click(screen.getByRole('button', { name: messages.chat.mcpApp.reject }));
    assert.equal((await rejected).isError, true); assert.equal(requests.filter(request => request.body.action === 'call').length, 0);
    let allowed!: Promise<CallToolResult>;
    handle = request => request.body.action === 'call' ? Response.json({ success: true, data: result }) : rendered();
    await act(async () => { allowed = bridge.oncalltool!({ name: 'canva_update', arguments: { title: 'approved' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: messages.chat.mcpApp.allow })); });
    assert.deepEqual(await allowed, result);
    const call = requests.find(request => request.body.action === 'call')!.body;
    assert.equal(call.ticket, token); assert.equal(call.sessionId, 'chat-original'); assert.equal(call.agentId, 'agent-original');
    assert.deepEqual(call.app, shared.descriptor); assert.deepEqual(call.arguments, { title: 'approved' }); cases++;

    handle = request => request.body.action === 'call' ? Response.json({ success: false }, { status: 425 }) : rendered(); mount();
    const failedBridge = await ready(); let failed!: Promise<CallToolResult>;
    await act(async () => { failed = failedBridge.oncalltool!({ name: 'canva_update' }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: messages.chat.mcpApp.allow })); });
    assert.equal((await failed).isError, true); assert.equal(retryTimers.size, 0);
    assert.equal(requests.filter(request => request.body.action === 'call').length, 1, 'an approved mutation is never automatically replayed'); cases++;

    const late = retain(); handle = () => late.promise; const mounted = mount();
    await waitFor(() => assert.equal(requests.length, 1)); const firstRequest = requests[0];
    const next = retain(); handle = () => next.promise;
    mounted.rerender(view({ ...shared, descriptor: { ...shared.descriptor, toolName: 'canva_other' } }, 'chat-next'));
    assert.equal(firstRequest.signal?.aborted, true); assert.equal(frame(), null);
    await act(async () => late.release(rendered())); assert.equal(frame(), null); assert.equal(bridges.length, 0);
    await act(async () => next.release(rendered())); await ready(); cases++;

    for (const boundary of ['chat', 'agent', 'descriptor', 'actor', 'auth-session', 'auth-epoch', 'unmount'] as const) {
      handle = () => rendered(); const current = mount(); const original = await ready();
      let pendingApproval!: Promise<CallToolResult>;
      await act(async () => { pendingApproval = original.oncalltool!({ name: 'canva_update' }); });
      assert(screen.getByRole('button', { name: messages.chat.mcpApp.allow }));
      const held = retain(); handle = () => held.promise;
      await act(async () => {
        if (boundary === 'chat') current.rerender(view(shared, 'chat-next'));
        if (boundary === 'agent') current.rerender(view(shared, 'chat-original', 'agent-next'));
        if (boundary === 'descriptor') current.rerender(view({ ...shared, descriptor: { ...shared.descriptor, resourceUri: 'ui://fixture/other' } }));
        if (boundary === 'actor') { setAuth('widget-other'); current.rerender(view()); }
        if (boundary === 'auth-session') { setAuth('widget-user', 'auth-next'); current.rerender(view()); }
        if (boundary === 'auth-epoch') invalidateOpenedDocumentAuth();
        if (boundary === 'unmount') current.unmount();
      });
      assert.equal(frame(), null, `${boundary} removes the old iframe before the new render response`);
      assert.equal(screen.queryByRole('button', { name: messages.chat.mcpApp.allow }), null);
      assert.equal((await pendingApproval).isError, true); assert.equal(original.closed, true);
      assert.equal(requests.filter(request => request.body.action === 'call').length, 0); cases++;
    }

    for (const boundary of ['chat', 'descriptor', 'actor', 'auth-session', 'auth-epoch', 'unmount'] as const) {
      handle = () => rendered(); const current = mount(); const original = await ready();
      const heldCall = retain(), heldRender = retain();
      handle = request => request.body.action === 'call' ? heldCall.promise : heldRender.promise;
      let delayedCall!: Promise<CallToolResult>;
      await act(async () => { delayedCall = original.oncalltool!({ name: 'canva_update' }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: messages.chat.mcpApp.allow })); });
      const request = requests.find(candidate => candidate.body.action === 'call'); assert(request);
      await act(async () => {
        if (boundary === 'chat') current.rerender(view(shared, 'chat-next'));
        if (boundary === 'descriptor') current.rerender(view({ ...shared, descriptor: { ...shared.descriptor, resourceUri: 'ui://fixture/other' } }));
        if (boundary === 'actor') { setAuth('widget-other'); current.rerender(view()); }
        if (boundary === 'auth-session') { setAuth('widget-user', 'auth-next'); current.rerender(view()); }
        if (boundary === 'auth-epoch') invalidateOpenedDocumentAuth();
        if (boundary === 'unmount') current.unmount();
      });
      assert.equal(request.signal?.aborted, true);
      await act(async () => heldCall.release(Response.json({ success: true, data: result })));
      assert.equal((await delayedCall).isError, true, `${boundary} ignores a late successful mutation response`);
      assert.equal(frame(), null); assert.equal(screen.queryByText(messages.chat.mcpApp.callFailed), null);
      assert.equal(requests.filter(candidate => candidate.body.action === 'call').length, 1); cases++;
    }

    handle = () => rendered(); mount(personal); const personalBridge = await ready();
    let personalCall!: Promise<CallToolResult>;
    handle = request => request.body.action === 'call' ? Response.json({ success: true, data: result }) : rendered();
    await act(async () => { personalCall = personalBridge.oncalltool!({ name: 'canva_describe' }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: messages.chat.mcpApp.allow })); });
    assert.deepEqual(await personalCall, result);
    assert.equal('ticket' in requests.find(request => request.body.action === 'call')!.body, false, 'legacy v1 call wire shape remains unchanged'); cases++;

    for (const url of [`https://preview.fixture.invalid/__preview/${token}/mcp-app/frame?ticket=wrong`,
      `https://preview.fixture.invalid/__preview/${token}/mcp-app/frame#wrong`,
      `http://preview.fixture.invalid/__preview/${token}/mcp-app/frame`,
      `https://preview.fixture.invalid/__preview/short/mcp-app/frame`]) {
      handle = () => rendered(url); mount(); await screen.findByText(messages.chat.mcpApp.unavailable);
      assert.equal(frame(), null); assert.equal(bridges.length, 0); cases++;
    }
    console.log(`mcp-app-widget-lifecycle-test: PASS (${cases} actual mounted host cases; bounded read-only retry, current frame ticket, explicit approval, owner changes and stale responses, v1/builtin compatibility, frame boundaries)`);
  } finally {
    cleanup(); for (const held of pending) held.release(rendered());
    globalThis.fetch = originalFetch; loader._load = originalLoad;
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
    dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
