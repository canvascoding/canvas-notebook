import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const promotionSource = readFileSync(
  path.join(root, 'app/components/public-sharing/PublicSharePromotion.tsx'),
  'utf8',
);
const publicFilePreviewSource = readFileSync(
  path.join(root, 'app/components/public-sharing/PublicFilePreview.tsx'),
  'utf8',
);
const publicExcalidrawSource = readFileSync(
  path.join(root, 'app/components/public-sharing/PublicExcalidrawViewer.tsx'),
  'utf8',
);

assert.match(promotionSource, /https:\/\/canvasnotebook\.app/u);
assert.match(promotionSource, /loading="lazy"/u);
assert.match(promotionSource, /decoding="async"/u);
assert.match(promotionSource, /data-public-share-promotion/u);
assert.match(promotionSource, /env\(safe-area-inset-bottom\)/u);
assert.match(promotionSource, /noopener noreferrer/u);
assert.equal(
  (publicFilePreviewSource.match(/<PublicSharePromotion \/>/gu) || []).length,
  1,
  'The standard public file preview must include the promotion once.',
);
assert.equal(
  (publicExcalidrawSource.match(/<PublicSharePromotion \/>/gu) || []).length,
  2,
  'Valid and invalid public Excalidraw previews must include the promotion.',
);

console.log('public-share-promotion-ui-test: ok');
