import assert from 'node:assert/strict';

import { isMarkdownImagePath } from '../app/lib/markdown/markdown-image-types';
import {
  collectPublicMarkdownImageWorkspacePaths,
  rewritePublicMarkdownImageSources,
} from '../app/lib/public-sharing/public-markdown-images';

assert.equal(isMarkdownImagePath('assets/photo.PNG'), true);
assert.equal(isMarkdownImagePath('assets/brief.pdf'), false);
assert.equal(isMarkdownImagePath('notes/image.md'), false);

const markdown = `# Public images

![[images/published.png|Published image]]

\`![[images/ignored.png|Ignored code example]]\`

![Standard image](images/standard.webp)
`;

assert.deepEqual(
  Array.from(collectPublicMarkdownImageWorkspacePaths(markdown, 'docs/with-images.md')).sort(),
  ['docs/images/published.png', 'docs/images/standard.webp'],
);

const rewritten = rewritePublicMarkdownImageSources(markdown, 'docs/with-images.md', 'share-token');
assert.match(
  rewritten,
  /!\[Published image\]\(<\/public\/markdown-assets\/share-token\/docs\/images\/published\.png>\)/,
);
assert.match(
  rewritten,
  /!\[Standard image\]\(\/public\/markdown-assets\/share-token\/docs\/images\/standard\.webp\)/,
);
assert.match(rewritten, /`!\[\[images\/ignored\.png\|Ignored code example\]\]`/);
assert.doesNotMatch(rewritten, /!\[\[images\/published\.png/);

console.log('public-markdown-images-test: ok');
