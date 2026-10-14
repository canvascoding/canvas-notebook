import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: class { observe() {} disconnect() {} },
});

const deadlines = new Map<number, () => void>();
const originalSetTimeout = window.setTimeout.bind(window);
const originalClearTimeout = window.clearTimeout.bind(window);
let timerId = 0;
window.setTimeout = (handler, delay, ...args) => {
  if (delay !== 60_000) return originalSetTimeout(handler, delay, ...args);
  assert.equal(typeof handler, 'function');
  const id = --timerId;
  deadlines.set(id, () => (handler as (...values: unknown[]) => void)(...args));
  return id;
};
window.clearTimeout = (id) => {
  if (typeof id === 'number' && deadlines.delete(id)) return;
  originalClearTimeout(id);
};

const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
globalThis.fetch = async (input, init) => {
  if (String(input) === '/api/agents/browser') {
    return Response.json({ success: true, data: { capability: { browserExportsAvailable: true } } });
  }
  assert.match(String(input), /^\/api\/files\/markdown-export\?/u);
  assert.ok(init?.signal);
  const signal = init.signal;
  return new Promise<Response>((resolve, reject) => {
    requests.push({ signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};

async function main() {
  const { ShareMarkdownDialog } = await import('../app/components/file-browser/ShareMarkdownDialog');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (open: boolean, filePath = 'chart.md') => {
    await act(async () => root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <ShareMarkdownDialog embedded open={open} onOpenChange={() => {}} filePath={filePath} fileName={filePath} workspaceId="owned-test" />
      </NextIntlClientProvider>,
    ));
  };

  try {
    await render(true);
    assert.match(host.textContent ?? '', /Loading preview/u);
    assert.equal(deadlines.size, 1);
    await act(async () => { [...deadlines.values()][0](); });
    assert.equal(requests[0].signal.aborted, true, 'the stalled fetch must be cancelled');
    assert.match(host.textContent ?? '', /did not respond within 60 seconds/u);
    assert.doesNotMatch(host.textContent ?? '', /Loading preview/u);
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Try again');
    assert.ok(retry, 'timeout must expose the existing retry action');
    await act(async () => { retry.click(); });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].signal.aborted, false, 'retry must get a fresh signal');
    await act(async () => { requests[1].resolve(new Response('<!doctype html><html><body>Chart preview</body></html>')); });
    assert.match(host.textContent ?? '', /Preview ready/u);
    assert.doesNotMatch(host.textContent ?? '', /did not respond/u);
    assert.equal(deadlines.size, 0, 'successful requests must release the deadline timer');

    await render(true, 'another-chart.md');
    assert.equal(requests.length, 3);
    await render(false, 'another-chart.md');
    assert.equal(requests[2].signal.aborted, true, 'closing must still cancel the request');
    assert.doesNotMatch(host.textContent ?? '', /did not respond/u, 'closing is not a timeout error');
    assert.equal(deadlines.size, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
  console.log('markdown-export-preview-timeout-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
