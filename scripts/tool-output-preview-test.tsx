import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://notebook.example.test/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, cleanup, fireEvent } = await import('@testing-library/react');
  const { StoredToolOutputPreview } = await import('../app/components/canvas-agent-chat/StoredToolOutputPreview');
  const originalFetch = globalThis.fetch;
  const reference = `tool-output://call-${'a'.repeat(64)}/output-${'b'.repeat(32)}.txt`;
  const details = { toolOutput: { version: 1, policyVersion: 'tool-output-v1', sourceCount: 3, shownCount: 2,
    references: [{ reference, complete: true }] } };
  try {
    for (const [locale, messages] of [['en', en], ['de', de]] as const) {
      const labels = messages.chat.storedOutput;
      const requests: URL[] = [];
      let fail = false;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input), 'https://notebook.example.test'); requests.push(url);
        if (fail) return Response.json({}, { status: 404 });
        const start = Number(url.searchParams.get('offset'));
        return Response.json({ content: `<script>unsafe()</script> excerpt-${start}`, offset: start, nextOffset: start + 6000, totalChars: 25000, eof: start >= 19000 });
      };
      const wrap = (sessionId = 'session') => <NextIntlClientProvider locale={locale} timeZone="Europe/Berlin" messages={messages}>
        <StoredToolOutputPreview details={details} scope={{ sessionId, agentId: 'agent', workspaceId: 'workspace' }} />
      </NextIntlClientProvider>;
      const screen = render(wrap());
      assert.equal(requests.length, 0, 'mounting must not fetch');
      assert.ok(screen.getByText(labels.available));
      const click = async (name: string) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
      await click(labels.open.replace('{number}', '1'));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].searchParams.get('reference'), reference);
      assert.equal(requests[0].searchParams.get('workspaceId'), 'workspace');
      assert.match(screen.getByTestId('stored-tool-output-content').textContent!, /excerpt-0/);
      assert.equal(document.querySelector('script'), null, 'stored text is escaped, not executed');
      await click(labels.next);
      assert.equal(requests.at(-1)!.searchParams.get('offset'), '6000');
      assert.doesNotMatch(screen.getByTestId('stored-tool-output-content').textContent!, /excerpt-0/);
      await click(labels.previous);
      assert.equal(requests.at(-1)!.searchParams.get('offset'), '0');
      await act(async () => { fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '19000' } }); });
      await click(labels.jump);
      assert.equal(requests.at(-1)!.searchParams.get('offset'), '19000');
      assert.equal((screen.getByRole('button', { name: labels.next }) as HTMLButtonElement).disabled, true);
      fail = true;
      await click(labels.previous);
      assert.ok(screen.getByRole('alert'));
      fail = false;
      await click(labels.retry);
      assert.equal(requests.at(-1)!.searchParams.get('offset'), '13000');
      screen.rerender(wrap('another-session'));
      assert.equal(screen.queryByTestId('stored-tool-output-content'), null, 'session changes clear the prior content');
      cleanup();
      const failed = render(<NextIntlClientProvider locale={locale} timeZone="Europe/Berlin" messages={messages}>
        <StoredToolOutputPreview details={{ toolOutput: { ...details.toolOutput, storageError: 'quota exceeded' } }} />
      </NextIntlClientProvider>);
      assert.ok(failed.getByText(labels.storageFailed));
      assert.ok(failed.getByText(labels.partial));
      assert.ok(failed.getByText(labels.scopeMissing));
      assert.equal((failed.getByRole('button') as HTMLButtonElement).disabled, true);
      cleanup();
    }
    console.log('tool-output-preview-test: ok (en/de, on-demand, pagination, offsets, errors, escaped text, session switch; no browser)');
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
