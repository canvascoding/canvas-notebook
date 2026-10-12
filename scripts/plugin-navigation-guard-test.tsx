import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act, useMemo, useSyncExternalStore } from 'react';
import type { PluginNavigation } from '../app/lib/plugins/plugin-navigation';

async function main() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><a id="header-link" href="/de/settings">Settings</a><a id="new-tab" href="/de/settings" target="_blank">New tab</a></body></html>', {
    url: 'https://canvas.test/de/notebook', pretendToBeVisual: true,
  });
  const names = ['window', 'document', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
    'PointerEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true,
    value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : name === 'PointerEvent' ? dom.window.MouseEvent : dom.window[name] });
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const updates: string[] = [], confirmations: string[] = [];
  let rawTraversals = 0;
  const observedTraversal = () => { rawTraversals += 1; };
  window.addEventListener('popstate', observedTraversal, true);
  let accepts = false;
  dom.window.confirm = message => { confirmations.push(message ?? ''); return accepts; };
  const nativePush = window.history.pushState.bind(window.history), nativeReplace = window.history.replaceState.bind(window.history);
  const initialTree = { tree: ['root', 'plugins'], renderedSearch: '?view=installed' };
  nativeReplace({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['root', 'notebook'] }, custom: 'prior-entry' }, '', window.location.href);
  nativePush({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: initialTree, custom: 'selected-entry' }, '', '/de/plugins?view=installed');
  const changed = () => { updates.push(window.location.href); window.dispatchEvent(new dom.window.Event('router-test')); };
  const traversed = () => changed();
  window.addEventListener('popstate', traversed);
  const subscribe = (callback: () => void) => {
    window.addEventListener('router-test', callback);
    return () => window.removeEventListener('router-test', callback);
  };
  const routes: Array<{ method: string; href?: string }> = [];
  const router = { push: (href: string) => { routes.push({ method: 'push', href }); window.history.pushState(null, '', `/de${href}`); },
    replace: (href: string) => { routes.push({ method: 'replace', href }); window.history.replaceState(null, '', `/de${href}`); },
    back: () => { routes.push({ method: 'back' }); window.history.back(); } };
  internals._load = (name, parent, isMain) => {
    if (name === '@/i18n/navigation') return { useRouter: () => router };
    if (name === 'next-intl') return { useTranslations: () => (key: string) => key };
    if (name === 'next/navigation') return { useSearchParams: () => {
      const search = useSyncExternalStore(subscribe, () => window.location.search);
      return useMemo(() => new URLSearchParams(search), [search]);
    } };
    return originalLoad(name, parent, isMain);
  };
  const { PluginNavigationGuard, usePluginEditorNavigationGuard, confirmPluginNavigation } = await import('../app/components/plugins/plugin-navigation-guard');
  const { usePluginNavigation } = await import('../app/components/plugins/usePluginNavigation');
  const { AppBackButton } = await import('../app/components/navigation/AppBackButton');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  type Editor = { key: string; dirty: boolean; pending: boolean };
  let navigate!: (patch: Partial<PluginNavigation>) => boolean;
  function Editor({ state }: { state: Editor }) {
    usePluginEditorNavigationGuard(state);
    return <input data-editor={state.key} defaultValue="unsaved local text" />;
  }
  function Harness({ editors, fallback }: { editors: Editor[]; fallback: boolean }) {
    const navigation = usePluginNavigation(); navigate = navigation.navigate;
    return <><PluginNavigationGuard unsavedChangesMessage="Ungespeicherte Änderungen verwerfen?" />
      <output>{navigation.navigation.view}</output>{editors.map(state => <Editor key={state.key} state={state} />)}
      <div id="app-header"><AppBackButton fallbackHref="/settings" preferFallback={fallback} /></div>
      <button id="ordinary-button">Run editor action</button></>;
  }
  const render = async (editors: Editor[], fallback = true) => { await act(async () => root.render(<Harness editors={editors} fallback={fallback} />)); };
  const backButton = () => document.querySelector<HTMLButtonElement>('#app-header [aria-label="back"]')!;
  const selectMenu = async (action: 'home' | 'back') => {
    await act(async () => document.querySelector<HTMLButtonElement>('#app-header [aria-label="openNavigationMenu"]')!
      .dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent === action);
    assert.ok(item, `real Radix navigation menu exposes ${action}`);
    await act(async () => { item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 10)); });
  };
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1500;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'history traversal did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  let dirty: Editor[] = [{ key: 'one', dirty: true, pending: false }];
  try {
    await render(dirty);
    assert.deepEqual(window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE, initialTree);
    assert.equal(window.history.state.custom, 'selected-entry');
    const guardedPush = window.history.pushState, guardedReplace = window.history.replaceState;
    const copyNext = (data: Record<string, unknown> | null) => ({ ...data, __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE });
    // Same external/internal history distinction as the installed Next App Router.
    window.history.pushState = (data, unused, url) => { const internal = data?.__NA || data?._N;
      guardedPush.call(window.history, internal ? data : copyNext(data), unused, url); if (!internal) changed(); };
    window.history.replaceState = (data, unused, url) => { const internal = data?.__NA || data?._N;
      guardedReplace.call(window.history, internal ? data : copyNext(data), unused, url); if (!internal) changed(); };

    const editor = document.querySelector<HTMLInputElement>('[data-editor="one"]')!;
    editor.value = 'keep this exact editor instance';
    let result = true;
    await act(async () => { result = navigate({ view: 'updates' }); });
    assert.equal(result, false); assert.equal(window.location.search, '?view=installed');
    assert.equal(confirmations.at(-1), 'Ungespeicherte Änderungen verwerfen?');
    const rejectedBackConfirmCount = confirmations.length, updateCount = updates.length;
    await act(async () => { window.history.back(); await wait(() => confirmations.length > rejectedBackConfirmCount && window.location.search === '?view=installed'); });
    assert.equal(confirmations.length, rejectedBackConfirmCount + 1);
    assert.equal(updates.length, updateCount, 'cancelled Back and its rollback never reach router consumers');
    assert.equal(document.querySelector('[data-editor="one"]'), editor); assert.equal(editor.value, 'keep this exact editor instance');
    assert.equal(window.history.state.custom, 'selected-entry');

    accepts = true;
    await act(async () => { result = navigate({ view: 'updates' }); });
    assert.equal(result, true); assert.equal(window.location.search, '?view=updates');
    assert.deepEqual(window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE, initialTree);
    assert.equal(document.querySelector('output')!.textContent, 'updates', 'external pushes still synchronize Next search parameters');
    accepts = false;
    const taggedBackConfirmCount = confirmations.length, taggedUpdates = updates.length;
    await act(async () => { window.history.back(); await wait(() => confirmations.length > taggedBackConfirmCount && window.location.search === '?view=updates'); });
    assert.equal(updates.length, taggedUpdates);
    accepts = true;
    await act(async () => { window.history.back(); await wait(() => window.location.search === '?view=installed'); });
    assert.equal(document.querySelector('output')!.textContent, 'installed');
    accepts = false;
    const forwardConfirmCount = confirmations.length, forwardUpdates = updates.length;
    await act(async () => { window.history.forward(); await wait(() => confirmations.length > forwardConfirmCount && window.location.search === '?view=installed'); });
    assert.equal(confirmations.length, forwardConfirmCount + 1); assert.equal(updates.length, forwardUpdates);
    accepts = true;
    await act(async () => { window.history.forward(); await wait(() => window.location.search === '?view=updates'); });
    assert.equal(document.querySelector('output')!.textContent, 'updates');

    dirty = [{ key: 'one', dirty: true, pending: false }, { key: 'two', dirty: false, pending: true }];
    await render(dirty);
    const pendingCount = confirmations.length, pendingLength = window.history.length;
    await act(async () => { result = navigate({ view: 'installed' }); });
    assert.equal(result, false); assert.equal(confirmations.length, pendingCount); assert.equal(window.history.length, pendingLength);
    const pendingTraversals = rawTraversals;
    await act(async () => { window.history.back(); await wait(() => rawTraversals >= pendingTraversals + 2 && window.location.search === '?view=updates'); });
    assert.equal(confirmations.length, pendingCount); assert.equal(window.location.search, '?view=updates');
    const link = document.getElementById('header-link')!;
    assert.equal(link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })), false);
    assert.equal(confirmations.length, pendingCount);
    assert.equal(document.getElementById('ordinary-button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })), true);
    const unloading = new dom.window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloading); assert.equal(unloading.defaultPrevented, true);
    await act(async () => backButton().click());
    await selectMenu('home'); await selectMenu('back');
    assert.deepEqual(routes, [], 'pending editors block actual Header fallback and delayed Home before router actions');
    assert.equal(confirmations.length, pendingCount);

    await render([{ key: 'one', dirty: true, pending: false }]);
    accepts = false; assert.equal(confirmPluginNavigation(), false, 'unmounting only the pending editor leaves the dirty editor registered');
    const headerConfirmCount = confirmations.length;
    await act(async () => backButton().click()); await selectMenu('home'); await selectMenu('back');
    assert.deepEqual(routes, []); assert.equal(confirmations.length, headerConfirmCount + 3);
    await render([{ key: 'one', dirty: true, pending: false }], false);
    const ordinaryBackConfirmCount = confirmations.length, ordinaryBackTraversals = rawTraversals;
    await act(async () => { backButton().click(); await wait(() => rawTraversals >= ordinaryBackTraversals + 2 && window.location.search === '?view=updates'); });
    assert.deepEqual(routes, [{ method: 'back' }]);
    assert.equal(confirmations.length, ordinaryBackConfirmCount + 1, 'native Header Back confirms exactly once in the popstate fence');
    await render([{ key: 'one', dirty: false, pending: false }]);
    const cleanCount = confirmations.length;
    assert.equal(confirmPluginNavigation(), true); assert.equal(confirmations.length, cleanCount);
    await act(async () => { result = navigate({ view: 'installed' }); });
    assert.equal(result, true); assert.equal(confirmations.length, cleanCount);
    await render([]); assert.equal(confirmPluginNavigation(), true);
    await act(async () => backButton().click());
    assert.deepEqual(routes.at(-1), { method: 'replace', href: '/settings' });
    await selectMenu('home'); assert.deepEqual(routes.at(-1), { method: 'push', href: '/' });
    assert.equal(confirmations.length, cleanCount);
    const cleanUnload = new dom.window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload); assert.equal(cleanUnload.defaultPrevented, false);
    await act(async () => root.unmount());
    window.history.pushState({ custom: 'after-unmount' }, '', '/de/plugins?view=updates');
    assert.equal(window.history.state.custom, 'after-unmount'); assert.equal(window.history.state.__canvasPluginNavigation, undefined);
    assert.equal(confirmPluginNavigation(), true); assert.equal(confirmations.length, cleanCount);
    console.log('PASS plugin navigation guard: real DOM/history Back+Forward, Next state, pending/dirty, Header fallback/Home/menu, links and editor cleanup');
  } finally {
    internals._load = originalLoad;
    window.removeEventListener('popstate', traversed);
    window.removeEventListener('popstate', observedTraversal, true);
    dom.window.close();
    names.forEach((name, index) => { if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!); else Reflect.deleteProperty(globalThis, name); });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
