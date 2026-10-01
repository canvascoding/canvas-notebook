import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { StartSystemUpdateInput, SystemUpdateAvailability, SystemUpdateOperationView } from '../app/lib/system-updates/types';

let reloads = 0;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  if (error.message.includes('navigation')) reloads++; else throw error;
});
const dom = new JSDOM('<html><body></body></html>', {
  url: 'https://notebook.example.com/en/settings', pretendToBeVisual: true, virtualConsole,
});
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });

const operationKey = 'canvas.system-update.operation-id';
const intentKey = 'canvas.system-update.start-intent';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fixtureId = '76e6f9f6-510a-4f00-babd-f9d3f3c17d15';
const availability: SystemUpdateAvailability = {
  contractVersion: 1, mode: 'standalone', platform: 'canvas-installer', channel: 'stable',
  currentVersion: '2026.9.5', updateAvailable: true, ready: true, idempotentStart: true,
  reasons: [], instructions: [], release: {
    releaseId: 'release-2026.9.6', version: '2026.9.6', publishedAt: '2026-09-05T00:00:00Z',
    backupRequired: false, releaseNotesUrl: null,
  },
};
function operation(operationId: string, status: 'queued' | 'verifying' | 'succeeded'): SystemUpdateOperationView {
  return {
    contractVersion: 1, operationId, currentVersion: '2026.9.5', targetVersion: '2026.9.6', status,
    stage: status === 'queued' ? 'request_validation' : status === 'verifying' ? 'health_verification' : 'completed',
    startedAt: status === 'queued' ? null : '2026-09-05T00:00:01Z',
    updatedAt: status === 'queued' ? '2026-09-05T00:00:00Z' : status === 'verifying' ? '2026-09-05T00:00:02Z' : '2026-09-05T00:00:03Z',
    completedAt: status === 'succeeded' ? '2026-09-05T00:00:03Z' : null,
    rolledBack: false, errorCode: null, error: null, lastSequence: status === 'queued' ? 0 : status === 'verifying' ? 2 : 3,
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
async function until(condition: () => boolean, description: string, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  assert.ok(condition(), description);
}
function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === text);
}
async function confirmUpdate(): Promise<void> {
  await until(() => Boolean(findButton(messages.settings.updates.installUpdate)), 'update install action appears');
  await act(async () => findButton(messages.settings.updates.installUpdate)!.click());
  await until(() => Boolean(findButton(messages.settings.updates.confirm.action)), 'confirmation action appears');
  await act(async () => findButton(messages.settings.updates.confirm.action)!.click());
}
function assertStorageCleared(): void {
  assert.equal(dom.window.localStorage.getItem(operationKey), null, 'completed operation must leave no active ID');
  assert.equal(dom.window.localStorage.getItem(intentKey), null, 'completed operation must leave no pending start');
}

async function main(): Promise<void> {
  const { UpdateCenterPanel } = await import('../app/components/settings/UpdateCenterPanel');
  const originalFetch = globalThis.fetch;
  const mount = async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><UpdateCenterPanel /></NextIntlClientProvider>));
    return { container, close: async () => { await act(async () => root.unmount()); container.remove(); } };
  };
  try {
    {
      dom.window.localStorage.clear();
      dom.window.sessionStorage.clear();
      const beforeReload = reloads;
      let input: StartSystemUpdateInput | null = null;
      let posts = 0;
      let polls = 0;
      let finish = false;
      globalThis.fetch = async (request, options) => {
        const url = String(request);
        if (url.includes('?channel=')) return json({ success: true, data: availability });
        if (url === '/api/admin/system-updates' && options?.method === 'POST') {
          posts++;
          input = JSON.parse(String(options.body)) as StartSystemUpdateInput;
          assert.ok(input.requestId && uuidPattern.test(input.requestId), 'start supplies a valid stable operation UUID');
          assert.equal(dom.window.localStorage.getItem(operationKey), input.requestId, 'operation ID is persisted before POST');
          assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(intentKey) || 'null'), input, 'complete start intent is persisted before POST');
          throw new Error('Accepted update response was lost');
        }
        if (url.includes('/events?')) {
          polls++;
          assert.ok(input?.requestId);
          assert.ok(url.includes(`/${input.requestId}/events?`), 'recovery polls the preallocated operation ID');
          return json({ success: true, operation: operation(input.requestId, finish ? 'succeeded' : 'verifying'), events: [] });
        }
        if (url.endsWith('/status-access')) return json({ success: true, access: null });
        throw new Error(`Unexpected request: ${url}`);
      };
      const ui = await mount();
      try {
        await confirmUpdate();
        await until(() => polls > 0 && dom.window.localStorage.getItem(intentKey) === null, 'polling recovers the accepted start after its receipt is lost');
        assert.equal(posts, 1, 'recovery observes the accepted operation without starting another');
        assert.equal(dom.window.localStorage.getItem(operationKey), input!.requestId);
        assert.ok(!ui.container.textContent?.includes('Accepted update response was lost'), 'recovered operation clears the start error');
        finish = true;
        await until(() => dom.window.localStorage.getItem(operationKey) === null, 'recovered operation completes');
        assertStorageCleared();
        await until(() => reloads === beforeReload + 1, 'successful recovery reloads once');
      } finally { await ui.close(); }
    }

    {
      dom.window.localStorage.clear();
      dom.window.sessionStorage.clear();
      const beforeReload = reloads;
      const input: StartSystemUpdateInput = { channel: 'stable', expectedReleaseId: availability.release!.releaseId, requestId: fixtureId };
      dom.window.localStorage.setItem(intentKey, JSON.stringify(input));
      dom.window.localStorage.setItem(operationKey, fixtureId);
      let polls = 0;
      let posts = 0;
      let finish = false;
      globalThis.fetch = async (request, options) => {
        const url = String(request);
        if (url.includes('?channel=')) return json({ success: true, data: availability });
        if (url === '/api/admin/system-updates' && options?.method === 'POST') { posts++; throw new Error('Early retry is unnecessary'); }
        if (url.endsWith('/status-access')) return json({ success: true, access: null });
        if (url.includes('/events?')) {
          polls++;
          assert.ok(url.includes(`/${fixtureId}/events?`));
          if (polls === 1) return json({ error: { code: 'operation_not_found', message: 'Host has not persisted this start yet' } }, 404);
          return json({ success: true, operation: operation(fixtureId, finish ? 'succeeded' : 'verifying'), events: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      };
      const ui = await mount();
      try {
        await until(() => polls === 1, 'restored intent is observed before host persistence');
        assert.ok(ui.container.textContent?.includes(messages.settings.updates.reconnecting.title));
        assert.ok(!ui.container.textContent?.includes('Host has not persisted this start yet'), 'a pending start treats its initial 404 as temporary');
        assert.equal(dom.window.localStorage.getItem(intentKey), JSON.stringify(input));
        await until(() => polls >= 2 && dom.window.localStorage.getItem(intentKey) === null, 'a remounted page continues polling through temporary 404');
        assert.equal(posts, 0, 'observation finds the existing request before any retry');
        assert.equal(dom.window.localStorage.getItem(operationKey), fixtureId);
        finish = true;
        await until(() => dom.window.localStorage.getItem(operationKey) === null, 'restored request completes');
        assertStorageCleared();
        await until(() => reloads === beforeReload + 1, 'restored success reloads once');
      } finally { await ui.close(); }
    }

    {
      dom.window.localStorage.clear();
      dom.window.sessionStorage.clear();
      const beforeReload = reloads;
      let input: StartSystemUpdateInput | null = null;
      let receipt: ((response: Response) => void) | null = null;
      let polls = 0;
      globalThis.fetch = async (request, options) => {
        const url = String(request);
        if (url.includes('?channel=')) return json({ success: true, data: availability });
        if (url === '/api/admin/system-updates' && options?.method === 'POST') {
          input = JSON.parse(String(options.body)) as StartSystemUpdateInput;
          assert.ok(input.requestId && uuidPattern.test(input.requestId));
          return new Promise<Response>((resolve) => { receipt = resolve; });
        }
        if (url.endsWith('/status-access')) return json({ success: true, access: null });
        if (url.includes('/events?')) {
          polls++;
          assert.ok(input?.requestId);
          return json({ success: true, operation: operation(input.requestId, 'succeeded'), events: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      };
      const ui = await mount();
      try {
        await confirmUpdate();
        await until(() => polls === 1 && dom.window.localStorage.getItem(operationKey) === null, 'polling completes before the delayed POST receipt');
        assertStorageCleared();
        assert.ok(ui.container.textContent?.includes(messages.settings.updates.operation.status.succeeded));
        await act(async () => receipt!(json({ success: true, operation: operation(input!.requestId!, 'queued') }, 202)));
        assertStorageCleared();
        assert.ok(ui.container.textContent?.includes(messages.settings.updates.operation.status.succeeded), 'late queued receipt cannot undo terminal observation');
        await until(() => reloads === beforeReload + 1, 'late receipt preserves the one scheduled reload');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)); });
        assert.equal(reloads, beforeReload + 1, 'late receipt must not create a reload loop');
        assert.equal(polls, 1, 'late receipt must not restart operation polling');
        assertStorageCleared();
      } finally { await ui.close(); }
    }

    for (const status of [401, 403]) {
      dom.window.localStorage.clear();
      dom.window.sessionStorage.clear();
      const beforeReload = reloads;
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const retryTimers = new Set<ReturnType<typeof setTimeout>>();
      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        const timer = originalSetTimeout(...args);
        if (args[1] === 30_000) retryTimers.add(timer);
        return timer;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
        retryTimers.delete(timer as ReturnType<typeof setTimeout>);
        originalClearTimeout(timer);
      }) as typeof clearTimeout;
      let input: StartSystemUpdateInput | null = null;
      let posts = 0;
      let polls = 0;
      let authenticated = false;
      let finish = false;
      globalThis.fetch = async (request, options) => {
        const url = String(request);
        if (url.includes('?channel=')) return json({ success: true, data: availability });
        if (url === '/api/admin/system-updates' && options?.method === 'POST') {
          posts++;
          const next = JSON.parse(String(options.body)) as StartSystemUpdateInput;
          if (!input) input = next;
          assert.deepEqual(next, input, 'auth-loss retry reuses the complete original start request');
          assert.ok(next.requestId && uuidPattern.test(next.requestId));
          if (posts === 1) throw new Error('Original accepted receipt was lost');
          assert.equal(posts, 2, 'auth loss must not cause repeated start submissions');
          return json({ error: { message: `Start authentication failed ${status}` } }, status);
        }
        if (url.endsWith('/status-access')) return json({ success: true, access: null });
        if (url.includes('/events?')) {
          polls++;
          assert.ok(input?.requestId && url.includes(`/${input.requestId}/events?`));
          if (!authenticated) return json({ error: { code: 'operation_not_found', message: 'Accepted operation is not observable yet' } }, 404);
          return json({ success: true, operation: operation(input.requestId, finish ? 'succeeded' : 'verifying'), events: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      };
      let ui: Awaited<ReturnType<typeof mount>> | null = null;
      try {
        ui = await mount();
        await confirmUpdate();
        await until(() => Boolean(ui?.container.textContent?.includes('Original accepted receipt was lost')) && retryTimers.size === 1,
          'uncertain original start keeps one automatic retry timer');
        await act(async () => findButton(messages.settings.updates.retry)!.click());
        await until(() => Boolean(ui?.container.textContent?.includes(`Start authentication failed ${status}`)), 'auth rejection is visible');
        assert.equal(posts, 2);
        assert.equal(retryTimers.size, 0, 'auth rejection pauses the automatic start retry');
        assert.equal(dom.window.localStorage.getItem(operationKey), input!.requestId, 'auth rejection retains the uncertain operation UUID');
        assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(intentKey) || 'null'), input, 'auth rejection retains the original start intent');
        const pausedPolls = polls;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        assert.equal(posts, 2);
        assert.equal(polls, pausedPolls, 'auth rejection pauses operation polling');
        await ui.close();
        ui = null;
        authenticated = true;
        ui = await mount();
        await until(() => dom.window.localStorage.getItem(intentKey) === null, 'restored authentication recovers the original operation after remount');
        assert.equal(dom.window.localStorage.getItem(operationKey), input!.requestId);
        assert.equal(posts, 2, 'auth restoration observes the existing start instead of submitting another');
        assert.ok(!ui.container.textContent?.includes(`Start authentication failed ${status}`));
        finish = true;
        await until(() => dom.window.localStorage.getItem(operationKey) === null, 'same operation completes after authentication restoration');
        assertStorageCleared();
        await until(() => reloads === beforeReload + 1, 'auth-loss recovery reloads exactly once');
      } finally {
        if (ui) await ui.close();
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    }

    {
      dom.window.localStorage.clear();
      dom.window.sessionStorage.clear();
      const { idempotentStart: _capability, ...olderAvailability } = availability;
      let posts = 0;
      globalThis.fetch = async (request, options) => {
        const url = String(request);
        if (url.includes('?channel=')) return json({ success: true, data: olderAvailability });
        if (url === '/api/admin/system-updates' && options?.method === 'POST') {
          posts++;
          const input = JSON.parse(String(options.body)) as StartSystemUpdateInput;
          assert.deepEqual(input, { channel: 'stable', expectedReleaseId: availability.release!.releaseId }, 'older update services receive no unsupported request UUID');
          assert.equal(dom.window.localStorage.getItem(intentKey), null);
          assert.equal(dom.window.localStorage.getItem(operationKey), null, 'legacy operation ID is learned from its receipt');
          return json({ success: true, operation: operation(fixtureId, 'verifying') }, 202);
        }
        if (url.endsWith('/status-access')) return json({ success: true, access: null });
        if (url.includes('/events?')) return json({ success: true, operation: operation(fixtureId, 'verifying'), events: [] });
        throw new Error(`Unexpected request: ${url}`);
      };
      const ui = await mount();
      try {
        await confirmUpdate();
        await until(() => dom.window.localStorage.getItem(operationKey) === fixtureId, 'legacy service receipt still starts observation');
        assert.equal(posts, 1);
        assert.equal(dom.window.localStorage.getItem(intentKey), null);
      } finally { await ui.close(); }
    }
  } finally { globalThis.fetch = originalFetch; dom.window.close(); }
  console.log('system-update-start-recovery-ui-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
