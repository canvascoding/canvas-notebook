import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

interface RequestRecord {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

type FixtureCategory = 'agent-runtime' | 'media' | 'integrations' | 'other';
interface FixtureEntry {
  key: string;
  value: string;
  categories: FixtureCategory[];
  reserved: boolean;
}

async function main() {
  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const { UnifiedSecretsEditor } = await import('../app/components/settings/UnifiedSecretsEditor');
  const originalFetch = globalThis.fetch;
  const requests: RequestRecord[] = [];
  let currentRevision = 'revision-1';
  let currentEntries: FixtureEntry[] = [
    { key: 'BRAVE_API_KEY', value: 'fixture-brave-secret', categories: ['integrations'], reserved: false },
    { key: 'CANVAS_MCP_HASH_ENV_HASH', value: 'fixture-generated-mcp-secret', categories: ['integrations'], reserved: false },
    { key: 'GEMINI_API_KEY', value: 'fixture-gemini-secret', categories: ['media'], reserved: false },
    { key: 'SMTP_TEMPLATE', value: 'first line\nsecond line', categories: ['other'], reserved: false },
    { key: 'KEEP_ME', value: 'fixture-keep-value', categories: ['other'], reserved: false },
  ];
  let currentRaw = '# keep this comment\nBRAVE_API_KEY=fixture-brave-secret\nGEMINI_API_KEY=fixture-gemini-secret\nSMTP_TEMPLATE="first line\nsecond line"\nKEEP_ME=fixture-keep-value\n';
  let patchCount = 0;
  let nextPatchConflict = false;
  let pendingSystemGet: ((response: Response) => void) | null = null;
  let mayConfirmDiscard = true;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, method, body });
    if (method === 'GET') {
      if (url.includes('secretScope=system')) return new Promise<Response>(resolve => { pendingSystemGet = resolve; });
      return Response.json({ success: true, data: { entries: currentEntries, rawContent: currentRaw, revision: currentRevision, readable: true } });
    }
    if (method === 'PATCH') {
      if (nextPatchConflict) {
        nextPatchConflict = false;
        return Response.json({ success: false, code: 'SECRETS_REVISION_CONFLICT', error: 'stale revision' }, { status: 409 });
      }
      const patches = body?.patches as Array<{ key: string; value: string | null }>;
      for (const patch of patches) {
        currentEntries = patch.value === null
          ? currentEntries.filter(entry => entry.key !== patch.key)
          : [...currentEntries.filter(entry => entry.key !== patch.key), { key: patch.key, value: patch.value, categories: patch.key === 'GEMINI_API_KEY' ? ['media'] : ['other'], reserved: false }];
      }
      patchCount += 1;
      currentRevision = `revision-${patchCount + 1}`;
      return Response.json({ success: true, data: { entries: currentEntries, rawContent: currentRaw, revision: currentRevision, readable: true } });
    }
    assert.equal(method, 'PUT');
    assert.equal(body?.mode, 'raw');
    currentRaw = String(body?.rawContent);
    currentRevision = 'revision-3';
    return Response.json({ success: true, data: { entries: currentEntries, rawContent: currentRaw, revision: currentRevision, readable: true } });
  };
  dom.window.confirm = () => mayConfirmDiscard;

  try {
    const view = render(<UnifiedSecretsEditor language="en" isAdmin developerMode />);
    await waitFor(() => assert.equal(document.querySelectorAll('[data-testid="secret-entry"]').length, 5));
    const keyValue = document.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')!;
    assert.equal(keyValue.type, 'password', 'secret values are masked on initial load');
    assert.ok(Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="secret-entry-value"]')).every(input => input.type === 'password'), 'all values are masked, including innocuously named and generated credential keys');
    const generatedInput = Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="secret-entry-key"]')).find(input => input.value === 'CANVAS_MCP_HASH_ENV_HASH')!;
    assert.equal(generatedInput.parentElement?.parentElement?.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')?.type, 'password');
    const multilineKey = Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="secret-entry-key"]')).find(input => input.value === 'SMTP_TEMPLATE')!;
    const multilineRow = multilineKey.closest<HTMLElement>('[data-testid="secret-entry"]')!;
    const maskedMultiline = multilineRow.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')!;
    assert.equal(maskedMultiline.type, 'password');
    assert.equal(maskedMultiline.readOnly, true, 'multiline values remain read-only until explicitly revealed');
    fireEvent.click(Array.from(multilineRow.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Show value')!);
    assert.equal(multilineRow.querySelector<HTMLTextAreaElement>('[data-testid="secret-entry-value"]')?.value, 'first line\nsecond line', 'revealing a multiline value displays its exact newlines');
    fireEvent.click(Array.from(multilineRow.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Hide value')!);

    const category = document.querySelector<HTMLSelectElement>('[data-testid="secret-category"]')!;
    fireEvent.change(category, { target: { value: 'media' } });
    assert.equal(document.querySelectorAll('[data-testid="secret-entry"]').length, 1);
    const mediaValue = document.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')!;
    fireEvent.change(mediaValue, { target: { value: 'fixture-gemini-updated' } });
    fireEvent.change(category, { target: { value: 'all' } });
    assert.equal(document.querySelectorAll('[data-testid="secret-entry"]').length, 5);
    assert.equal(Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="secret-entry-value"]')).find(input => input.value === 'fixture-gemini-updated')?.value, 'fixture-gemini-updated', 'category changes retain edits');

    await act(async () => { fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="secret-save"]')!); });
    await waitFor(() => assert.ok(document.querySelector('[role="status"]')?.textContent?.includes('Changes saved')));
    const patchRequest = requests.find(request => request.method === 'PATCH')!;
    assert.equal(patchRequest.body?.baseRevision, 'revision-1');
    assert.deepEqual(patchRequest.body?.patches, [{ key: 'GEMINI_API_KEY', value: 'fixture-gemini-updated' }], 'only changed keys are sent in the targeted patch');
    assert.equal((patchRequest.body?.patches as Array<{ key: string }>).some(patch => patch.key === 'KEEP_ME'), false);

    const editorMode = document.querySelector<HTMLSelectElement>('[data-testid="secret-editor-mode"]')!;
    fireEvent.change(editorMode, { target: { value: 'raw' } });
    const raw = document.querySelector<HTMLTextAreaElement>('[data-testid="secret-raw-content"]')!;
    const rawWithFormatting = '# preserved comment\nGEMINI_API_KEY="line one\nline two"\nKEEP_ME=fixture-keep-value\n';
    fireEvent.change(raw, { target: { value: rawWithFormatting } });
    await act(async () => { fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="secret-save"]')!); });
    await waitFor(() => assert.ok(document.querySelector('[role="status"]')?.textContent?.includes('Changes saved')));
    const rawRequest = requests.find(request => request.method === 'PUT')!;
    assert.equal(rawRequest.body?.scope, 'all');
    assert.equal(rawRequest.body?.secretScope, 'user');
    assert.equal(rawRequest.body?.baseRevision, 'revision-2');
    assert.equal(rawRequest.body?.rawContent, rawWithFormatting, 'raw edits retain literal quotes and multiline text');

    fireEvent.change(editorMode, { target: { value: 'keys' } });
    const multilineRowAfterRaw = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="secret-entry"]')).find(row => row.querySelector<HTMLInputElement>('[data-testid="secret-entry-key"]')?.value === 'SMTP_TEMPLATE')!;
    fireEvent.click(Array.from(multilineRowAfterRaw.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Show value')!);
    const multilineTextarea = multilineRowAfterRaw.querySelector<HTMLTextAreaElement>('[data-testid="secret-entry-value"]')!;
    assert.equal(multilineTextarea.value, 'first line\nsecond line');
    fireEvent.change(multilineTextarea, { target: { value: 'first line\nsecond line updated\nthird line' } });
    await act(async () => { fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="secret-save"]')!); });
    await waitFor(() => assert.ok(document.querySelector('[role="status"]')?.textContent?.includes('Changes saved')));
    const multilinePatch = requests.filter(request => request.method === 'PATCH')[1]!;
    assert.equal(multilinePatch.body?.baseRevision, 'revision-3');
    assert.deepEqual(multilinePatch.body?.patches, [{ key: 'SMTP_TEMPLATE', value: 'first line\nsecond line updated\nthird line' }], 'revealed multiline edits are sent without newline loss');

    fireEvent.change(document.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')!, { target: { value: 'fixture-conflicting-edit' } });
    nextPatchConflict = true;
    await act(async () => { fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="secret-save"]')!); });
    await waitFor(() => assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes('changed since you loaded')));
    assert.equal(document.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')?.value, 'fixture-conflicting-edit', 'a stale response keeps the unsaved edit visible');
    const reloadConflict = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Reload latest version'))!;
    await act(async () => { fireEvent.click(reloadConflict); });
    await waitFor(() => assert.equal(document.querySelector('[role="alert"]'), null));

    fireEvent.change(document.querySelector<HTMLSelectElement>('[data-testid="secret-scope"]')!, { target: { value: 'system' } });
    await waitFor(() => assert.ok(document.querySelector('[role="status"]')?.textContent?.includes('Loading environment')));
    assert.equal(document.querySelectorAll('[data-testid="secret-entry"]').length, 0, 'rows from the previous owner are cleared while a new scope loads');
    await act(async () => pendingSystemGet!(Response.json({
      success: true,
      data: { entries: [{ key: 'SYSTEM_ONLY', value: 'fixture-system-only', categories: ['other'], reserved: false }], rawContent: 'SYSTEM_ONLY=fixture-system-only\n', revision: 'system-revision', readable: true },
    })));
    await waitFor(() => assert.equal(document.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')?.value, 'fixture-system-only'));

    fireEvent.change(document.querySelector<HTMLSelectElement>('[data-testid="secret-scope"]')!, { target: { value: 'user' } });
    await waitFor(() => assert.equal(document.querySelectorAll('[data-testid="secret-entry"]').length, 5));
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')!, { target: { value: 'unsaved-fixture-value' } });
    view.rerender(<UnifiedSecretsEditor language="de" isAdmin developerMode />);
    assert.equal(document.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')?.value, 'unsaved-fixture-value', 'changing the language preserves unsaved edits');
    mayConfirmDiscard = false;
    fireEvent.change(document.querySelector<HTMLSelectElement>('[data-testid="secret-scope"]')!, { target: { value: 'system' } });
    assert.equal(document.querySelector<HTMLSelectElement>('[data-testid="secret-scope"]')!.value, 'user', 'canceling a dirty scope change keeps the current owner selected');
    assert.equal(document.querySelectorAll('[data-testid="secret-entry"]')[0]?.querySelector<HTMLInputElement>('[data-testid="secret-entry-value"]')?.value, 'unsaved-fixture-value');

    cleanup();
    const requestsBeforeNonAdmin = requests.length;
    render(<UnifiedSecretsEditor language="en" isAdmin={false} />);
    await waitFor(() => assert.equal(document.querySelectorAll('[data-testid="secret-entry"]').length, 5));
    const nonAdminScope = document.querySelector<HTMLSelectElement>('[data-testid="secret-scope"]')!;
    assert.deepEqual(Array.from(nonAdminScope.options).map(option => option.value), ['user'], 'non-admins only receive the personal scope option');
    fireEvent.change(nonAdminScope, { target: { value: 'system' } });
    assert.equal(nonAdminScope.value, 'user');
    assert.equal(requests.length, requestsBeforeNonAdmin + 1, 'a non-admin cannot trigger an organization or system request');
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="secret-add-entry"]')!);
    const values = document.querySelectorAll<HTMLInputElement>('[data-testid="secret-entry-value"]');
    fireEvent.change(values[values.length - 1]!, { target: { value: 'fixture-without-name' } });
    const requestsBeforeInvalidSave = requests.length;
    await act(async () => { fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="secret-save"]')!); });
    await waitFor(() => assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes('valid environment variable name')));
    assert.equal(requests.length, requestsBeforeInvalidSave, 'a value without a key is rejected locally and never sent');
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
