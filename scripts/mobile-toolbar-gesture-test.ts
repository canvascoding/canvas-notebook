import assert from 'node:assert/strict';

import {
  hasMobileToolbarPressMoved,
  isMobileToolbarReleaseInside,
} from '../app/lib/editor/mobile-toolbar-gesture';

const start = { clientX: 40, clientY: 40 };

assert.equal(
  hasMobileToolbarPressMoved(start, { clientX: 48, clientY: 47 }),
  false,
  'small thumb jitter must still count as a tap',
);
assert.equal(
  hasMobileToolbarPressMoved(start, { clientX: 53, clientY: 40 }),
  true,
  'a horizontal toolbar swipe must cancel the press',
);
assert.equal(
  hasMobileToolbarPressMoved(start, { clientX: 40, clientY: 53 }),
  true,
  'a vertical sheet swipe must cancel the press',
);

const bounds = { bottom: 64, left: 16, right: 64, top: 16 };
assert.equal(isMobileToolbarReleaseInside(bounds, start), true);
assert.equal(isMobileToolbarReleaseInside(bounds, { clientX: 15, clientY: 40 }), false);
assert.equal(isMobileToolbarReleaseInside(bounds, { clientX: 40, clientY: 65 }), false);

console.log('mobile toolbar gesture tests passed');
