import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
Object.defineProperty(dom.window, 'ResizeObserver', { value: globalThis.ResizeObserver, configurable: true });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
// Browsers expose live computed styles. JSDOM returns snapshots; preserve the
// browser CSSOM contract so actual Radix Presence can observe state changes.
const computedStyle = dom.window.getComputedStyle.bind(dom.window);
const liveComputedStyle: typeof getComputedStyle = (element, pseudo) => new Proxy(computedStyle(element, pseudo), {
  get(_snapshot, property) {
    const current = computedStyle(element, pseudo);
    const value: unknown = Reflect.get(current, property, current);
    return typeof value === 'function' ? value.bind(current) : value;
  },
});
Object.defineProperty(globalThis, 'getComputedStyle', { value: liveComputedStyle, configurable: true });
Object.defineProperty(dom.window, 'getComputedStyle', { value: liveComputedStyle, configurable: true });
Object.defineProperty(globalThis, 'CSS', { value: { escape: (value: string) => {
  assert.match(value, /^[A-Za-z][A-Za-z0-9_-]*$/u, 'this fixture uses only simple animation identifiers');
  return value;
} }, configurable: true });
const styles = document.createElement('style');
styles.textContent = '.heldMenu { animation-name: heldEnter; animation-duration: 1s; }\n'
  + '.heldMenu[data-state="closed"] { animation-name: heldExit; }\n'
  + '[data-slot="dialog-content"][data-state="closed"] { animation-name: heldDialogExit; animation-duration: 1s; }';
document.head.append(styles);

type Entry = 'direct' | 'menu-first' | 'menu-last';
type Action = 'insert' | 'cancel' | 'destroy' | 'replace';

async function runFocusAcceptance() {
  const { render, screen, fireEvent, cleanup, act, waitFor } = await import('@testing-library/react');
  const { richMarkdownCodecExtensions } = await import('../app/lib/markdown/rich-markdown-codec');
  const { createEditorRangeTarget } = await import('../app/lib/editor/interaction-target');
  const { MarkdownInsertDialog } = await import('../app/components/editor/MarkdownInsertDialog');
  const { useMenuDialogFocusHandoff } = await import('../app/lib/editor/use-menu-dialog-focus-handoff');
  const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } = await import('../components/ui/dropdown-menu');
  const animateEnd = (element: HTMLElement, animationName: string) => {
    const event = new dom.window.Event('animationend', { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: animationName });
    fireEvent(element, event);
  };
  const failures: unknown[] = [];
  async function scenario(entry: Entry, action: Action) {
    console.log(`BEGIN actual focus lifecycle: ${entry}/${action}`);
    const host = document.createElement('div'), replacementHost = document.createElement('div');
    document.body.append(host, replacementHost);
    const editor = new Editor({ element: host, extensions: richMarkdownCodecExtensions(), content: '', contentType: 'markdown' });
    const replacement = new Editor({ element: replacementHost, extensions: richMarkdownCodecExtensions(), content: 'Foreign document', contentType: 'markdown' });
    await waitFor(() => assert.equal(editor.isInitialized && replacement.isInitialized, true,
      'both real Tiptap create lifecycles completed before capturing a target'));
    // JSDOM does not implement contenteditable focusability. A tab index supplies
    // that browser behavior without changing the actual Tiptap view or focus API.
    editor.view.dom.tabIndex = 0; replacement.view.dom.tabIndex = 0;
    editor.view.focus();
    assert.equal(document.activeElement === editor.view.dom, true, 'the actual mounted editor is focusable before opening a dialog');
    const target = createEditorRangeTarget(editor); assert(target);
    let closes = 0, foreignFocuses = 0, dialogCloseEvents = 0;
    const foreignDocument = replacement.getJSON();
    replacement.view.dom.addEventListener('focus', () => { foreignFocuses++; });
    function FocusOwner({ currentEditor }: { currentEditor: Editor }) {
      const [open, setOpen] = React.useState(entry === 'direct');
      const menuFocus = useMenuDialogFocusHandoff();
      return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        {entry !== 'direct' ? <DropdownMenu onOpenChange={menuFocus.onOpenChange}>
          <DropdownMenuTrigger>Open Markdown insert menu</DropdownMenuTrigger>
          <DropdownMenuContent className="heldMenu" onCloseAutoFocus={menuFocus.onCloseAutoFocus}>
            <DropdownMenuItem onSelect={() => menuFocus.openDialog(() => setOpen(true))}>Insert Markdown dialog</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu> : null}
        {open ? <MarkdownInsertDialog editor={currentEditor} target={target} frontmatter="metadata" readOnly={false}
          onClose={() => { closes++; setOpen(false); }} /> : null}
      </NextIntlClientProvider>;
    }
    const view = render(<FocusOwner currentEditor={editor} />);
    let heldMenu: HTMLElement | null = null;
    let menuCloseEvents = 0;
    try {
      assert(editor.view.dom.isConnected && replacement.view.dom.isConnected);
      if (entry !== 'direct') {
        const trigger = screen.getByRole('button', { name: 'Open Markdown insert menu' });
        trigger.focus(); fireEvent.keyDown(trigger, { key: 'Enter' });
        const item = await screen.findByRole('menuitem', { name: 'Insert Markdown dialog' });
        heldMenu = item.closest<HTMLElement>('[role="menu"]'); assert(heldMenu);
        heldMenu.addEventListener('focusScope.autoFocusOnUnmount', () => { menuCloseEvents++; });
        fireEvent.click(item);
        assert.equal(heldMenu.dataset.state, 'closed');
        assert(heldMenu.isConnected, 'actual Radix Presence retains the closing menu across dialog opening');
      }
      const dialog = await screen.findByRole('dialog');
      dialog.addEventListener('focusScope.autoFocusOnUnmount', () => { dialogCloseEvents++; });
      const textbox = screen.getByRole('textbox', { name: 'Markdown' });
      await waitFor(() => assert.equal(document.activeElement === textbox, true, 'the real dialog owns initial focus'));
      if (entry === 'menu-first') {
        animateEnd(heldMenu!, 'heldExit');
        await waitFor(() => assert.equal(menuCloseEvents, 1));
      }
      if (action === 'insert') fireEvent.change(textbox, { target: { value: '# Focused import\n\n**Native body**' } });
      if (action === 'destroy') await act(async () => editor.destroy());
      if (action === 'replace') view.rerender(<FocusOwner currentEditor={replacement} />);
      const button = screen.getByRole('button', { name: action === 'insert' ? 'Insert' : 'Cancel' });
      assert.equal((button as HTMLButtonElement).disabled, false, 'the actual dialog action is enabled');
      button.focus(); fireEvent.click(button);
      console.log(JSON.stringify({ entry, action, closesAfterClick: closes, dialogConnectedAfterClick: dialog.isConnected,
        alertAfterClick: screen.queryByRole('alert')?.textContent ?? null }));
      // A component that follows the controlled close lifecycle remains present
      // until its real animation end; an immediate parent unmount is also observed.
      if (dialog.isConnected && dialog.dataset.state === 'closed') animateEnd(dialog, 'heldDialogExit');
      await waitFor(() => assert.equal(dialogCloseEvents, 1, 'the actual Radix dialog unmount autofocus event occurred'));
      await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
      assert.equal(closes, 1);
      if (entry === 'menu-last') {
        assert(heldMenu!.isConnected, 'the old closing menu survives insertion and dialog close');
        animateEnd(heldMenu!, 'heldExit');
        await waitFor(() => assert.equal(menuCloseEvents, 1));
      }
      if (action === 'insert' || action === 'cancel') {
        await waitFor(() => assert.equal(document.activeElement === editor.view.dom, true,
          `final focus belongs to the original editor; actual=${document.activeElement?.outerHTML.slice(0, 240)}`));
        if (action === 'insert') {
          assert.equal(editor.state.doc.firstChild?.type.name, 'heading');
          assert(editor.state.doc.textContent.includes('Native body'));
        } else assert.equal(editor.state.doc.textContent, '');
      } else {
        assert.equal(foreignFocuses, 0, 'the stale dialog cannot focus the replacement editor');
        assert.equal(document.activeElement !== replacement.view.dom, true);
        assert.deepEqual(replacement.getJSON(), foreignDocument);
      }
      if (entry === 'menu-last' && (action === 'insert' || action === 'cancel')) {
        const trigger = screen.getByRole('button', { name: 'Open Markdown insert menu' });
        trigger.focus(); fireEvent.keyDown(trigger, { key: 'Enter' });
        const item = await screen.findByRole('menuitem', { name: 'Insert Markdown dialog' });
        const reopened = item.closest<HTMLElement>('[role="menu"]'); assert(reopened);
        let reopenedCloses = 0;
        reopened.addEventListener('focusScope.autoFocusOnUnmount', () => { reopenedCloses++; });
        fireEvent.keyDown(item, { key: 'Escape' });
        assert.equal(reopened.dataset.state, 'closed');
        animateEnd(reopened, 'heldExit');
        await waitFor(() => assert.equal(reopenedCloses, 1));
        await waitFor(() => assert.equal(document.activeElement === trigger, true,
          'ordinary Escape after a prior dialog handoff returns focus to the menu trigger'));
        console.log(`PASS actual handoff reopen/Escape: ${action}`);
      }
      console.log(`PASS actual focus lifecycle: ${entry}/${action}`);
    } finally {
      if (heldMenu?.isConnected) animateEnd(heldMenu, 'heldExit');
      cleanup();
      if (!editor.isDestroyed) editor.destroy();
      replacement.destroy(); host.remove(); replacementHost.remove();
    }
  }
  async function defaultMenuScenario(action: 'escape' | 'throw') {
    const ownFailure = new Error('Own synchronous dialog-open failure');
    let caught: unknown;
    function DefaultMenuOwner() {
      const menuFocus = useMenuDialogFocusHandoff();
      return <DropdownMenu onOpenChange={menuFocus.onOpenChange}>
        <DropdownMenuTrigger>Ordinary menu</DropdownMenuTrigger>
        <DropdownMenuContent className="heldMenu" onCloseAutoFocus={menuFocus.onCloseAutoFocus}>
          <DropdownMenuItem onSelect={() => {
            try { menuFocus.openDialog(() => { throw ownFailure; }); }
            catch (error) { caught = error; }
          }}>Fail opening dialog</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>;
    }
    render(<DefaultMenuOwner />);
    let menu: HTMLElement | null = null;
    try {
      const trigger = screen.getByRole('button', { name: 'Ordinary menu' });
      trigger.focus(); fireEvent.keyDown(trigger, { key: 'Enter' });
      const item = await screen.findByRole('menuitem', { name: 'Fail opening dialog' });
      menu = item.closest<HTMLElement>('[role="menu"]'); assert(menu);
      let closeEvents = 0;
      menu.addEventListener('focusScope.autoFocusOnUnmount', () => { closeEvents++; });
      if (action === 'escape') fireEvent.keyDown(item, { key: 'Escape' });
      else fireEvent.click(item);
      assert.equal(menu.dataset.state, 'closed');
      animateEnd(menu, 'heldExit');
      await waitFor(() => assert.equal(closeEvents, 1));
      await waitFor(() => assert.equal(document.activeElement === trigger, true,
        'a menu without a successful handoff retains its default focus return'));
      if (action === 'throw') assert.equal(caught === ownFailure, true, 'the actual hook rethrows the original callback error');
      console.log(`PASS actual default menu lifecycle: ${action}`);
    } finally {
      if (menu?.isConnected) animateEnd(menu, 'heldExit');
      cleanup();
    }
  }
  try {
    const selectedCase = process.argv[2];
    if (selectedCase) assert.match(selectedCase, /^(?:direct|menu-first|menu-last)\/(?:insert|cancel|destroy|replace)$/u);
    for (const entry of ['direct', 'menu-first', 'menu-last'] as const) {
      for (const action of ['insert', 'cancel', 'destroy', 'replace'] as const) {
        if (selectedCase && selectedCase !== `${entry}/${action}`) continue;
        try { await scenario(entry, action); }
        catch (error) {
          console.error(`FAIL actual focus lifecycle: ${entry}/${action}`);
          const bounded = error instanceof Error ? { name: error.name, message: error.message.split('\n')[0] } : { name: typeof error, message: 'Unknown thrown value' };
          console.error(JSON.stringify(bounded));
          failures.push(new Error(`${entry}/${action}: ${bounded.name}: ${bounded.message}`));
        }
      }
    }
    if (!selectedCase) {
      for (const action of ['escape', 'throw'] as const) {
        try { await defaultMenuScenario(action); }
        catch (error) {
          const bounded = error instanceof Error ? { name: error.name, message: error.message.split('\n')[0] } : { name: typeof error, message: 'Unknown thrown value' };
          console.error(`FAIL actual default menu lifecycle: ${action}`, JSON.stringify(bounded));
          failures.push(new Error(`default/${action}: ${bounded.name}: ${bounded.message}`));
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Actual Markdown dialog focus lifecycle failed.');
    console.log(`Markdown dialog focus lifecycle: ${selectedCase ? 'one selected diagnostic case' : '14 cases plus two handoff reopen/Escape checks'} passed; actual production hook/parent/Radix/mounted Tiptap, no fake timers or product mocks.`);
  } finally { cleanup(); styles.remove(); dom.window.close(); }
}

void runFocusAcceptance().catch(error => { console.error(error); process.exitCode = 1; });
