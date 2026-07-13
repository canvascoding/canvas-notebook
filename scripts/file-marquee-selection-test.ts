import assert from 'node:assert/strict';
import {
  getIntersectingMarqueePaths,
  marqueeRectsIntersect,
  mergeMarqueeSelection,
  normalizeMarqueeRect,
} from '../app/lib/files/marquee-selection';

const selectionRect = normalizeMarqueeRect(
  { x: 120, y: 90 },
  { x: 20, y: 10 },
);

assert.deepEqual(selectionRect, {
  left: 20,
  top: 10,
  right: 120,
  bottom: 90,
});

assert.equal(
  marqueeRectsIntersect(selectionRect, { left: 120, top: 20, right: 160, bottom: 50 }),
  true,
  'touching the marquee edge should include an item',
);
assert.equal(
  marqueeRectsIntersect(selectionRect, { left: 121, top: 20, right: 160, bottom: 50 }),
  false,
  'an item outside the marquee should stay unselected',
);

const intersectingPaths = getIntersectingMarqueePaths([
  { path: 'docs/a.md', left: 30, top: 20, right: 80, bottom: 40 },
  { path: 'docs/b.md', left: 110, top: 70, right: 150, bottom: 100 },
  { path: 'docs/c.md', left: 200, top: 200, right: 240, bottom: 240 },
], selectionRect);

assert.deepEqual(
  Array.from(intersectingPaths),
  ['docs/a.md', 'docs/b.md'],
  'the marquee should return every intersecting visible item once',
);
assert.deepEqual(
  Array.from(mergeMarqueeSelection(['kept.md'], intersectingPaths, true)),
  ['kept.md', 'docs/a.md', 'docs/b.md'],
  'modifier-assisted marquee selection should preserve the prior selection',
);
assert.deepEqual(
  Array.from(mergeMarqueeSelection(['replaced.md'], intersectingPaths, false)),
  ['docs/a.md', 'docs/b.md'],
  'plain marquee selection should replace the prior selection',
);

console.log('file-marquee-selection-test: ok');
