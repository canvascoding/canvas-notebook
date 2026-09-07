import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, createRef } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { getProviderHelp, getApiKeyProviders } from '../app/lib/pi/provider-help';
import type { ProviderEnvEditorHandle } from '../app/components/settings/ProviderEnvEditor';
import type { CredentialEditableProviderInstallation } from '../app/components/settings/ProviderInstallationCredentialEditor';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, fireEvent, cleanup } = await import('@testing-library/react');
  const { ProviderEnvEditor } = await import('../app/components/settings/ProviderEnvEditor');
  const { ProviderInstallationCredentialEditor } = await import('../app/components/settings/ProviderInstallationCredentialEditor');
  const originalFetch = globalThis.fetch;
  type Pending = { url: URL; signal?: AbortSignal | null; resolve: (response: Response) => void };
  const pending: Pending[] = [];
  const writes: Array<{ secretScope: string; entries: Array<{ key: string; value: string }> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/oauth/pi/status') {
      return new Promise<Response>((resolve) => pending.push({ url, resolve }));
    }
    assert.equal(url.pathname, '/api/integrations/env');
    if (init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ success: true });
    }
    if (!url.searchParams.has('key')) return Response.json({ success: true, data: { entries: [] } });
    // Deliberately ignore abort here: even a response already in flight must
    // never be allowed to replace the currently selected provider's fields.
    return new Promise<Response>((resolve) => pending.push({ url, signal: init?.signal, resolve }));
  };
  const release = async (requests: Pending[], value = '') => act(async () => {
    for (const request of requests) request.resolve(Response.json({
      success: true,
      data: { entries: value ? [{ key: request.url.searchParams.get('key'), value }] : [] },
    }));
  });
  const wrap = (child: React.ReactNode) => (
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{child}</NextIntlClientProvider>
  );
  const ref = createRef<ProviderEnvEditorHandle>();
  const editor = (providerId: string, credentialScope: 'user' | 'system' = 'user') => wrap(
    <ProviderEnvEditor ref={ref} providerId={providerId} credentialScope={credentialScope}
      envVars={getProviderHelp(providerId)?.envVars?.map((field) => ({ ...field }))} />,
  );
  const names = () => Array.from(document.querySelectorAll('code')).map((element) => element.textContent?.replace(/\s*\*$/, ''));
  try {
    const view = render(editor('azure-openai-responses'));
    const azure = pending.splice(0);
    assert.equal(azure.length, 5);
    view.rerender(editor('baseten'));
    const baseten = pending.splice(0);
    assert.equal(baseten.length, 1);
    assert.ok(azure.every((request) => request.signal?.aborted));
    assert.deepEqual(names(), [], 'no old fields while the new provider is loading');
    let saved = true;
    await act(async () => { saved = await ref.current!.save(); });
    assert.equal(saved, false, 'imperative save must reject an unfinished provider load');
    assert.equal(writes.length, 0);
    await release(baseten);
    assert.deepEqual(names(), ['BASETEN_API_KEY']);
    await release(azure, 'old-azure-value');
    assert.deepEqual(names(), ['BASETEN_API_KEY'], 'late Azure responses must not overwrite Baseten');

    const input = document.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'baseten-test-value' } });
    view.rerender(editor('baseten'));
    assert.equal(pending.length, 0, 'equivalent field arrays must not reload credentials');
    assert.equal(input.value, 'baseten-test-value');
    await act(async () => { saved = await ref.current!.save(); });
    assert.equal(saved, true);
    assert.deepEqual(writes, [{ scope: 'agents', secretScope: 'user', mode: 'kv', entries: [{ key: 'BASETEN_API_KEY', value: 'baseten-test-value' }] }]);

    // Returning to the same provider after an intermediate selection must not
    // revive an earlier request or its unsaved values.
    view.rerender(editor('azure-openai-responses'));
    const secondAzure = pending.splice(0);
    view.rerender(editor('baseten', 'system'));
    const system = pending.splice(0);
    view.rerender(editor('baseten', 'user'));
    const user = pending.splice(0);
    await release(user, 'personal-test-value');
    await release(system, 'system-test-value');
    await release(secondAzure, 'stale-test-value');
    assert.deepEqual(names(), ['BASETEN_API_KEY']);
    assert.equal(document.querySelector('input')!.value, 'personal-test-value');
    assert.equal(system[0].url.searchParams.get('secretScope'), 'system');
    assert.ok(system.every((request) => request.signal?.aborted));
    cleanup();

    const installation = (providerId: string, installationId = providerId) => wrap(
      <ProviderInstallationCredentialEditor installation={{
        providerId, installationId, name: providerId, credentialScope: 'user', authMethod: 'api-key',
      }} />,
    );
    const installed = render(installation('baseten', 'one'));
    await release(pending.splice(0), 'saved-test-value');
    fireEvent.change(document.querySelector('input')!, { target: { value: 'unsaved-test-value' } });
    installed.rerender(installation('baseten', 'one'));
    assert.equal(pending.length, 0);
    assert.equal(document.querySelector('input')!.value, 'unsaved-test-value');
    installed.rerender(installation('baseten', 'two'));
    assert.deepEqual(names(), [], 'a new installation must not reuse the previous form');
    await release(pending.splice(0), 'other-installation-value');
    assert.equal(document.querySelector('input')!.value, 'other-installation-value');

    for (const providerId of [...getApiKeyProviders(), 'azure-openai-responses', 'ollama', 'openai-compatible']) {
      installed.rerender(installation(providerId));
      await release(pending.splice(0));
      const expected = getProviderHelp(providerId)?.envVars
        ?.filter((field) => providerId !== 'openai-compatible' || field.name !== 'OPENAI_COMPATIBLE_BASE_URL')
        .map((field) => field.name) ?? [];
      assert.deepEqual(names(), expected, `connection fields for ${providerId}`);
    }
    const managed: CredentialEditableProviderInstallation = {
      providerId: 'baseten', installationId: 'managed', name: 'Baseten', credentialScope: 'managed',
    };
    installed.rerender(wrap(<ProviderInstallationCredentialEditor installation={managed} />));
    assert.deepEqual(names(), []);
    assert.equal(pending.length, 0, 'managed credentials must not load editable secrets');

    const oauth = (providerId: string) => wrap(<ProviderInstallationCredentialEditor
      showIdentity={false}
      installation={{ providerId, installationId: providerId, name: providerId, credentialScope: 'user', authMethod: 'oauth' }}
    />);
    installed.rerender(oauth('openai-codex'));
    const oldOAuth = pending.splice(0);
    installed.rerender(oauth('openrouter'));
    const currentOAuth = pending.splice(0);
    const releaseOAuth = async (requests: Pending[]) => act(async () => {
      for (const request of requests) {
        const provider = request.url.searchParams.get('provider');
        request.resolve(Response.json({ success: true, provider: { provider, displayName: `Account ${provider}`, connected: true } }));
      }
    });
    await releaseOAuth(currentOAuth);
    await releaseOAuth(oldOAuth);
    assert.ok(installed.queryByText('Account openrouter'));
    assert.equal(installed.queryByText('Account openai-codex'), null, 'late OAuth status must not show the old account');
    assert.deepEqual(names(), []);
    cleanup();
    console.log('provider-connection-fields-test: ok');
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
