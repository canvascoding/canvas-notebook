import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NodeViewRenderer } from '@tiptap/core';
import { JSDOM } from 'jsdom';
import { withStableNodeViewMount } from '../app/lib/editor/stable-node-view';

test('React content relocation is ignored while actual input still reaches the node view', () => {
  const window = new JSDOM('<!doctype html><body></body>').window;
  Object.defineProperty(globalThis, 'HTMLElement', { value: window.HTMLElement, configurable: true });
  const { document } = window;
  const dom = document.createElement('div');
  const contentDOM = document.createElement('div');
  dom.append(contentDOM);
  const observed = new window.MutationObserver(() => {});
  observed.observe(dom, { subtree: true, childList: true, characterData: true, attributes: true });
  let delegated = 0;
  const nodeView = { dom, contentDOM, ignoreMutation() { delegated++; return false; } };
  const renderer = withStableNodeViewMount(() => nodeView);
  const view = renderer({} as Parameters<NodeViewRenderer>[0]);

  const shell = document.createElement('div');
  shell.setAttribute('data-node-view-wrapper', '');
  const target = document.createElement('div');
  shell.append(target);
  dom.append(shell);
  target.append(contentDOM);
  const mount = observed.takeRecords();
  assert.equal(mount.length, 3);
  for (const mutation of mount) assert.equal(view.ignoreMutation!(mutation), true);
  assert.equal(delegated, 0);

  contentDOM.textContent = 'typed';
  contentDOM.firstChild!.textContent = 'typed\nnext';
  // Real mobile Enter may alter a wrapper outside contentDOM; it must still
  // reach Tiptap's mobile workaround, as must selection/composition input.
  target.append(document.createElement('br'));
  shell.setAttribute('class', 'changed');
  const input = observed.takeRecords();
  for (const mutation of input) assert.equal(view.ignoreMutation!(mutation), false);
  assert.equal(view.ignoreMutation!({ type: 'selection', target: contentDOM }), false);
  assert.equal(delegated, input.length + 1);
  observed.disconnect();
  window.close();
});
