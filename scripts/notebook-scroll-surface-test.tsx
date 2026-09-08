import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, StrictMode, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useExplorerScrollAnchor } from '../app/components/file-browser/useExplorerScrollAnchor';

const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element'] as const) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

function Harness({ ready, revision }: { ready: boolean; revision: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useExplorerScrollAnchor(ref, 'workspace/tree', revision);
  return <div id="outer" data-file-scroll-container>{ready && <div id="surface" ref={ref}><div data-file-path="anchor" /></div>}</div>;
}

async function main() {
  const root = createRoot(document.getElementById('root')!);
  const render = (ready: boolean, revision: number) => act(async () => root.render(<StrictMode><Harness ready={ready} revision={revision} /></StrictMode>));
  await render(false, 0);
  await render(true, 0);
  const surface = document.getElementById('surface')!;
  const row = surface.firstElementChild as HTMLElement;
  let logicalTop = 100;
  surface.getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 } as DOMRect);
  row.getBoundingClientRect = () => ({ top: 100 + logicalTop - surface.scrollTop, bottom: 120 + logicalTop - surface.scrollTop, height: 20 } as DOMRect);
  surface.scrollTop = 60;
  surface.dispatchEvent(new dom.window.Event('scroll'));
  logicalTop = 150;
  await render(true, 1);
  assert.equal(surface.scrollTop, 110, 'the late-mounted inner surface preserves the manually scrolled anchor');
  assert.equal(document.getElementById('outer')!.scrollTop, 0, 'the ancestor is never scrolled');
  surface.scrollTop = 125;
  surface.dispatchEvent(new dom.window.Event('scroll'));
  await render(true, 1);
  assert.equal(surface.scrollTop, 125, 'unrelated renders preserve user scrolling');
  await render(false, 1);
  await render(true, 1);
  assert.equal(document.getElementById('surface')!.scrollTop, 0, 'a replacement surface does not inherit an obsolete anchor');
  await act(async () => root.unmount());
  dom.window.close();
  console.log('notebook-scroll-surface-test: ok');
}
main().catch((error) => { console.error(error); dom.window.close(); process.exitCode = 1; });
