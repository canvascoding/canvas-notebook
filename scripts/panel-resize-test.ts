import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ResizeHandle,
  clampPanelResizeValue,
  getKeyboardPanelResizeValue,
} from '../app/components/layout/ResizeHandle';

assert.equal(clampPanelResizeValue(100, 220, 400), 220);
assert.equal(clampPanelResizeValue(300, 220, 400), 300);
assert.equal(clampPanelResizeValue(500, 220, 400), 400);
assert.equal(clampPanelResizeValue(300, 400, 220), 400);

assert.equal(getKeyboardPanelResizeValue({
  key: 'ArrowRight',
  orientation: 'vertical',
  value: 280,
  minimum: 220,
  maximum: 400,
}), 290);
assert.equal(getKeyboardPanelResizeValue({
  key: 'ArrowLeft',
  orientation: 'vertical',
  direction: -1,
  value: 420,
  minimum: 390,
  maximum: 600,
}), 430);
assert.equal(getKeyboardPanelResizeValue({
  key: 'ArrowUp',
  orientation: 'horizontal',
  direction: -1,
  value: 260,
  minimum: 84,
  maximum: 420,
}), 270);
assert.equal(getKeyboardPanelResizeValue({
  key: 'ArrowDown',
  orientation: 'horizontal',
  direction: -1,
  value: 260,
  minimum: 84,
  maximum: 420,
  useLargeStep: true,
}), 220);
assert.equal(getKeyboardPanelResizeValue({
  key: 'Home',
  orientation: 'vertical',
  value: 300,
  minimum: 220,
  maximum: 400,
}), 220);
assert.equal(getKeyboardPanelResizeValue({
  key: 'End',
  orientation: 'vertical',
  value: 300,
  minimum: 220,
  maximum: 400,
}), 400);
assert.equal(getKeyboardPanelResizeValue({
  key: 'Enter',
  orientation: 'vertical',
  value: 300,
  minimum: 220,
  maximum: 400,
}), null);

const verticalMarkup = renderToStaticMarkup(createElement(ResizeHandle, {
  orientation: 'vertical',
  label: 'Resize Bradley chat',
  controls: 'chat-panel',
  min: 300,
  max: 600,
  value: 420,
  resizing: true,
}));

assert.match(verticalMarkup, /role="separator"/);
assert.match(verticalMarkup, /tabindex="0"/);
assert.match(verticalMarkup, /aria-label="Resize Bradley chat"/);
assert.match(verticalMarkup, /aria-controls="chat-panel"/);
assert.match(verticalMarkup, /aria-orientation="vertical"/);
assert.match(verticalMarkup, /aria-valuemin="300"/);
assert.match(verticalMarkup, /aria-valuemax="600"/);
assert.match(verticalMarkup, /aria-valuenow="420"/);
assert.match(verticalMarkup, /data-resizing="true"/);
assert.match(verticalMarkup, /w-px/);
assert.match(verticalMarkup, /before:w-3/);
assert.doesNotMatch(verticalMarkup, /hover:w-/);

const horizontalMarkup = renderToStaticMarkup(createElement(ResizeHandle, {
  orientation: 'horizontal',
  label: 'Resize terminal',
  min: 84,
  max: 420,
  value: 260,
}));

assert.match(horizontalMarkup, /aria-orientation="horizontal"/);
assert.match(horizontalMarkup, /h-px/);
assert.match(horizontalMarkup, /before:h-3/);
assert.doesNotMatch(horizontalMarkup, /hover:h-/);

console.log('Panel resize tests passed');
