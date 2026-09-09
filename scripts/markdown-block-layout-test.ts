import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { blockElementRect, observeBlockControlLayout } from '../app/lib/editor/block-control-layout';
import { createBlockDragAutoscroll } from '../app/lib/editor/block-drag-autoscroll';

function fixture() {
  const dom = new JSDOM('<div id="container"><section><div id="editor"><p>Block</p></div></section></div><div id="other"></div>', { pretendToBeVisual: true });
  const window = dom.window;
  window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
  const container = window.document.querySelector<HTMLElement>('#container')!;
  const editor = window.document.querySelector<HTMLElement>('#editor')!;
  const block = editor.firstElementChild as HTMLElement;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => { frames.delete(id); };
  container.getBoundingClientRect = () => new window.DOMRect(100, 50, 404, 204);
  for (const [key, value] of Object.entries({ clientTop: 2, clientLeft: 2, clientWidth: 400, clientHeight: 200, scrollHeight: 1000 })) {
    Object.defineProperty(container, key, { value, configurable: true });
  }
  return { window, container, editor, block, frames,
    flush(time = 0) { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); },
    destroy() { window.close(); },
  };
}

test('block boxes include border and both scroll offsets; collapsed content has no control box', () => {
  const h = fixture();
  try {
    h.container.scrollTop = 80; h.container.scrollLeft = 30;
    h.block.getBoundingClientRect = () => new h.window.DOMRect(180, 150, 320, 120);
    assert.deepEqual(blockElementRect(h.container, h.block), { left: 108, top: 178, width: 320, height: 120 });
    h.block.getClientRects = () => [] as unknown as DOMRectList;
    assert.equal(blockElementRect(h.container, h.block), null, 'a CSS-hidden node has no rendered boxes');
    Reflect.deleteProperty(h.block, 'getClientRects');
    h.block.hidden = true;
    assert.equal(blockElementRect(h.container, h.block), null);
    h.block.hidden = false;
    const details = h.window.document.createElement('details');
    const summary = h.window.document.createElement('summary');
    const summaryText = h.window.document.createElement('span');
    summary.append(summaryText); details.append(summary, h.block); h.editor.append(details);
    assert.equal(blockElementRect(h.container, h.block), null);
    assert(blockElementRect(h.container, summaryText), 'the summary stays visible');
    assert(blockElementRect(h.container, details), 'the collapsed container itself stays visible');
    details.open = true;
    assert.deepEqual(blockElementRect(h.container, h.block), { left: 108, top: 178, width: 320, height: 120 });
    h.container.hidden = true;
    assert.equal(blockElementRect(h.container, h.block), null);
  } finally { h.destroy(); }
});

test('layout signals coalesce, observe ancestor reflow, ignore overlay writes and end on disposal', async () => {
  const h = fixture();
  const oldMutation = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  const oldResize = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  let resizeCallback = () => {};
  let disconnected = false;
  const observed = new Set<Element>();
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: h.window.MutationObserver });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe(element: Element) { observed.add(element); }
    disconnect() { disconnected = true; }
  } });
  const fonts = new h.window.EventTarget();
  Object.defineProperty(h.window.document, 'fonts', { value: fonts, configurable: true });
  let updates = 0;
  const dispose = observeBlockControlLayout(h.container, h.editor, () => { updates++; });
  try {
    assert.equal(observed.size, 3, 'observe the container, editor and wrapper, not every block');
    resizeCallback();
    h.block.dispatchEvent(new h.window.Event('load'));
    h.block.dispatchEvent(new h.window.Event('toggle'));
    h.container.dispatchEvent(new h.window.Event('scroll'));
    h.window.dispatchEvent(new h.window.Event('resize'));
    fonts.dispatchEvent(new h.window.Event('loadingdone'));
    h.block.textContent = 'Changed';
    await Promise.resolve();
    assert.equal(h.frames.size, 1);
    h.flush(); assert.equal(updates, 1);
    h.editor.parentElement!.className = 'new-page-width';
    await Promise.resolve();
    assert.equal(h.frames.size, 1, 'a wrapper can reposition the editor without changing its size');
    h.flush(); assert.equal(updates, 2);
    const overlay = h.window.document.createElement('div');
    h.container.append(overlay); overlay.style.top = '100px';
    await Promise.resolve();
    assert.equal(h.frames.size, 0, 'our own absolute overlays cannot start a feedback loop');
    h.block.style.height = '160px';
    await Promise.resolve();
    const late = [...h.frames.values()][0];
    assert(late);
    dispose(); assert(disconnected); assert.equal(h.frames.size, 0);
    late(100);
    resizeCallback();
    h.block.dispatchEvent(new h.window.Event('load'));
    fonts.dispatchEvent(new h.window.Event('loadingdone'));
    h.block.textContent = 'After cleanup';
    await Promise.resolve();
    assert.equal(h.frames.size, 0); assert.equal(updates, 2);
  } finally {
    dispose(); h.destroy();
    if (oldMutation) Object.defineProperty(globalThis, 'MutationObserver', oldMutation); else Reflect.deleteProperty(globalThis, 'MutationObserver');
    if (oldResize) Object.defineProperty(globalThis, 'ResizeObserver', oldResize); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});

test('autoscroll uses visible editor edges, elapsed time and exact scroll limits', () => {
  const h = fixture();
  let updates = 0;
  const scroll = createBlockDragAutoscroll(h.container, () => true, () => { updates++; });
  try {
    scroll.update({ clientX: 200, clientY: 150 });
    assert.equal(h.frames.size, 0, 'no work in the middle');
    scroll.update({ clientX: 101, clientY: 252 });
    assert.equal(h.frames.size, 0, 'no work outside the content box');
    scroll.update({ clientX: 200, clientY: 252 });
    h.flush(0); assert.equal(h.container.scrollTop, 10);
    h.flush(1000); assert.equal(h.container.scrollTop, 34, 'a delayed frame is capped at 40ms');
    scroll.stop(); h.container.scrollTop = 799;
    scroll.update({ clientX: 200, clientY: 252 });
    h.flush(2000); assert.equal(h.container.scrollTop, 800);
    const beforeBlocked = updates;
    h.flush(2020); assert.equal(h.frames.size, 0); assert.equal(updates, beforeBlocked);
    scroll.update({ clientX: 200, clientY: 52 });
    h.flush(2040); assert.equal(h.container.scrollTop, 790);
    scroll.stop(); h.container.scrollTop = 0;
    Object.defineProperty(h.window, 'innerHeight', { value: 180, configurable: true });
    scroll.update({ clientX: 200, clientY: 180 });
    h.flush(2100); assert.equal(h.container.scrollTop, 10, 'the clipped viewport edge is the active edge');
    assert.equal(h.window.document.querySelector('#other')!.scrollTop, 0);
    assert.equal(h.window.scrollY, 0, 'the page does not scroll');
  } finally { scroll.destroy(); h.destroy(); }
});

test('permission, visibility, pointer exit and destroyed lifetimes stop even retained animation callbacks', () => {
  const h = fixture();
  let active = true;
  const scroll = createBlockDragAutoscroll(h.container, () => active, () => {});
  const pointer = { clientX: 200, clientY: 252 };
  try {
    scroll.update(pointer);
    active = false; h.flush(); assert.equal(h.container.scrollTop, 0); assert.equal(h.frames.size, 0);
    active = true; scroll.update(pointer);
    const obsolete = [...h.frames.values()][0];
    scroll.stop(); scroll.update(pointer);
    obsolete(100); assert.equal(h.container.scrollTop, 0); assert.equal(h.frames.size, 1);
    h.flush(200); assert.equal(h.container.scrollTop, 10);
    scroll.update(null); assert.equal(h.frames.size, 0);
    scroll.update(pointer);
    Object.defineProperty(h.window.document, 'hidden', { value: true, configurable: true });
    h.flush(300); assert.equal(h.container.scrollTop, 10); assert.equal(h.frames.size, 0);
    Object.defineProperty(h.window.document, 'hidden', { value: false });
    scroll.update(pointer);
    const late = [...h.frames.values()][0];
    scroll.destroy(); late(400); scroll.update(pointer);
    assert.equal(h.frames.size, 0); assert.equal(h.container.scrollTop, 10);
  } finally { scroll.destroy(); h.destroy(); }
});

test('a cancellation during a scroll callback cannot schedule the next frame', () => {
  const h = fixture();
  const scroll = createBlockDragAutoscroll(h.container, () => true, () => { scroll.stop(); });
  try {
    scroll.update({ clientX: 200, clientY: 252 });
    h.flush(); assert.equal(h.container.scrollTop, 10); assert.equal(h.frames.size, 0);
    Object.defineProperty(h.container, 'clientHeight', { value: 0 });
    scroll.update({ clientX: 200, clientY: 52 });
    assert.equal(h.frames.size, 0, 'a hidden/empty viewport has no scrolling work');
  } finally { scroll.destroy(); h.destroy(); }
});
