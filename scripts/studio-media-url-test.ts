import assert from 'node:assert/strict';

import { toMediaUrl, toPreviewUrl } from '../app/lib/utils/media-url';

const scopedPath = 'studio/organizations/org-1/workspaces/workspace-1/assets/products/product-1/image.png';

assert.equal(
  toMediaUrl(scopedPath),
  '/api/studio/media/studio/organizations/org-1/workspaces/workspace-1/assets/products/product-1/image.png?workspaceId=workspace-1',
);
assert.equal(
  toPreviewUrl(scopedPath, 480),
  '/api/files/preview?path=studio%2Forganizations%2Forg-1%2Fworkspaces%2Fworkspace-1%2Fassets%2Fproducts%2Fproduct-1%2Fimage.png&w=480&workspaceId=workspace-1',
);
assert.equal(
  toMediaUrl('notes/example.md'),
  '/api/media/notes/example.md',
  'Normal workspace media URLs must remain unchanged.',
);

console.log('studio-media-url-test: ok');
