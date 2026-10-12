import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createMobileEditorViewport, mobileCaretScrollDelta } from '../app/lib/editor/mobile-editor-viewport';

test('a visible caret stays where the user put it; hidden carets retain surrounding context', () => {
  const visible = { top: 100, bottom: 400 };
  assert.equal(mobileCaretScrollDelta({ top: 101, bottom: 121 }, visible), 0);
  assert.equal(mobileCaretScrollDelta({ top: 375, bottom: 395 }, visible), 0);
  assert.equal(mobileCaretScrollDelta({ top: 395, bottom: 415 }, visible), 27);
  assert.equal(mobileCaretScrollDelta({ top: 85, bottom: 105 }, visible), -63);
  assert.equal(mobileCaretScrollDelta({ top: 80, bottom: 420 }, visible), 0, 'large selected blocks need not jump to their start');
  assert.equal(mobileCaretScrollDelta({ top: 20, bottom: 40 }, { top: 100, bottom: 100 }), 0);
});

function harness() {
  const dom = new JSDOM('<div id="pane"><div id="scroll"><div id="content" tabindex="0">Draft</div></div></div>', { pretendToBeVisual: true });
  const win = dom.window;
  const pane = win.document.getElementById('pane')!;
  const scroller = win.document.getElementById('scroll')!;
  const content = win.document.getElementById('content')!;
  const viewport = Object.assign(new win.EventTarget(), { offsetTop: 100, height: 400, scale: 1 });
  Object.defineProperty(win, 'visualViewport', { value: viewport });
  const media = Object.assign(new win.EventTarget(), { matches: true });
  Object.defineProperty(win, 'matchMedia', { value: () => media });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  win.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  win.cancelAnimationFrame = id => { frames.delete(id); };
  win.scrollBy = () => { throw new Error('Window scrolling must not be used'); };
  pane.getBoundingClientRect = () => new win.DOMRect(0, 80, 390, 700);
  scroller.getBoundingClientRect = () => new win.DOMRect(0, 80, 390,
    680 - Number.parseFloat(pane.style.getPropertyValue('--canvas-editor-keyboard-inset') || '0'));
  scroller.scrollTop = 300;
  const state = { composing: false, caret: { top: 400, bottom: 420, left: 20, right: 20 } };
  content.focus();
  const controller = createMobileEditorViewport({ pane, scroller, content,
    readCaret: () => ({ ...state.caret, top: state.caret.top - (scroller.scrollTop - 300), bottom: state.caret.bottom - (scroller.scrollTop - 300) }),
    isComposing: () => state.composing });
  const flush = () => { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(0)); };
  flush();
  return { win, pane, scroller, content, viewport, media, state, controller, frames, flush,
    destroy() { controller.destroy(); win.close(); } };
}

test('keyboard inset uses the panned visible bottom and only reveals an obscured caret', () => {
  const h = harness();
  try {
    assert.equal(h.pane.style.getPropertyValue('--canvas-editor-keyboard-inset'), '280px');
    assert.equal(h.controller.scrollToCaret(), true);
    assert.equal(h.scroller.scrollTop, 300);
    h.state.caret = { top: 500, bottom: 520, left: 20, right: 20 };
    h.controller.scrollToCaret();
    assert.equal(h.scroller.scrollTop, 352);
    assert.equal(h.win.document.activeElement, h.content);
    assert.equal(h.content.textContent, 'Draft');
  } finally { h.destroy(); }
});

test('rendered toolbar overlap is reserved without estimating its iOS offset', () => {
  const h = harness();
  try {
    const toolbar = h.win.document.createElement('div');
    toolbar.className = 'tiptap-mobile-toolbar-visible';
    toolbar.getBoundingClientRect = () => new h.win.DOMRect(8, 430, 374, 40);
    h.win.document.body.append(toolbar);
    h.state.caret = { top: 380, bottom: 400, left: 20, right: 20 };
    h.controller.scrollToCaret();
    assert.equal(h.scroller.scrollTop, 300, 'caret fits above the actual toolbar');
    assert.equal(h.pane.style.getPropertyValue('--canvas-editor-keyboard-inset'), '358px', 'toolbar space remains scrollable at EOF');
    h.state.caret = { top: 420, bottom: 440, left: 20, right: 20 };
    h.controller.scrollToCaret();
    assert.equal(h.scroller.scrollTop, 350, 'reveal below the toolbar only needs its overlap plus breathing room');
  } finally { h.destroy(); }
});

test('manual scrolling and visual viewport panning do not pull the view back to the caret', () => {
  const h = harness();
  try {
    h.scroller.scrollTop = 100;
    h.scroller.dispatchEvent(new h.win.Event('scroll'));
    h.viewport.dispatchEvent(new h.win.Event('scroll')); h.flush();
    assert.equal(h.scroller.scrollTop, 100);
    h.content.dispatchEvent(new h.win.Event('input'));
    h.scroller.dispatchEvent(new h.win.Event('touchmove')); h.flush();
    assert.equal(h.scroller.scrollTop, 100, 'a new scroll gesture cancels an obsolete pending caret reveal');
    h.content.dispatchEvent(new h.win.Event('input')); h.flush();
    assert.equal(h.scroller.scrollTop, 252, 'writing now reveals the caret with a bounded correction');
  } finally { h.destroy(); }
});

test('composition, zoom, blur, desktop and teardown keep their respective owners', () => {
  const h = harness();
  try {
    h.state.caret = { top: 500, bottom: 520, left: 20, right: 20 };
    h.state.composing = true;
    assert.equal(h.controller.scrollToCaret(), true);
    assert.equal(h.scroller.scrollTop, 300);
    h.state.composing = false;
    h.content.dispatchEvent(new h.win.Event('compositionend')); h.flush();
    assert.equal(h.scroller.scrollTop, 352);
    h.viewport.scale = 1.5; h.viewport.dispatchEvent(new h.win.Event('resize')); h.flush();
    assert.equal(h.pane.style.getPropertyValue('--canvas-editor-keyboard-inset'), '0px');
    assert.equal(h.controller.scrollToCaret(), false);
    h.viewport.scale = 1; h.media.matches = false;
    assert.equal(h.controller.scrollToCaret(), false);
    h.media.matches = true; h.content.blur(); h.flush();
    assert.equal(h.pane.style.getPropertyValue('--canvas-editor-keyboard-inset'), '0px');
    h.content.focus();
    assert.equal(h.frames.size, 1);
    h.controller.destroy(); h.flush();
    assert.equal(h.frames.size, 0);
    assert.equal(h.pane.style.getPropertyValue('--canvas-editor-keyboard-inset'), '');
    assert.equal(h.controller.scrollToCaret(), false);
  } finally { h.destroy(); }
});
