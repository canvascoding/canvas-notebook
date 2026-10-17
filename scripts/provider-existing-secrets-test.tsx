import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { createRef, act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { getProviderHelp } from '../app/lib/pi/provider-help';
import type { ProviderEnvEditorHandle } from '../app/components/settings/ProviderEnvEditor';

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, cleanup, waitFor } = await import('@testing-library/react');
  const { ProviderEnvEditor } = await import('../app/components/settings/ProviderEnvEditor');
  const originalFetch = globalThis.fetch;
  let writes = 0;
  let failure: 'none' | 'forbidden' | 'unreadable' | 'network' = 'none';
  globalThis.fetch = async (input, init) => {
    if (init?.method) { writes++; return Response.json({ success: true }); }
    if (failure === 'network') throw new Error('transport failed');
    if (failure === 'forbidden') return Response.json({ success: false, error: 'Forbidden fixture' }, { status: 403 });
    const key = new URL(String(input), 'http://localhost').searchParams.get('key');
    return Response.json({ success: true, data: { entries: [{ key, value: failure === 'unreadable' ? '' : 'existing-private-fixture', readable: failure !== 'unreadable' }] } });
  };
  try {
    for (const providerId of ['openai', 'anthropic', 'google', 'openrouter']) {
      const ref = createRef<ProviderEnvEditorHandle>();
      const view = render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <ProviderEnvEditor ref={ref} providerId={providerId} envVars={getProviderHelp(providerId)?.envVars} />
      </NextIntlClientProvider>);
      await waitFor(() => assert.ok(view.getByTestId('provider-existing-credentials')));
      let saved = false;
      await act(async () => { saved = await ref.current!.save(); });
      assert.equal(saved, true, `${providerId} reuses existing credentials without input`);
      assert.equal(writes, 0, 'unchanged credentials are never rewritten');
      cleanup();
    }
    for (const mode of ['forbidden', 'unreadable', 'network'] as const) {
      failure = mode;
      const ref = createRef<ProviderEnvEditorHandle>();
      const view = render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <ProviderEnvEditor ref={ref} providerId="openai" envVars={getProviderHelp('openai')?.envVars} />
      </NextIntlClientProvider>);
      await waitFor(() => assert.ok(view.getByText('Failed to load environment variables')));
      assert.equal(view.queryByText('Required field not configured yet'), null, `${mode} is not treated as a missing key`);
      let saved = true;
      await act(async () => { saved = await ref.current!.save(); });
      assert.equal(saved, false); assert.equal(writes, 0);
      cleanup();
    }
    console.log('provider-existing-secrets-test: ok');
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
