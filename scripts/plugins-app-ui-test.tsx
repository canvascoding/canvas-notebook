import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act, useMemo, useSyncExternalStore } from 'react';
import de from '../messages/de.json';
import en from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/de/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const pushState = dom.window.history.pushState.bind(dom.window.history);
dom.window.history.pushState = (...args) => { pushState(...args); dom.window.dispatchEvent(new dom.window.Event('navigation-test')); };
const subscribe = (onChange: () => void) => {
  dom.window.addEventListener('navigation-test', onChange);
  dom.window.addEventListener('popstate', onChange);
  return () => { dom.window.removeEventListener('navigation-test', onChange); dom.window.removeEventListener('popstate', onChange); };
};

async function main() {
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const originalFetch = globalThis.fetch;
  let locale: 'de' | 'en' = 'de';
  const fetches: string[] = [];
  type Translate = (key: string, values?: Record<string, string | number>) => string;
  const translations = new Map<string, Translate>();
  const translate = (namespace: string): Translate => {
    const cacheKey = `${locale}:${namespace}`;
    const cached = translations.get(cacheKey);
    if (cached) return cached;
    const messages = locale === 'de' ? de : en;
    const fn: Translate = (key, values = {}) => {
    let text: unknown = messages;
    for (const part of `${namespace}.${key}`.split('.')) text = (text as Record<string, unknown>)?.[part];
    assert.equal(typeof text, 'string', `Missing ${locale} translation: ${namespace}.${key}`);
    return String(text).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
    };
    translations.set(cacheKey, fn);
    return fn;
  };
  internals._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => {
      const query = useSyncExternalStore(subscribe, () => dom.window.location.search);
      return useMemo(() => new URLSearchParams(query), [query]);
    } };
    if (name === 'next-intl') return { useTranslations: translate, useLocale: () => locale };
    if (name === '@/i18n/navigation') return {
      Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function MockLink(props, ref) { return <a {...props} ref={ref} href={`/${locale}${props.href}`} />; }),
      usePathname: () => '/plugins',
      getPathname: ({ href }: { href: string }) => `/${locale}${href}`,
    };
    if (name === '@/app/store/workspace-store') return { useWorkspaceStore: (select: (state: unknown) => unknown) => select({ activeWorkspaceId: 'workspace-one' }) };
    if (name === '@/app/components/terminal/TerminalAvailabilityProvider') return { useTerminalAvailability: () => ({ terminalEnabled: false }) };
    if (name === '@/app/components/editor/MarkdownEditorClient') return { MarkdownEditor: () => null };
    return originalLoad(name, parent, isMain);
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), dom.window.location.origin);
    fetches.push(url.pathname + url.search);
    if (url.pathname === '/api/skills') return Response.json({ success: true, skills: [], canManageOrganizationCapabilities: false });
    if (url.pathname === '/api/skills/status') return Response.json({ success: true, enabledSkills: [] });
    if (url.pathname === '/api/skills/tree') return Response.json({ success: true, data: [] });
    if (url.pathname === '/api/plugins') return Response.json({ success: true, plugins: [] });
    if (url.pathname === '/api/plugins/store') return Response.json({ success: true, plugins: [], stats: { updates: 0 } });
    if (url.pathname === '/api/skills/store') return Response.json({ success: true, skills: [], stats: { updates: 0 } });
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  };
  try {
    const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
    const { SkillsPanel } = await import('../app/components/plugins/PluginsPanel');
    const { AppLauncher } = await import('../app/components/AppLauncher');
    const { PluginsSettingsLink } = await import('../app/components/plugins/PluginsSettingsLink');
    dom.window.localStorage.setItem('canvas.skills.panelTab', 'skills');
    dom.window.localStorage.setItem('canvas.skills.pluginStoreTab', 'advanced');
    let view = render(<SkillsPanel />);
    await waitFor(() => assert.equal(view.getByRole('tab', { name: 'Plugins' }).getAttribute('aria-selected'), 'true'));
    assert.equal(view.getByRole('tab', { name: 'Entdecken' }).getAttribute('aria-selected'), 'true', 'the app entry opens plugins despite obsolete stored tabs');
    fireEvent.mouseDown(view.getByRole('tab', { name: 'Installiert' }), { button: 0 });
    await waitFor(() => assert.equal(new URLSearchParams(dom.window.location.search).get('view'), 'installed'));
    assert.equal(view.getByRole('tab', { name: 'Installiert' }).getAttribute('aria-selected'), 'true');
    await act(async () => { dom.window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
    await waitFor(() => assert.equal(view.getByRole('tab', { name: 'Entdecken' }).getAttribute('aria-selected'), 'true'));
    cleanup();

    dom.window.history.replaceState(null, '', '/de/plugins?area=skills&view=library');
    view = render(<SkillsPanel />);
    await waitFor(() => assert.equal(view.getByRole('tab', { name: 'Skills' }).getAttribute('aria-selected'), 'true'));
    assert.equal(view.getByRole('tab', { name: de.skills.skillLibrary.tabs.library }).getAttribute('aria-selected'), 'true');
    assert.ok(fetches.some(url => url.startsWith('/api/skills/store?')));
    cleanup();

    for (locale of ['de', 'en'] as const) {
      view = render(<PluginsSettingsLink />);
      assert.equal(view.getByRole('link').getAttribute('href'), `/${locale}/plugins`);
      cleanup();
      view = render(<AppLauncher />);
      fireEvent.pointerDown(view.getByRole('button', { name: locale === 'de' ? 'Apps öffnen' : 'Open apps' }), { button: 0, isPrimary: true });
      await waitFor(() => assert.ok(view.getByRole('menuitem', { name: 'Plugins' })));
      assert.equal(view.getByRole('menuitem', { name: 'Plugins' }).getAttribute('href'), `/${locale}/plugins`);
      assert.ok(view.getByRole('menuitem', { name: 'Notebook' }));
      fireEvent.contextMenu(view.getByRole('menuitem', { name: 'Plugins' }));
      await waitFor(() => assert.equal(view.getByRole('menuitem', { name: locale === 'de' ? 'Installiert' : 'Installed' }).getAttribute('href'), `/${locale}/plugins?view=installed`));
      assert.equal(view.getByRole('menuitem', { name: 'Skills' }).getAttribute('href'), `/${locale}/plugins?area=skills`);
      cleanup();
    }
    console.log('Plugins UI: direct app entry, obsolete tab preferences, installed view, browser history, skill library, Settings link and launcher in both locales passed');
  } finally {
    internals._load = originalLoad;
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
