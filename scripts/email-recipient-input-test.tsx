import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, useState } from 'react';
import { JSDOM } from 'jsdom';
import messages from '../messages/en.json';
import type { EmailRecipientCandidate, EmailRecipientDiscoveryResult } from '../app/lib/email/recipient-discovery-types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'CustomEvent', 'Event', 'FocusEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const internals = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'next-intl') return { useLocale: () => 'en', useTranslations: () => (key: string, values: Record<string, string> = {}) => {
    const text = key.split('.').reduce((value: unknown, part) => (value as Record<string, unknown>)[part], messages.EmailRecipients) as string;
    return text.replace(/\{(\w+)\}/gu, (_, name) => values[name] || '');
  } };
  return originalLoad(request, parent, isMain);
};

function candidate(index = 0): EmailRecipientCandidate {
  return { address: `anna${index || ''}@example.test`, name: `Anna ${index + 1}`, reason: 'name_match',
    source: { messageId: `source-${index}`, folder: 'Sent', role: 'to', date: '2024-03-04T12:00:00Z' } };
}
function result(candidates = [candidate()]): EmailRecipientDiscoveryResult {
  return { status: 'ambiguous', candidates, candidateCount: candidates.length, omittedCount: 0, coverage: { hasMore: false, nextOffset: null, incomplete: false } };
}
function response(data: unknown) { return Response.json({ success: true, data }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

async function main() {
  const { render, fireEvent, cleanup } = await import('@testing-library/react');
  const { EmailRecipientInput } = await import('../app/apps/email/components/EmailRecipientInput');
  const { EmailReplyRecipientSuggestions } = await import('../app/apps/email/components/EmailReplyRecipientSuggestions');
  const { splitRecipientInput } = await import('../app/apps/email/components/email-compose-utils');
  const calls: Array<{ body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  let handleRequest: () => Promise<Response> = async () => response(result());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/email/recipients');
    assert.equal(init?.cache, 'no-store');
    calls.push({ body: JSON.parse(String(init?.body)), signal: init?.signal }); return handleRequest();
  };
  type Props = { accountId?: string; mailboxWorkspaceId?: string | null; disabled?: boolean; instanceKey?: string; exclude?: string[]; initialValue?: string };
  function InputHarness({ initialValue = 'existing@example.test', instanceKey = 'draft-a', ...props }: Props) {
    const [value, setValue] = useState(initialValue);
    return <><label htmlFor="recipient">To</label><EmailRecipientInput key={instanceKey} id="recipient" testId="recipient" value={value} onChange={setValue} {...props} />
      <button type="button">Send</button><div data-testid="value">{value}</div></>;
  }
  const base = { accountId: 'same-account', mailboxWorkspaceId: 'workspace-a' };
  const pause = async () => { await act(async () => { await new Promise(done => setTimeout(done, 440)); }); };
  const type = (view: ReturnType<typeof render>, text: string) => {
    const input = view.getByRole('combobox') as HTMLInputElement;
    act(() => { input.focus(); fireEvent.change(input, { target: { value: text } }); }); return input;
  };
  try {
    assert.deepEqual(splitRecipientInput('"Doe, Jane" <Jane@Example.Test>, other@example.test (Other, Team); Invalid Name'), ['jane@example.test', 'other@example.test', 'Invalid Name']);

    // Opening, focusing, short names and complete manual addresses perform no lookup.
    let view = render(<InputHarness {...base} />);
    type(view, 'A'); await pause(); assert.equal(calls.length, 0);
    type(view, 'manual@example.test'); await pause(); assert.equal(calls.length, 0);
    act(() => { view.getByRole('button', { name: 'Send' }).focus(); });
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, manual@example.test');
    type(view, 'x'.repeat(121)); await pause(); assert.equal(calls.length, 0);
    cleanup();

    // Pasted formatted recipients are split structurally and deduplicated.
    view = render(<InputHarness {...base} />);
    type(view, '"Doe, Jane" <Jane@Example.Test>, other@example.test (Other, Team); existing@example.test');
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, jane@example.test, other@example.test');
    assert.equal((view.getByRole('combobox') as HTMLInputElement).value, '');
    fireEvent.click(view.getByRole('button', { name: 'Remove jane@example.test' }));
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, other@example.test');
    cleanup();

    // Invalid address text is retained rather than silently choosing one embedded address.
    for (const raw of ['Name <one@example.test> <two@example.test>', 'one@example.test two@example.test']) {
      for (const action of ['blur', 'enter']) {
        view = render(<InputHarness {...base} />); type(view, raw);
        if (action === 'blur') act(() => { view.getByRole('button', { name: 'Send' }).focus(); });
        else fireEvent.keyDown(view.getByRole('combobox'), { key: 'Enter' });
        assert.equal(view.getByTestId('value').textContent, `existing@example.test, ${raw}`, `${action} preserves all invalid recipient intent`);
        assert.ok(view.getByRole('alert').textContent?.includes('complete email address'));
        cleanup();
      }
    }

    // Delimiters inside a manually typed display name or comment remain literal text.
    view = render(<InputHarness {...base} />);
    type(view, '"Doe');
    assert.equal(fireEvent.keyDown(view.getByRole('combobox'), { key: ',', cancelable: true }), true);
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test');
    type(view, '"Doe, Anna" <anna@example.test>');
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, anna@example.test');
    type(view, 'support@example.test (Support');
    assert.equal(fireEvent.keyDown(view.getByRole('combobox'), { key: ';', cancelable: true }), true);
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, anna@example.test');
    type(view, 'support@example.test (Support; Team)');
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, anna@example.test, support@example.test');
    cleanup();

    // Suggestions are capped, carry truthful sources, and require explicit selection.
    calls.length = 0;
    handleRequest = async () => response({ ...result(Array.from({ length: 6 }, (_, i) => candidate(i))), omittedCount: 1 });
    view = render(<InputHarness {...base} exclude={['other-field@example.test']} />);
    type(view, 'An'); type(view, 'Anna'); await pause();
    assert.equal(calls.length, 1, 'typing is debounced');
    assert.deepEqual(calls[0].body, { mode: 'find', ...base, query: 'Anna', exclude: ['existing@example.test', 'other-field@example.test'] });
    assert.equal(view.getAllByRole('option').length, 5);
    assert.ok(view.getAllByText(/Observed To recipient/u).length);
    assert.ok(view.getAllByText(/Source dated/u).length);
    assert.equal(view.container.querySelector('details')?.open, false, 'long source references start collapsed');
    const option = view.getAllByRole('option')[0];
    fireEvent.mouseDown(option); fireEvent.click(option);
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, anna@example.test', 'selection replaces the pending name without committing an invalid chip');
    assert.equal(view.queryByText('Anna'), null);
    cleanup();

    // Arrow + Tab/Enter selection and Escape preserve direct-address entry.
    calls.length = 0; handleRequest = async () => response(result());
    view = render(<InputHarness {...base} />);
    type(view, 'Anna'); await pause();
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'Tab' });
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, anna@example.test');
    handleRequest = async () => response(result([candidate(1)]));
    type(view, 'Anna'); await pause();
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'Enter' });
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, anna@example.test, anna1@example.test');
    type(view, 'manual@example.test'); fireEvent.keyDown(view.getByRole('combobox'), { key: 'Escape' });
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'Enter' });
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, anna@example.test, anna1@example.test, manual@example.test');
    cleanup();

    // Source-detail navigation stays within the picker; exiting preserves unresolved intent.
    handleRequest = async () => response(result()); view = render(<InputHarness {...base} />);
    type(view, 'Anna'); await pause();
    act(() => { (view.container.querySelector('summary') as HTMLElement).focus(); });
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test');
    act(() => { view.getByRole('button', { name: 'Send' }).focus(); });
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test, Anna', 'an unresolved pending recipient is not silently dropped when Send receives focus');
    assert.ok(view.getByRole('alert').textContent?.includes('complete email address'));
    cleanup();

    // A lookup error preserves current recipients and still exposes a valid listbox ID.
    handleRequest = async () => { throw new Error('provider unavailable'); };
    view = render(<InputHarness {...base} />); type(view, 'Anna'); await pause();
    assert.ok(view.getByText('Address lookup is unavailable. You can enter an address directly.'));
    assert.equal(view.getByTestId('value').textContent, 'existing@example.test');
    const controls = view.getByRole('combobox').getAttribute('aria-controls');
    assert.equal(document.getElementById(controls!)?.getAttribute('role'), 'listbox');
    cleanup();

    // Even a provider that ignores Abort cannot carry matches into another mailbox or draft.
    for (const changed of [{ ...base, mailboxWorkspaceId: 'workspace-b', instanceKey: 'draft-b' }, { ...base, instanceKey: 'draft-b' }]) {
      calls.length = 0; const old = deferred<Response>(); handleRequest = () => old.promise;
      view = render(<InputHarness {...base} instanceKey="draft-a" />); type(view, 'Anna'); await pause();
      const oldSignal = calls[0].signal;
      assert.ok(view.getByRole('status').textContent?.includes('Looking up'));
      assert.equal(document.getElementById(view.getByRole('combobox').getAttribute('aria-controls')!)?.getAttribute('role'), 'listbox');
      view.rerender(<InputHarness {...changed} />); assert.equal(oldSignal?.aborted, true);
      handleRequest = async () => response(result([{ ...candidate(), name: 'Berta', address: 'berta@example.test' }]));
      type(view, 'Berta'); await pause();
      await act(async () => { old.resolve(response(result())); await old.promise; });
      assert.equal(view.queryByRole('option', { name: /anna@example/u }), null);
      assert.ok(view.getByRole('option', { name: /berta@example/u }));
      cleanup();
    }

    // Disabled/exclusion changes invalidate requests, including late errors.
    calls.length = 0; const oldError = deferred<Response>(); handleRequest = () => oldError.promise;
    view = render(<InputHarness {...base} />); type(view, 'Anna'); await pause();
    view.rerender(<InputHarness {...base} disabled />);
    assert.equal(calls[0].signal?.aborted, true);
    await act(async () => { oldError.reject(new Error('late failure')); await oldError.promise.catch(() => {}); });
    assert.equal(view.queryByRole('status'), null); assert.equal(view.queryByRole('option'), null);
    cleanup();
    calls.length = 0; const oldMatch = deferred<Response>(); handleRequest = () => oldMatch.promise;
    view = render(<InputHarness {...base} />); type(view, 'Anna'); await pause();
    view.rerender(<InputHarness {...base} exclude={['anna@example.test']} />);
    handleRequest = async () => response(result()); await pause();
    await act(async () => { oldMatch.resolve(response(result())); await oldMatch.promise; });
    assert.equal(calls[0].signal?.aborted, true); assert.equal(view.queryByRole('option'), null, 'current exclusions also filter returned candidates locally');
    cleanup();

    // The HTTP exclusion cap never weakens the local cross-field duplicate guard.
    calls.length = 0; handleRequest = async () => response(result());
    view = render(<InputHarness {...base} exclude={[...Array.from({ length: 120 }, (_, i) => `other${i}@example.test`), 'anna@example.test']} />);
    type(view, 'Anna'); await pause();
    assert.equal((calls[0].body.exclude as string[]).length, 50);
    assert.equal(view.queryByRole('option'), null, 'all selected recipients stay excluded locally beyond provider lookup bounds');
    cleanup();

    // Incomplete coverage never claims that no matching recipient exists in the mailbox.
    handleRequest = async () => response({ ...result([]), status: 'incomplete', coverage: { hasMore: false, nextOffset: null, incomplete: true } });
    view = render(<InputHarness {...base} />); type(view, 'Anna'); await pause();
    assert.ok(view.getByText('Only part of this mailbox was checked. Select a suggestion or refine the name.'));
    assert.equal(view.queryByText(/No address found/u), null); cleanup();

    // Optional reply participants load only on request and are added only by user action.
    calls.length = 0; const additions: Array<{ address: string; field: string }> = [];
    handleRequest = async () => response({ basis: 'current_message', replyRecipients: { to: [], cc: [] }, optionalAdditionalRecipients: [candidate()], omittedCount: 0 });
    function ReplyHarness({ messageId = 'message-a', disabled = false }: { messageId?: string; disabled?: boolean }) {
      const [exclude, setExclude] = useState(['sender@example.test']);
      return <EmailReplyRecipientSuggestions {...base} messageId={messageId} folder="INBOX" exclude={exclude} disabled={disabled}
        onAdd={(address, field) => { additions.push({ address, field }); setExclude([...exclude, address]); }} />;
    }
    view = render(<ReplyHarness />); assert.equal(calls.length, 0);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'More participants' })); });
    assert.deepEqual(calls[0].body, { mode: 'reply', ...base, messageId: 'message-a', folder: 'INBOX', replyMode: 'reply', exclude: ['sender@example.test'] });
    assert.equal(additions.length, 0);
    fireEvent.click(view.getByRole('button', { name: 'Add anna@example.test to Cc' }));
    assert.deepEqual(additions, [{ address: 'anna@example.test', field: 'cc' }]);
    assert.ok(view.getByText('No additional participants in the original message.')); assert.equal(calls.length, 1);
    view.rerender(<ReplyHarness disabled />); assert.equal(view.queryByText('No additional participants in the original message.'), null);
    cleanup();
    calls.length = 0; const staleReply = deferred<Response>(); handleRequest = () => staleReply.promise;
    view = render(<ReplyHarness />); act(() => { fireEvent.click(view.getByRole('button', { name: 'More participants' })); });
    view.rerender(<ReplyHarness messageId="message-b" />); assert.equal(calls[0].signal?.aborted, true);
    await act(async () => { staleReply.resolve(response({ basis: 'current_message', replyRecipients: { to: [], cc: [] }, optionalAdditionalRecipients: [candidate()], omittedCount: 0 })); await staleReply.promise; });
    assert.equal(view.queryByText('anna@example.test'), null); assert.equal(calls.length, 1);
    console.log('Recipient UI: progressive lookup, formatted paste, sources, explicit mouse/keyboard/add choices, pending intent, scope/draft/exclusion/disabled races and optional replies passed.');
  } finally { cleanup(); globalThis.fetch = originalFetch; internals._load = originalLoad; dom.window.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
