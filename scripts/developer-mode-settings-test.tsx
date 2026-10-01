import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/settings', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });

async function main(): Promise<void> {
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useParams: () => ({ locale: 'en' }) };
    if (name === '@/i18n/navigation') return { usePathname: () => '/settings' };
    if (name === 'next-intl') return { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` };
    if (name === '@/app/components/ThemeProvider') return { useTheme: () => ({ theme: 'light', setTheme: () => undefined }) };
    if (name === './ProfileAppearanceSettingsCard') return { ProfileAppearanceSettingsCard: () => null };
    return originalLoad(name, parent, isMain);
  };
  const originalFetch = globalThis.fetch;
  const events: unknown[] = [];
  const onChanged = (event: Event) => events.push((event as CustomEvent<unknown>).detail);
  dom.window.addEventListener('canvas-developer-mode-changed', onChanged);
  try {
    const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
    const { GeneralSettingsPanel } = await import('../app/components/settings/GeneralSettingsPanel');
    const requests: Array<{ body: unknown; credentials: unknown }> = [];
    let storedPreference = false;
    let failNext = false;
    let releaseFirstSave: () => void = () => undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), '/api/user-preferences');
      assert.equal(init?.method, 'PATCH');
      const body = JSON.parse(String(init?.body));
      requests.push({ body, credentials: init?.credentials });
      if (requests.length === 1) await new Promise<void>(resolve => { releaseFirstSave = resolve; });
      if (failNext) { failNext = false; return Response.json({ success: false }, { status: 503 }); }
      storedPreference = body.developerMode;
      return Response.json({ success: true, data: { developerMode: storedPreference } });
    };
    function Harness() {
      const [developerMode, setDeveloperMode] = useState(false);
      return <GeneralSettingsPanel developerMode={developerMode} onDeveloperModeChanged={setDeveloperMode} initialUserProfile={{ name: 'Member', avatarKind: 'initials', iconId: null, initials: 'M', imageUrl: null, revision: 0 }} />;
    }
    const view = render(<Harness />);
    const control = view.getByTestId('developer-mode-switch');
    assert.equal(control.getAttribute('role'), 'switch');
    assert.equal(control.getAttribute('aria-checked'), 'false', 'developer mode is available and initially off for a non-admin');
    fireEvent.click(control);
    assert.equal(control.getAttribute('aria-checked'), 'false', 'display state changes only after durable preference save');
    assert.equal(control.hasAttribute('disabled'), true);
    assert.deepEqual(events, []);
    await act(async () => releaseFirstSave());
    await waitFor(() => assert.equal(control.getAttribute('aria-checked'), 'true'));
    assert.deepEqual(requests[0], { body: { developerMode: true }, credentials: 'include' });
    assert.equal(storedPreference, true);
    assert.deepEqual(events, [true], 'the event detail is the saved boolean');
    failNext = true;
    await act(async () => fireEvent.click(control));
    assert.equal(control.getAttribute('aria-checked'), 'true', 'failed saves leave the last persisted preference visible');
    assert.equal(storedPreference, true);
    assert.deepEqual(events, [true], 'failed saves do not emit a preference change');
    await act(async () => fireEvent.click(control));
    assert.equal(control.getAttribute('aria-checked'), 'false');
    assert.equal(storedPreference, false);
    assert.deepEqual(events, [true, false]);
    cleanup();
    console.log('developer-mode-settings-test: PASS (personal switch, strict PATCH, wait for save, boolean event, failure preserves state)');
  } finally {
    internals._load = originalLoad;
    globalThis.fetch = originalFetch;
    dom.window.removeEventListener('canvas-developer-mode-changed', onChanged);
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
