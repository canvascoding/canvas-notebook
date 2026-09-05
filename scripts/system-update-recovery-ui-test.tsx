import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { SystemUpdateOperationView } from '../app/lib/system-updates/types';

let reloads = 0;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  if (error.message.includes('navigation')) reloads++; else throw error;
});
const dom = new JSDOM('<html><body></body></html>', { url: 'https://notebook.example.com/en/settings', pretendToBeVisual: true, virtualConsole });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
const id = '76e6f9f6-510a-4f00-babd-f9d3f3c17d15';
const key = 'canvas.system-update.operation-id';
const ticketKey = 'canvas.system-update.status-access';
const base: SystemUpdateOperationView = { contractVersion: 1, operationId: id, currentVersion: '2026.9.5', targetVersion: '2026.9.6',
  status: 'queued', stage: 'request_validation', startedAt: null, updatedAt: '2026-09-05T00:00:00Z',
  completedAt: null, rolledBack: false, errorCode: null, error: null, lastSequence: 0 };
const verifying: SystemUpdateOperationView = { ...base, status: 'verifying', stage: 'health_verification', lastSequence: 2 };
const succeeded: SystemUpdateOperationView = { ...base, status: 'succeeded', stage: 'completed', lastSequence: 3, completedAt: base.updatedAt };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function until(condition: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.ok(condition(), 'UI condition timed out');
}

async function main() {
  const { UpdateCenterPanel } = await import('../app/components/settings/UpdateCenterPanel');
  const originalFetch = globalThis.fetch;
  try {
    for (const mode of ['sse', 'managed'] as const) {
      const beforeReload = reloads;
      dom.window.localStorage.setItem(key, id);
      dom.window.sessionStorage.clear();
      if (mode === 'sse') dom.window.sessionStorage.setItem(ticketKey, JSON.stringify({ operationId: id,
        path: `/__canvas-host/operations/${id}/events`, ticket: 'fixture', expiresAt: new Date(Date.now() + 120_000).toISOString() }));
      let pollCount = 0;
      let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
      let delayedPoll: ((response: Response) => void) | null = null;
      globalThis.fetch = async (input, options) => {
        const url = String(input);
        if (url.startsWith('/__canvas-host/')) {
          assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture');
          return new Response(new ReadableStream({ start(controller) {
            stream = controller;
            options?.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
          } }), { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('/events?')) {
          pollCount++;
          if (mode === 'managed') {
            if (pollCount === 1) throw new Error('App restarting');
            return json({ success: true, operation: succeeded, events: [] });
          }
          return new Promise<Response>((resolve) => { delayedPoll = resolve; });
        }
        if (url.endsWith('/status-access')) return json({ success: true, access: null });
        throw new Error('App unavailable during restart');
      };
      const container = document.createElement('div'); document.body.append(container);
      const root = createRoot(container);
      await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><UpdateCenterPanel /></NextIntlClientProvider>));
      try {
        if (mode === 'sse') {
          await until(() => stream !== null && delayedPoll !== null);
          const send = (operation: SystemUpdateOperationView) => stream!.enqueue(new TextEncoder().encode(`event: operation\ndata: ${JSON.stringify(operation)}\n\n`));
          await act(async () => send(verifying));
          assert.ok(container.textContent?.includes(messages.settings.updates.phases.restarting.title));
          await act(async () => delayedPoll!(json({ success: true, operation: base, events: [] })));
          assert.ok(container.textContent?.includes(messages.settings.updates.phases.restarting.title), 'stale REST response must not undo SSE progress');
          await act(async () => send(succeeded));
        }
        await until(() => dom.window.localStorage.getItem(key) === null);
        assert.ok(container.textContent?.includes(messages.settings.updates.operation.status.succeeded));
        await until(() => reloads === beforeReload + 1);
        assert.equal(dom.window.sessionStorage.getItem(ticketKey), null);
        if (mode === 'managed') assert.equal(pollCount, 2, 'REST must retry even when the first operation load fails');
      } finally { await act(async () => root.unmount()); container.remove(); }
    }
  } finally { globalThis.fetch = originalFetch; dom.window.close(); }
  console.log('system-update-recovery-ui-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
