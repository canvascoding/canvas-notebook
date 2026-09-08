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

const excludedImages = [
  '```md\n![private](images/private.png)\n```',
  '~~~html\n<img src="images/private.png">\n~~~',
  '    ![private](images/private.png)',
  '> ```md\n> ![private](images/private.png)\n> ```',
  '`![private](images/private.png)`',
  '`first line\n![private](images/private.png)`',
  '\\![private](images/private.png)',
  '<!-- <img src="images/private.png"> -->',
  '<script>const x = \'<img src="images/private.png">\'</script>',
  '%% ![private](images/private.png) %%',
  '%%\n![private](images/private.png)\n%%',
  '[unused]: images/private.png',
  '[ordinary link][unused]\n\n[unused]: images/private.png',
  '`![private][ref]`\n\n[ref]: images/private.png',
  '    ![[images/private.png]]',
  '\\![[images/private.png]]',
];
for (const example of excludedImages) {
  for (const prefix of ['', '📎 Unicode before the example\n\n']) {
    const document = prefix + example;
    assert.deepEqual([...collectPublicMarkdownImageWorkspacePaths(document, 'docs/example.md')], [], document);
    assert.equal(rewritePublicMarkdownImageSources(document, 'docs/example.md', 'token'), document);
  }
}

const supportedImages = [
  '![image](images/visible.png)',
  '![image](images/visible.png "Title")',
  '![image][ref]\n\n[ref]: images/visible.png',
  '![ref][]\n\n[ref]: images/visible.png',
  '![ref]\n\n[ref]: images/visible.png',
  '![[images/visible.png|Image]]',
  '<img src="images/visible.png" alt="Image">',
  '> ![image](images/visible.png)',
  '- ![image](images/visible.png)',
];
for (const example of supportedImages) {
  const document = `📎\r\n\r\n${example}`;
  assert.deepEqual([...collectPublicMarkdownImageWorkspacePaths(document, 'docs/example.md')], ['docs/images/visible.png'], document);
  assert.match(rewritePublicMarkdownImageSources(document, 'docs/example.md', 'token'), /\/public\/markdown-assets\/token\/docs\/images\/visible\.png/);
}

assert.deepEqual([...collectPublicMarkdownImageWorkspacePaths(
  '![x](images/plot(1).png)', 'docs/example.md',
)], ['docs/images/plot(1).png']);
const metadataImage = '---\ncover: "![private](images/private.png)"\n---\n\n![visible](images/visible.png)';
assert.deepEqual([...collectPublicMarkdownImageWorkspacePaths(metadataImage, 'docs/example.md')], ['docs/images/visible.png']);
assert.match(rewritePublicMarkdownImageSources(metadataImage, 'docs/example.md', 'token'), /cover: "!\[private\]\(images\/private\.png\)"/);
console.log('public-markdown-images-test: code exclusions and parsed image forms ok');
