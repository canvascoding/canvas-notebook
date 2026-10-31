import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { ApiIntegrationMetadata, ApiKeyMetadata } from '../app/lib/api-keys/contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://notebook.example.test/en/settings?tab=api-access', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement',
  'Element', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle', 'DocumentFragment'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

async function main() {
  const oldFetch = globalThis.fetch;
  const { render, cleanup, screen, fireEvent, waitFor } = await import('@testing-library/react');
  const { ApiAccessSettingsPanel } = await import('../app/components/settings/ApiAccessSettingsPanel');
  const records: ApiIntegrationMetadata[] = [], credentials = new Map<string, ApiKeyMetadata[]>();
  const requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let failure: 'none' | 'lost' | 'notSent' | 'malformed' | 'conflict' = 'none', currentSecret = '', copied = '';
  let responseGate: Promise<void> | undefined, releaseResponse: (() => void) | undefined;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  const ok = (data: unknown) => Response.json({ success: true, data });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.href), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/workspaces') return Response.json({ success: true, workspaces: [{ id: 'personal', name: 'Personal workspace',
      type: 'personal', status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true } }] });
    const id = url.pathname.split('/')[4], integration = records.find(row => row.id === id);
    if (method === 'GET' && url.pathname === '/api/api-access/integrations') return ok({ integrations: records.filter(row =>
      !url.searchParams.has('creationRequestId') || row.creationRequestId === url.searchParams.get('creationRequestId')), nextCursor: null });
    if (method === 'GET' && integration && url.pathname.endsWith('/credentials')) return ok({ integration,
      credentials: (credentials.get(id) ?? []).filter(row => !url.searchParams.has('issuanceRequestId') || row.issuanceRequestId === url.searchParams.get('issuanceRequestId')), nextCursor: null });
    if (method === 'POST') {
      if (failure === 'notSent') throw new Error('Controlled failure before submission');
      const credentialId = randomUUID(), now = Date.now();
      const credential: ApiKeyMetadata = { id: credentialId, prefix: `cnk_${credentialId}`, issuanceRequestId: String(body!.requestId),
        expiresAt: Number(body!.expiresAt), createdAt: now, revokedAt: null, lastUsedAt: null };
      currentSecret = `${credential.prefix}.${randomBytes(32).toString('base64url')}`;
      let target = integration;
      if (!target) {
        target = { id: randomUUID(), name: String(body!.name), workspaceIds: body!.workspaceIds as string[], actions: body!.actions as ApiIntegrationMetadata['actions'],
          creationRequestId: String(body!.requestId), revision: 1, createdAt: now, updatedAt: now, latestCredential: credential };
        records.push(target); credentials.set(target.id, []);
      } else { for (const old of credentials.get(id) ?? []) if (old.revokedAt == null) old.revokedAt = now; target.revision += 1; target.latestCredential = credential; }
      credentials.get(target.id)!.push(credential);
      await responseGate;
      if (failure === 'lost') throw new Error('Controlled lost issuance response');
      if (failure === 'malformed') return Response.json({ success: true });
      return ok({ integration: structuredClone(target), credential: structuredClone(credential), key: currentSecret });
    }
    if (method === 'PATCH' && integration) {
      if (failure === 'conflict') { integration.revision += 1; integration.name = 'Changed elsewhere';
        return Response.json({ success: false, code: 'API_INTEGRATION_CHANGED' }, { status: 409 }); }
      Object.assign(integration, { name: body!.name, workspaceIds: body!.workspaceIds, actions: body!.actions, revision: integration.revision + 1 });
      return ok({ integration: structuredClone(integration) });
    }
    if (method === 'DELETE' && integration) {
      const key = credentials.get(id)!.find(row => row.id === body!.credentialId); assert(key); key.revokedAt = Date.now(); integration.revision += 1;
      return ok({ integration: structuredClone(integration) });
    }
    throw new Error(`Unexpected UI test endpoint: ${method} ${url.pathname}`);
  };
  const App = ({ active = true, locale = 'en' }: { active?: boolean; locale?: 'en' | 'de' }) =>
    <NextIntlClientProvider locale={locale} messages={locale === 'de' ? de : en} timeZone="UTC"><ApiAccessSettingsPanel active={active} /></NextIntlClientProvider>;
  const ready = async (label = 'Create key') => waitFor(() => assert.equal((screen.getByRole('button', { name: label, exact: true }) as HTMLButtonElement).disabled, false));
  const fillCreate = async (name: string) => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'Create key', exact: true }));
    fireEvent.change(screen.getByLabelText('Application name'), { target: { value: name } });
    fireEvent.click(screen.getByLabelText('Personal workspace'));
    const form = document.querySelector('form'); assert(form); fireEvent.submit(form);
  };
  const reset = () => { cleanup(); releaseResponse?.(); releaseResponse = undefined; responseGate = undefined;
    records.length = 0; credentials.clear(); requests.length = 0; failure = 'none'; currentSecret = ''; copied = ''; };
  try {
    render(<App />); await ready();
    assert(screen.getByText('No programmatic access yet'));
    await fillCreate('Python client');
    await waitFor(() => assert(screen.getByText('Your new API key')));
    const oneTime = screen.getByLabelText('API key') as HTMLInputElement;
    assert(oneTime.value === currentSecret); assert.equal(oneTime.type, 'password');
    assert.deepEqual(records[0].actions, ['read']);
    assert.deepEqual(records[0].workspaceIds, ['personal']);
    assert.equal(window.localStorage.length, 0); assert(!window.location.href.includes(currentSecret));
    fireEvent.click(screen.getByRole('button', { name: 'Copy key', exact: true }));
    await waitFor(() => assert(copied === currentSecret));
    fireEvent.click(screen.getAllByRole('button', { name: 'Close', exact: true })[0]);
    await waitFor(() => assert.equal(document.getElementById('api-access-issued'), null));
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'Reload', exact: true })); await ready();
    assert.equal(document.getElementById('api-access-issued'), null, 'Reload must never redisplay an old secret.');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key', exact: true }));
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => assert(screen.getByText('Your new API key')));
    assert.equal(records.length, 1); assert.equal(credentials.get(records[0].id)!.length, 2);
    assert(credentials.get(records[0].id)![0].revokedAt != null);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close', exact: true })[0]); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke', exact: true }));
    await waitFor(() => assert(credentials.get(records[0].id)!.every(row => row.revokedAt != null)));
    await ready(); failure = 'conflict';
    fireEvent.click(screen.getByRole('button', { name: 'Edit access' }));
    fireEvent.change(screen.getByLabelText('Application name'), { target: { value: 'Stale change' } });
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => assert(screen.getByRole('alert').textContent!.includes('This integration has changed')));
    assert.equal(requests.filter(row => row.method === 'PATCH').length, 1, 'A stale edit must not be retried automatically.');
    failure = 'none'; fireEvent.click(screen.getByRole('button', { name: 'Reload', exact: true }));
    await ready(); assert(screen.getByRole('heading', { name: 'Changed elsewhere' }));

    for (const lostKind of ['lost', 'malformed'] as const) {
      reset(); render(<App />); failure = lostKind;
      await fillCreate('Unknown response');
      await waitFor(() => assert(screen.getByRole('heading', { name: 'Issuance not yet confirmed' })));
      assert.equal((screen.getByRole('button', { name: 'Create key', exact: true }) as HTMLButtonElement).disabled, true);
      assert.equal(requests.filter(row => row.method === 'POST').length, 1, 'The UI must not retry an ambiguous issuance.');
      assert.equal(document.getElementById('api-access-issued'), null);
      failure = 'none'; fireEvent.click(screen.getByRole('button', { name: 'Inspect metadata' }));
      await waitFor(() => assert(screen.getByRole('button', { name: 'Revoke unknown key' })));
      assert(!document.body.textContent!.includes(currentSecret));
      fireEvent.click(screen.getByRole('button', { name: 'Edit access' }));
      fireEvent.change(screen.getByLabelText('Application name'), { target: { value: 'Recovery client' } });
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => assert(screen.getByRole('heading', { name: 'Recovery client' })));
      assert(screen.getByRole('heading', { name: 'Issuance not yet confirmed' }), 'An unrelated successful edit cannot clear the unresolved issuance.');
      fireEvent.click(screen.getByRole('button', { name: 'Inspect metadata' }));
      await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Revoke unknown key' }) as HTMLButtonElement).disabled, false));
      fireEvent.click(screen.getByRole('button', { name: 'Revoke unknown key' }));
      await ready(); assert(credentials.get(records[0].id)!.every(row => row.revokedAt != null));
      assert.equal(requests.filter(row => row.method === 'POST').length, 1);
    }

    reset(); render(<App />); failure = 'notSent';
    await fillCreate('Not submitted');
    await waitFor(() => assert(screen.getByRole('button', { name: 'Inspect metadata' })));
    failure = 'none'; fireEvent.click(screen.getByRole('button', { name: 'Inspect metadata' }));
    await waitFor(() => assert(screen.getByRole('button', { name: 'Resend the same request' })));
    assert.equal(records.length, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Resend the same request' }));
    await waitFor(() => assert(screen.getByText('Your new API key')));
    const attempts = requests.filter(row => row.method === 'POST');
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].body, attempts[1].body);
    assert.equal(records.length, 1);

    reset(); const app = render(<App />); await ready();
    responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    await fillCreate('Hidden panel');
    await waitFor(() => assert.equal(records.length, 1));
    app.rerender(<App active={false} />);
    await act(async () => { releaseResponse!(); });
    app.rerender(<App active />);
    await waitFor(() => assert(screen.getByRole('heading', { name: 'Issuance not yet confirmed' })));
    assert.equal(document.getElementById('api-access-issued'), null, 'A delayed response must not reveal a secret after the panel was hidden.');
    assert(!document.body.textContent!.includes(currentSecret));

    reset(); render(<App locale="de" />); await ready('Schlüssel erstellen');
    assert(screen.getByText('Noch kein programmatischer Zugriff'));
    console.log('API-key management UI passed: explicit read-only grants, one-time masked key/copy, rotation/revocation, lost and malformed acknowledgements, targeted metadata recovery, hidden-panel race and German copy.');
  } finally { cleanup(); releaseResponse?.(); globalThis.fetch = oldFetch; dom.window.close(); }
}

main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0]
    .replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-test-key]') : 'Unknown failure';
  console.error('API-key management UI test failed:', message); process.exitCode = 1;
});
