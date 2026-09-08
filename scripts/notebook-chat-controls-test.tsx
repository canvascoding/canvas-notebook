import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { initialNotebookLayoutState, notebookLayoutReducer, type NotebookViewport } from '../app/lib/notebook/layout-state';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

async function main() {
  const { NotebookChatControls } = await import('../app/components/notebook/NotebookChatControls');
  const root = createRoot(document.getElementById('root')!);
  function Harness({ viewport }: { viewport: NotebookViewport }) {
    const [state, dispatch] = useReducer(notebookLayoutReducer, {
      ...initialNotebookLayoutState, viewport, documentAvailable: true,
      mainSurface: 'document', lastWorkSurface: 'document',
    });
    return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <NotebookChatControls full={state.mainSurface === 'chat'} docked={state.chatDocked}
        canDock={viewport === 'desktop-wide'} mobile={viewport === 'mobile'} controlsId="chat-panel"
        onShow={() => dispatch({ type: 'SHOW_CHAT' })}
        onToggleDock={() => dispatch({ type: 'SET_CHAT_DOCKED', docked: !state.chatDocked })} />
      <div id="chat-panel" role="region" aria-labelledby="notebook-chat-button" />
      <output>{state.mainSurface}</output>
    </NextIntlClientProvider>;
  }
  const full = () => document.querySelector<HTMLButtonElement>('[data-testid="notebook-surface-chat"]')!;
  const side = () => document.querySelector<HTMLButtonElement>('[data-testid="notebook-chat-dock"]')!;
  await act(async () => root.render(<Harness key="wide" viewport="desktop-wide" />));
  assert.equal(full().getAttribute('aria-pressed'), 'false');
  assert.equal(side().getAttribute('aria-pressed'), 'false');
  assert.equal(full().closest('[role="tablist"]'), null, 'chat is a separate control, not a document tab');
  assert.equal(document.getElementById(full().getAttribute('aria-controls')!)?.getAttribute('aria-labelledby'), full().id);
  await act(async () => side().click());
  assert.equal(side().getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('output')?.textContent, 'document');
  await act(async () => full().click());
  assert.equal(full().getAttribute('aria-pressed'), 'true');
  assert.equal(side().getAttribute('aria-pressed'), 'false');
  await act(async () => full().click());
  assert.equal(document.querySelector('output')?.textContent, 'chat', 'the full chat button is idempotent');
  await act(async () => side().click());
  assert.equal(document.querySelector('output')?.textContent, 'document', 'docking restores the last document');
  await act(async () => side().click());
  assert.equal(side().getAttribute('aria-pressed'), 'false');
  assert.equal(full().getAttribute('aria-pressed'), 'false');
  await act(async () => root.render(<Harness key="compact" viewport="desktop-compact" />));
  assert.equal(side().disabled, true);
  await act(async () => side().click());
  assert.equal(document.querySelector('output')?.textContent, 'document');
  await act(async () => full().click());
  assert.equal(document.querySelector('output')?.textContent, 'chat');
  await act(async () => root.render(<Harness key="mobile" viewport="mobile" />));
  assert.equal(side(), null, 'mobile keeps the main chat button without an unavailable split control');
  assert.equal(full().disabled, false);
  await act(async () => root.unmount());
  console.log('notebook-chat-controls-test: ok');
}
void main();
