import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import { EMPTY_STUDIO_PROVIDER_CONFIG, type StudioProviderConfig } from '../app/apps/studio/types/config';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/studio', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

async function main() {
  const { render, renderHook, cleanup, fireEvent, within } = await import('@testing-library/react');
  const { useStudioProviderConfig, canUseStudioProvider, getMissingProviderRequirement, parseStudioProviderConfig } = await import('../app/apps/studio/hooks/useStudioProviderConfig');
  const { getStudioGenerationErrorHint } = await import('../app/apps/studio/utils/generation-error-hints');
  const { OutputErrorCard } = await import('../app/apps/studio/components/create/OutputErrorCard');
  const { StudioMediaCredentialsPanel } = await import('../app/components/settings/StudioMediaCredentialsPanel');
  const originalFetch = globalThis.fetch;
  const config = (keys: Partial<StudioProviderConfig['localApiKeys']> = {}, managedMediaAvailable = false): StudioProviderConfig => ({
    ...EMPTY_STUDIO_PROVIDER_CONFIG,
    localApiKeys: { ...EMPTY_STUDIO_PROVIDER_CONFIG.localApiKeys, ...keys },
    managedMediaAvailable,
  });

  try {
    for (const [mode, provider, requirement] of [
      ['image', 'gemini', 'gemini'], ['sound', 'gemini', 'gemini'], ['video', 'veo', 'gemini'],
      ['image', 'openai', 'openai'], ['video', 'bytedance', 'kie'],
    ] as const) {
      assert.equal(getMissingProviderRequirement(config(), mode, provider), requirement);
      for (const status of ['checking', 'ready', 'failed'] as const) {
        assert.equal(canUseStudioProvider(config(), status, mode, provider), false, 'missing access never enables generation');
        assert.equal(canUseStudioProvider(config({ [requirement]: true }), status, mode, provider), true, 'confirmed local access survives failed or delayed refresh');
        assert.equal(canUseStudioProvider(config({}, true), status, mode, provider), true, 'managed fallback survives failed or delayed refresh');
      }
    }
    assert.equal(getMissingProviderRequirement(config({ openai: true }), 'image', 'gemini'), 'gemini', 'switching provider cannot borrow another provider key');
    assert.equal(canUseStudioProvider(config({ openai: true }), 'failed', 'image', 'gemini'), false);
    assert.deepEqual(parseStudioProviderConfig(config()), config());
    for (const value of [null, {}, { ...config(), managedMediaAvailable: 'true' }, { ...config(), localApiKeys: { gemini: 'true', openai: false, kie: false } }]) {
      assert.equal(parseStudioProviderConfig(value), null, 'malformed configuration must not become ready');
    }
    assert.equal(getStudioGenerationErrorHint('No image was returned by Gemini. PromptFeedback=OTHER'), 'geminiBlockedPrompt');
    assert.equal(getStudioGenerationErrorHint('No image was returned by Gemini'), null);

    type Pending = { signal?: AbortSignal | null; resolve: (response: Response) => void; reject: (error: Error) => void };
    const pending: Pending[] = [];
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), '/api/studio/config');
      return new Promise<Response>((resolve, reject) => pending.push({ signal: init?.signal, resolve, reject }));
    };
    const known = config({ gemini: true });
    const hook = renderHook(() => useStudioProviderConfig(known));
    assert.equal(hook.result.current.providerConfigStatus, 'checking');
    assert.equal(canUseStudioProvider(hook.result.current.providerConfig, 'checking', 'image', 'gemini'), true);
    await act(async () => pending[0].resolve(Response.json({}, { status: 503 })));
    assert.equal(hook.result.current.providerConfigStatus, 'failed');
    assert.deepEqual(hook.result.current.providerConfig, known, 'failed HTTP refresh retains server-confirmed access');

    let retry: Promise<void>;
    await act(async () => { retry = hook.result.current.refreshProviderConfig(); });
    assert.equal(hook.result.current.providerConfigStatus, 'checking');
    await act(async () => { pending[1].resolve(Response.json({ success: true, config: config({ openai: true }) })); await retry; });
    assert.equal(hook.result.current.providerConfigStatus, 'ready');
    assert.equal(hook.result.current.providerConfig.localApiKeys.openai, true);
    assert.equal(hook.result.current.providerConfig.localApiKeys.gemini, false, 'a successful refresh replaces stale provider access');

    await act(async () => { void hook.result.current.refreshProviderConfig(); });
    await act(async () => pending[2].resolve(Response.json({ success: true, config: { managedMediaAvailable: true } })));
    assert.equal(hook.result.current.providerConfigStatus, 'failed');
    assert.equal(hook.result.current.providerConfig.localApiKeys.openai, true, 'invalid payload preserves last confirmed configuration');

    await act(async () => { void hook.result.current.refreshProviderConfig(); });
    await act(async () => { void hook.result.current.refreshProviderConfig(); });
    assert.equal(pending[3].signal?.aborted, true, 'retry cancels the prior request');
    await act(async () => pending[4].resolve(Response.json({ success: true, config: config({}, true) })));
    await act(async () => pending[3].resolve(Response.json({ success: true, config: config() })));
    assert.equal(hook.result.current.providerConfig.managedMediaAvailable, true, 'an old response cannot overwrite the newest configuration');
    hook.unmount();

    const unknown = renderHook(() => useStudioProviderConfig(config()));
    await act(async () => pending[5].reject(new Error('offline')));
    assert.equal(unknown.result.current.providerConfigStatus, 'failed');
    assert.equal(canUseStudioProvider(unknown.result.current.providerConfig, 'failed', 'image', 'gemini'), false);
    await act(async () => { void unknown.result.current.refreshProviderConfig(); });
    unknown.unmount();
    assert.equal(pending[6].signal?.aborted, true, 'unmount cancels refresh');
    await act(async () => pending[6].resolve(Response.json({ success: true, config: known })));

    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).startsWith('/api/integrations/env?'));
      assert.equal(init?.method ?? 'GET', 'GET', 'credential-panel checks never write secrets');
      return Response.json({ success: true, data: { entries: [] } });
    };
    for (const [locale, messages] of [['en', en], ['de', de]] as const) {
      const labels = messages.studio.outputError;
      let remixed: string | undefined;
      let deleted = 0;
      let copied: string | undefined;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
      const screen = render(<NextIntlClientProvider locale={locale} timeZone="Europe/Berlin" messages={messages}>
        <OutputErrorCard mode="image" message="No image was returned by Gemini. PromptFeedback=OTHER" prompt="Original prompt" onRemix={(prompt) => { remixed = prompt; }} onDelete={() => { deleted += 1; }} />
      </NextIntlClientProvider>);
      assert.ok(screen.getByText(labels.title));
      assert.ok(screen.getByText(labels.geminiBlockedPrompt));
      await act(async () => fireEvent.click(screen.getByRole('button', { name: labels.details })));
      const details = screen.getByRole('dialog');
      assert.ok(within(details).getByText(labels.errorLabel));
      assert.equal((within(details).getByLabelText(labels.originalPrompt) as HTMLTextAreaElement).value, 'Original prompt');
      await act(async () => fireEvent.click(within(details).getByRole('button', { name: labels.copy })));
      assert.equal(copied, 'Original prompt');
      await act(async () => fireEvent.click(within(details).getByRole('button', { name: labels.remix })));
      assert.equal(remixed, 'Original prompt');
      assert.equal(screen.queryByRole('dialog'), null);
      await act(async () => fireEvent.click(screen.getByRole('button', { name: labels.delete })));
      const confirmation = screen.getByRole('alertdialog');
      assert.ok(within(confirmation).getByText(labels.deleteTitle));
      await act(async () => fireEvent.click(within(confirmation).getByRole('button', { name: labels.delete })));
      assert.equal(deleted, 1);
      cleanup();

      dom.window.history.replaceState(null, '', '/settings?tab=secrets#studio-media-credentials');
      const panel = render(<NextIntlClientProvider locale={locale} timeZone="Europe/Berlin" messages={messages}>
        <StudioMediaCredentialsPanel locale={locale} />
      </NextIntlClientProvider>);
      await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
      const trigger = document.getElementById('studio-media-credentials')?.querySelector('button');
      assert.equal(trigger?.getAttribute('aria-expanded'), 'true', 'credential deep link opens the accordion');
      assert.equal(document.activeElement, trigger, 'credential deep link moves keyboard focus to the panel');
      assert.ok(panel.getByText('GEMINI_API_KEY'));
      cleanup();
      dom.window.history.replaceState(null, '', '/studio');
    }
    console.log('studio-provider-notices-test: ok (provider gating, HTTP/invalid/offline failures, retry races, en/de output dialogs, credential deep-link focus)');
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
