import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { JSONContent } from '@tiptap/core';
import {
  agentPreviewAttributeChanges, agentPreviewChanges, canDisplayAgentReviewTarget,
  parseAgentPreviewBlocks, renderAgentPreviewBlocks, type AgentReviewTarget,
} from '../app/lib/collaboration/agent-proposal-display';
import { CollaborationAgentProposalPreview } from '../app/components/editor/CollaborationAgentProposalPreview';

const text = (value: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const p = (value: string, attrs: Record<string, unknown> = {}): JSONContent => ({ type: 'paragraph', attrs: { id: 'secret-block', ...attrs }, content: [text(value)] });
const serialize = (block: JSONContent, beforeId: string | null = null) => JSON.stringify([{ id: 'secret-block', parentId: null, beforeId, block }]);
const target = (before: JSONContent, after: JSONContent): AgentReviewTarget => ({
  targetId: 'secret-target', groupId: 'secret-group', previewFormat: 'blocks',
  currentText: serialize(before), proposedReplacement: serialize(after),
  blockLocations: { before: [{ id: 'secret-block', parent: null, following: null, position: [1] }],
    after: [{ id: 'secret-block', parent: null, following: null, position: [1] }] },
});

async function domTest(action: () => Promise<void> | void) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  try { await action(); } finally {
    dom.window.close(); names.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]!); else Reflect.deleteProperty(globalThis, name);
    });
  }
}

async function render(value: AgentReviewTarget) {
  const root = createRoot(document.getElementById('root')!); const ready: boolean[] = [];
  const t = ((key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${JSON.stringify(values)}` : ''}`) as Parameters<typeof CollaborationAgentProposalPreview>[0]['t'];
  await act(async () => root.render(<CollaborationAgentProposalPreview target={value} index={0} t={t} onReady={(_target, state) => ready.push(state)} />));
  return { ready, close: () => act(async () => root.unmount()) };
}

test('the actual heading, inline formatting, line break, list and table are rendered without internal ids', () => domTest(async () => {
  const after: JSONContent = { type: 'blockquote', attrs: { id: 'secret-block' }, content: [
    { type: 'heading', attrs: { level: 2 }, content: [text('Formatted', [{ type: 'bold' }]), { type: 'hardBreak' }, text('Heading')] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [p('List item')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableHeader', attrs: { textAlign: 'right' }, content: [p('Heading cell')] },
      { type: 'tableCell', content: [p('Value')] },
    ] }] },
  ] };
  const h = await render(target(p('Before'), after));
  try {
    assert.ok(document.querySelector('h2 strong')); assert.ok(document.querySelector('h2 br'));
    assert.ok(document.querySelector('ul li')); assert.ok(document.querySelector('table th'));
    assert.doesNotMatch(document.body.innerHTML, /secret-target|secret-group|secret-block/u);
    assert.equal(h.ready.at(-1), true);
  } finally { await h.close(); }
}));

test('move semantics include actual source and destination even when content is identical', () => domTest(async () => {
  const value = target(p('Moved paragraph'), p('Moved paragraph'));
  value.currentText = serialize(p('Moved paragraph'), 'secret-next');
  value.blockLocations!.before[0].following = { type: 'heading', text: 'Destination heading', truncated: false, position: [2] };
  value.blockLocations!.after[0].position = [3];
  assert.deepEqual(agentPreviewChanges(value)[0].kinds, ['moved']);
  const h = await render(value);
  try {
    assert.match(document.body.textContent ?? '', /agentPreviewChange_moved/u);
    assert.match(document.body.textContent ?? '', /Destination heading/u);
    assert.match(document.body.textContent ?? '', /agentPreviewAtEnd/u);
    assert.doesNotMatch(document.body.textContent ?? '', /secret-next/u);
  } finally { await h.close(); }
}));

test('format-only attributes and task state remain visible and task controls are inert', () => domTest(async () => {
  const before = { type: 'taskList', attrs: { id: 'secret-block' }, content: [{ type: 'taskItem', attrs: { id: 'item', checked: false }, content: [p('Task')] }] };
  const after = structuredClone(before); after.content[0].attrs.checked = true;
  const value = target(before, after);
  assert.equal(agentPreviewAttributeChanges(value)[0].key, 'checked');
  const h = await render(value);
  try {
    const boxes = [...document.querySelectorAll('input')]; assert.equal(boxes.length, 2);
    assert.equal(boxes[0].checked, false); assert.equal(boxes[1].checked, true);
    assert.ok(boxes.every((box) => box.disabled));
    assert.match(document.body.textContent ?? '', /agentPreviewProperty_checked/u);
  } finally { await h.close(); }
}));

test('links crossing marks keep each exact destination while links and images cannot request anything', () => domTest(() => {
  const link = (href: string) => ({ type: 'link', attrs: { href } });
  const node: JSONContent = { type: 'paragraph', content: [
    text('one', [link('https://first.test/path')]), text('bold', [{ type: 'bold' }, link('https://first.test/path')]),
    text('two', [link('https://second.test/path')]), text('<script>literal</script>'),
  ] };
  const rows = parseAgentPreviewBlocks(serialize(node))!;
  rows.push({ id: 'image', parentId: null, beforeId: null, block: { type: 'image', attrs: {
    src: 'https://tracking.test/image.png', alt: 'Descriptive image', width: 200, align: 'right',
  } } });
  const html = renderAgentPreviewBlocks(rows, { image: 'Image', link: 'Destination' });
  document.getElementById('root')!.innerHTML = html;
  assert.equal(document.querySelectorAll('[href], [src], [srcset], img, script').length, 0);
  const links = [...document.querySelectorAll('a')]; assert.equal(links.length, 3);
  assert.match(links[0].textContent ?? '', /first\.test/u); assert.match(links[1].textContent ?? '', /first\.test/u);
  assert.match(links[2].textContent ?? '', /second\.test/u);
  assert.match(document.body.textContent ?? '', /tracking\.test\/image\.png/u);
  assert.match(document.body.textContent ?? '', /<script>literal<\/script>/u);
}));

test('callout content, collapsed details content and formulas remain visible in review', () => domTest(() => {
  const node: JSONContent = { type: 'blockquote', content: [
    { type: 'canvasCallout', attrs: { calloutType: 'warning', fold: '-' }, content: [{ type: 'canvasCalloutTitle', content: [text('Careful')] }, p('Callout content')] },
    { type: 'canvasDetails', attrs: { open: false }, content: [{ type: 'canvasDetailsSummary', content: [text('Summary')] },
      { type: 'canvasDetailsContent', content: [p('Never hide this content')] }] },
    { type: 'blockMath', attrs: { latex: 'x^2' } },
  ] };
  const html = renderAgentPreviewBlocks(parseAgentPreviewBlocks(serialize(node))!, { image: 'Image', link: 'Link' });
  document.getElementById('root')!.innerHTML = html;
  assert.match(document.body.textContent ?? '', /Careful|Callout content/u);
  assert.equal(document.querySelector('details')!.open, true);
  assert.match(document.body.textContent ?? '', /Never hide this content/u);
  assert.ok(document.querySelector('.katex'));
}));

test('literal JSON text stays literal and incomplete block metadata fails closed', () => domTest(async () => {
  const literal = '[{"id":"authored content","block":{"type":"paragraph"}}]';
  const value: AgentReviewTarget = { targetId: 'internal', groupId: 'internal', previewFormat: 'text', currentText: literal, proposedReplacement: `${literal}\n ` };
  const h = await render(value);
  try { assert.match(document.body.textContent ?? '', /authored content/u); assert.equal(h.ready.at(-1), true); }
  finally { await h.close(); }
  assert.equal(canDisplayAgentReviewTarget({ ...value, previewFormat: undefined }), false);
  assert.equal(canDisplayAgentReviewTarget({ ...value, previewFormat: 'blocks' }), false);
  assert.equal(parseAgentPreviewBlocks(serialize({ type: 'script', content: [text('evil')] })), null);
}));
