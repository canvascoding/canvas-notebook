import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  captureChatScrollAnchor,
  restoreChatScrollAnchor,
} from '../app/lib/chat/scroll-anchor';

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 320,
    width: 320,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function main(): void {
  const dom = new JSDOM(`
    <div id="container">
      <div id="content">
        <div id="above"></div>
        <div id="visible"></div>
        <div id="below"></div>
      </div>
    </div>
  `);
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: dom.window.HTMLElement,
  });

  const container = dom.window.document.getElementById('container') as HTMLElement;
  const content = dom.window.document.getElementById('content') as HTMLElement;
  const above = dom.window.document.getElementById('above') as HTMLElement;
  const visible = dom.window.document.getElementById('visible') as HTMLElement;
  const below = dom.window.document.getElementById('below') as HTMLElement;

  container.getBoundingClientRect = () => rect(100, 500);
  above.getBoundingClientRect = () => rect(20, 90);
  let visibleTop = 120;
  visible.getBoundingClientRect = () => rect(visibleTop, visibleTop + 80);
  below.getBoundingClientRect = () => rect(220, 300);

  const anchor = captureChatScrollAnchor(container, content);
  assert.equal(anchor?.element, visible, 'the first visible message should become the anchor');
  assert.equal(anchor?.top, 120);

  container.scrollTop = 240;
  visibleTop = 170;
  assert.equal(restoreChatScrollAnchor(container, content, anchor), true);
  assert.equal(container.scrollTop, 290, 'the scroll offset should absorb layout growth above the anchor');

  visibleTop = 170.2;
  const stableAnchor = captureChatScrollAnchor(container, content);
  visibleTop = 170.4;
  assert.equal(restoreChatScrollAnchor(container, content, stableAnchor), false);
  assert.equal(container.scrollTop, 290, 'sub-pixel layout noise should not move the viewport');

  visible.remove();
  assert.equal(restoreChatScrollAnchor(container, content, anchor), false);
  assert.equal(container.scrollTop, 290, 'a removed anchor must not change the viewport');

  console.log('chat-scroll-anchor-test: ok');
}

main();
