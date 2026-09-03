import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { JSDOM } from 'jsdom';
import messages from '../messages/en.json';

async function main() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  const sources: FakeEventSource[] = [];
  class FakeEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor() { sources.push(this); }
    close() { this.closed = true; }
    emit(enabled: boolean) { this.onmessage?.({ data: JSON.stringify({ terminalEnabled: enabled, terminalUpdatedAt: null }) }); }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
  let userId: string | null = 'admin';
  const internal = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = internal._load;
  internal._load = (name, ...args) => {
    if (name === 'next-intl') {
      return { useTranslations: (namespace: string) => (key: string) => {
        const value = `${namespace}.${key}`.split('.').reduce<unknown>((current, part) => (current as Record<string, unknown>)[part], messages);
        assert.equal(typeof value, 'string');
        return value;
      } };
    }
    if (name === '@/app/lib/auth-client' || name.endsWith('/app/lib/auth-client')) {
      return { authClient: { useSession: () => ({ data: userId ? { user: { id: userId } } : null }) } };
    }
    if (name === '@/i18n/navigation' || name.endsWith('/i18n/navigation')) {
      return { Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> };
    }
    return originalLoad(name, ...args);
  };
  const originalFetch = globalThis.fetch;
  try {
    const { render, fireEvent, act, cleanup } = await import('@testing-library/react');
    const { TerminalAvailabilityProvider, useTerminalAvailability } = await import('../app/components/terminal/TerminalAvailabilityProvider');
    const { AdministrationSettingsPanel } = await import('../app/components/settings/AdministrationSettingsPanel');
    const { MoreToolsSection } = await import('../app/components/home/MoreToolsSection');
    const { useTerminalStore } = await import('../app/store/terminal-store');
    const { getTutorials } = await import('../app/components/help/help-data');
    const requests: unknown[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      requests.push(body);
      return Response.json({ success: true, data: { ...body, terminalUpdatedAt: null } });
    };
    function Probe() {
      const state = useTerminalAvailability();
      return <><output data-testid="policy">{String(state.ready)}:{String(state.terminalEnabled)}</output><button onClick={state.markDisabled}>Revoke session</button></>;
    }
    const tree = () => (
      <>
        <TerminalAvailabilityProvider>
          <Probe />
          <AdministrationSettingsPanel />
          <MoreToolsSection />
        </TerminalAvailabilityProvider>
      </>
    );
    const ui = render(tree());
    assert.equal(ui.getByTestId('policy').textContent, 'false:false', 'loading must not grant access');
    assert.equal(ui.getByRole('switch').getAttribute('disabled'), '', 'admin toggle waits for authoritative state');
    fireEvent.click(ui.getByRole('button', { name: messages.home.sections.moreTools }));
    assert.equal(ui.container.querySelector('a[href="/terminal"]'), null);
    useTerminalStore.getState().createSession();
    await act(async () => sources.at(-1)!.emit(false));
    assert.equal(useTerminalStore.getState().sessions.length, 0, 'disabled state clears saved sessions');
    assert.equal(ui.getByTestId('policy').textContent, 'true:false');
    await act(async () => { fireEvent.click(ui.getByRole('switch')); });
    assert.deepEqual(requests, [{ terminalEnabled: true }]);
    assert(ui.container.querySelector('a[href="/terminal"]'), 'enabling restores the home link');
    assert.equal(ui.getByRole('switch').getAttribute('aria-checked'), 'true');
    await act(async () => sources.at(-1)!.emit(false));
    assert.equal(ui.container.querySelector('a[href="/terminal"]'), null, 'remote disabling removes the link without navigation');
    assert.equal(ui.getByRole('switch').getAttribute('aria-checked'), 'false');
    await act(async () => sources.at(-1)!.emit(true));
    const beforeRevocation = sources.at(-1)!;
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Revoke session' })); });
    assert(beforeRevocation.closed, 'revocation revalidates the authoritative policy');
    assert.equal(ui.getByTestId('policy').textContent, 'true:false');
    await act(async () => sources.at(-1)!.emit(true));
    assert.equal(ui.getByTestId('policy').textContent, 'true:true', 'a late revocation cannot leave re-enabled UI stuck disabled');
    const previousSource = sources.at(-1)!;
    userId = 'other-user';
    ui.rerender(tree());
    assert(previousSource.closed, 'changing users closes the previous availability stream');
    assert.equal(ui.getByTestId('policy').textContent, 'false:false', 'another user must not inherit stale enabled state');
    await act(async () => previousSource.emit(true));
    assert.equal(ui.getByTestId('policy').textContent, 'false:false', 'late events from an old session are ignored');
    await act(async () => sources.at(-1)!.emit(true));
    await act(async () => sources.at(-1)!.onerror?.());
    assert.equal(ui.container.querySelector('a[href="/terminal"]'), null, 'unknown availability fails closed');
    for (const locale of ['de', 'en']) {
      assert(!getTutorials(locale).some(tutorial => tutorial.id === 'terminal-basics'));
      assert(getTutorials(locale, true).some(tutorial => tutorial.id === 'terminal-basics'));
    }
    cleanup();
    assert(sources.every(source => source.closed), 'unmount closes availability streams');
    console.log('terminal-ui-test: ok');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
