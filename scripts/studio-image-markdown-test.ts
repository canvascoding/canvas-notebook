import assert from 'node:assert/strict';

import {
  extractStudioImageMediaUrls,
  rewriteRelativeStudioImageMarkdown,
} from '../app/lib/chat/studio-image-markdown';

const mediaUrlA = '/api/studio/media/studio/outputs/studio-gen-ente-statt-affe-0-2026-05-29T15-38-00-000Z-a1b2.jpg';
const mediaUrlB = '/api/studio/media/studio/outputs/studio-gen-ente-statt-affe-1-2026-05-29T15-38-00-000Z-c3d4.png';

assert.deepEqual(
  extractStudioImageMediaUrls(`URL:  ${mediaUrlA}\nMarkdown image (copy exactly): ![studio-0](${mediaUrlA})`),
  [mediaUrlA],
);

assert.equal(
  rewriteRelativeStudioImageMarkdown(
    'Guck mal:\n\n![Ente statt Affe](ente-statt-affe.jpg)\n\nFertig.',
    [mediaUrlA],
  ),
  `Guck mal:\n\n![Ente statt Affe](${mediaUrlA})\n\nFertig.`,
);

assert.equal(
  rewriteRelativeStudioImageMarkdown(
    '![A](ente-statt-affe.jpg)\n![B](zweite-variante.png)',
    [mediaUrlA, mediaUrlB],
  ),
  `![A](${mediaUrlA})\n![B](${mediaUrlB})`,
);

assert.equal(
  rewriteRelativeStudioImageMarkdown(
    '![Already correct](/api/studio/media/studio/outputs/generated.png)\n![External](https://example.com/image.jpg)',
    [mediaUrlA],
  ),
  '![Already correct](/api/studio/media/studio/outputs/generated.png)\n![External](https://example.com/image.jpg)',
);

console.log('studio-image-markdown-test: ok');
