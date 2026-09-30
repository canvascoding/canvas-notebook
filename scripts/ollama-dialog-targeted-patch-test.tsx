import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { AiProviderEditorCopy } from '../app/components/settings/ai-runtime/AiProviderEditorDialog';
import type { AiCatalogProviderDraft } from '../app/components/settings/ai-runtime/catalog-client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const secretEvents: Array<{ secretScope?: string }> = [];
const onSecretUpdated = (event: Event) => secretEvents.push((event as CustomEvent<{ secretScope?: string }>).detail);
window.addEventListener('canvas_secrets_updated', onSecretUpdated);

const copy = {
  addTitle: 'Add provider', editTitle: 'Edit provider', description: 'Configure provider', provider: 'Provider',
  chooseProvider: 'Choose provider', connectionStep: 'Connection', connectionDescription: 'Connect provider',
  modelsStep: 'Models', modelsDescription: 'Choose models', accessStep: 'Access', accessDescription: 'Set access',
  serverUrl: 'Server URL', serverUrlHint: 'Server hint', serverUrlPlaceholder: 'http://localhost:11434',
  openAiCompatibleUrlPlaceholder: 'https://example.test/v1', apiKey: 'API key', apiKeyOptional: 'Optional',
  apiKeyPlaceholder: 'Enter key', testConnection: 'Test connection', testingConnection: 'Testing',
  connectionReady: (count: number) => `${count} models found`, noRemoteModels: 'No remote models',
  discoverFirst: 'Discover', configureManually: 'Configure manually', continueToModels: 'Continue',
  manualModel: 'Manual model', manualModelPlaceholder: 'Model ID', addModel: 'Add model', searchModels: 'Search',
  allowed: 'Allowed', providerDefault: 'Default', noModels: 'No models', authentication: 'Authentication',
  apiKeyAuthentication: 'API key', oauthAuthentication: 'OAuth', credentialScope: 'Credential scope',
  providerEnabled: 'Enabled', providerEnabledHint: 'Enable provider', credentials: 'Credentials',
  credentialsDescription: 'Credential details', cancel: 'Cancel', save: 'Save', saveAndVerify: 'Save and verify',
  saveVerifyAndUse: 'Save, verify, and use', saving: 'Saving', remove: 'Remove',
  errors: {
    invalidUrl: 'Invalid URL', invalidModel: 'Invalid model', enabledNeedsModel: 'Choose a model',
    defaultRequired: 'Choose a default model', discovery: 'Discovery failed', credentialLoad: 'Load failed',
    credentialSave: 'Save failed',
  },
  scope: { managed: 'Managed', system: 'System', organization: 'Organization', user: 'User' },
} as AiProviderEditorCopy;

const provider: AiCatalogProviderDraft = {
  clientKey: 'ollama-installation', providerInstallationId: 'ollama-installation', providerId: 'ollama',
  name: 'Ollama', source: 'built-in', status: 'ready', enabled: true, credentialScope: 'organization',
  config: { ollamaHost: 'http://127.0.0.1:11434' }, modelIds: ['llama3.1'], defaultModelId: 'llama3.1',
  availableModels: [{ id: 'llama3.1', name: 'Llama 3.1', reasoning: false, supportsVision: false, contextWindow: 8192, maxTokens: 1024 }],
  sourceRevision: null, lastSyncedAt: null,
};

async function main() {
  const { render, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
  const { AiProviderEditorDialog } = await import('../app/components/settings/ai-runtime/AiProviderEditorDialog');
  const originalFetch = globalThis.fetch;
  const writes: Array<{ method: string; body: unknown }> = [];
  const reads: URL[] = [];
  let saves = 0;
  let failNextPatch = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (init?.method === 'PATCH') {
      writes.push({ method: init.method, body: JSON.parse(String(init.body)) });
      if (failNextPatch) {
        failNextPatch = false;
        return Response.json({ success: false, error: 'Forbidden fixture' }, { status: 403 });
      }
      return Response.json({ success: true });
    }
    assert.equal(init?.method, undefined, 'the Ollama credential prefetch stays read-only');
    reads.push(url);
    return Response.json({ success: true, data: { entries: [
      { key: 'OLLAMA_API_KEY', value: 'existing-ollama-key' },
      { key: 'UNRELATED_CONCURRENT_KEY', value: 'keep-me' },
    ] } });
  };
  const view = render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <AiProviderEditorDialog open provider={provider} copy={copy} onOpenChange={() => undefined}
        onSave={async () => { saves += 1; }} />
    </NextIntlClientProvider>,
  );
  try {
    await waitFor(() => assert.equal((document.querySelector('#ollama-api-key') as HTMLInputElement).value, 'existing-ollama-key'));
    assert.equal(reads.length, 1);
    assert.equal(reads[0].searchParams.get('scope'), 'agents');
    assert.equal(reads[0].searchParams.get('secretScope'), 'organization');

    const credential = document.querySelector('#ollama-api-key')!;
    fireEvent.change(credential, { target: { value: 'updated-ollama-key' } });
    fireEvent.click(view.getByTestId('provider-save'));
    await waitFor(() => assert.equal(writes.length, 1));
    assert.deepEqual(writes[0], {
      method: 'PATCH',
      body: { scope: 'agents', secretScope: 'organization', patches: [{ key: 'OLLAMA_API_KEY', value: 'updated-ollama-key' }] },
    });
    assert.deepEqual(secretEvents, [{ secretScope: 'organization' }]);
    assert.equal(saves, 1);

    fireEvent.change(credential, { target: { value: '' } });
    fireEvent.click(view.getByTestId('provider-save'));
    await waitFor(() => assert.equal(writes.length, 2));
    assert.deepEqual(writes[1], {
      method: 'PATCH',
      body: { scope: 'agents', secretScope: 'organization', patches: [{ key: 'OLLAMA_API_KEY', value: null }] },
    });
    assert.deepEqual(secretEvents, [{ secretScope: 'organization' }, { secretScope: 'organization' }]);
    assert.equal(saves, 2);
    assert.equal(reads.length, 1, 'saves never fetch a full ENV snapshot that could overwrite unrelated keys');

    failNextPatch = true;
    fireEvent.change(credential, { target: { value: 'denied-key' } });
    fireEvent.click(view.getByTestId('provider-save'));
    await view.findByText('Forbidden fixture');
    assert.equal(writes.length, 3);
    assert.deepEqual(secretEvents, [{ secretScope: 'organization' }, { secretScope: 'organization' }], '403 failures do not dispatch the refresh event');
    console.log('ollama-dialog-targeted-patch-test: ok');
  } finally {
    cleanup();
    window.removeEventListener('canvas_secrets_updated', onSecretUpdated);
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
