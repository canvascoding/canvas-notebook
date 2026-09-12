import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { CollaborationCaretLayout } from '../app/lib/editor/collaboration-caret-layout';

test('caret layout releases observers, viewport listeners and queued frames on view replacement and close', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'getComputedStyle'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  const win = dom.window;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  win.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  win.cancelAnimationFrame = (id) => { frames.delete(id); };
  const observers = new Set<object>();
  Object.defineProperty(win, 'ResizeObserver', { value: class {
    constructor() { observers.add(this); }
    observe() {}
    disconnect() { observers.delete(this); }
  } });
  const visualViewport = new win.EventTarget();
  Object.defineProperty(win, 'visualViewport', { value: visualViewport });
  const listeners = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
  const add = win.EventTarget.prototype.addEventListener;
  const remove = win.EventTarget.prototype.removeEventListener;
  win.EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (callback && ['resize', 'scroll', 'pointerover'].includes(type)) {
      if (!listeners.has(this)) listeners.set(this, new Map());
      const target = listeners.get(this)!;
      if (!target.has(type)) target.set(type, new Set());
      target.get(type)!.add(callback);
    }
    add.call(this, type, callback, options);
  };
  win.EventTarget.prototype.removeEventListener = function (type, callback, options) {
    if (callback) listeners.get(this)?.get(type)?.delete(callback);
    remove.call(this, type, callback, options);
  };
  const count = () => [...listeners.values()].reduce((total, events) => (
    total + [...events.values()].reduce((size, callbacks) => size + callbacks.size, 0)
  ), 0);
  const editor = new Editor({ extensions: [StarterKit, CollaborationCaretLayout], content: '<p>Keep this document</p>' });
  try {
    const baseline = count();
    assert.equal(baseline, 5, 'one listener for each document/window/visual-viewport/pointer event');
    assert.equal(observers.size, 1);
    for (let i = 0; i < 3; i += 1) {
      editor.registerPlugin(new Plugin({ key: new PluginKey(`layout-remount-${i}`) }));
      assert.equal(count(), baseline, 'view replacement must replace, not accumulate listeners');
      assert.equal(observers.size, 1);
      assert.equal(frames.size, 1, 'only the new view owns a queued frame');
    }
    win.dispatchEvent(new win.Event('resize'));
    visualViewport.dispatchEvent(new win.Event('scroll'));
    win.document.dispatchEvent(new win.Event('scroll'));
    assert.equal(frames.size, 1, 'simultaneous layout events are coalesced');
    const staleFrame = [...frames.values()][0];
    editor.destroy();
    assert.equal(count(), 0);
    assert.equal(observers.size, 0);
    assert.equal(frames.size, 0);
    win.dispatchEvent(new win.Event('resize'));
    visualViewport.dispatchEvent(new win.Event('resize'));
    assert.equal(frames.size, 0, 'closed views must not schedule work');
    assert.doesNotThrow(() => staleFrame(0), 'a callback already dispatched before close stays harmless');
  } finally {
    if (!editor.isDestroyed) editor.destroy();
    dom.window.close();
  }
});
