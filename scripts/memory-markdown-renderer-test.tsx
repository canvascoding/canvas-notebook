import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemoryMarkdownContent } from '../app/components/settings/MemoryMarkdownContent';

const html = renderToStaticMarkup(
  <MemoryMarkdownContent
    content={'**Delivery format**\n\n- Keep it concise\n- Include `file links`\n\n> Confirm before publishing.\n\n[Documentation](https://example.com)\n\n# Hidden heading\n\n<img src="https://tracker.example/pixel.png">\n\n![Remote image](https://tracker.example/pixel.png)'}
  />,
);

assert.match(html, /<strong>Delivery format<\/strong>/u);
assert.match(html, /<ul>/u);
assert.match(html, /<code>file links<\/code>/u);
assert.match(html, /<blockquote>/u);
assert.match(html, /target="_blank"/u);
assert.match(html, /rel="noopener noreferrer nofollow"/u);
assert.match(html, /Hidden heading/u);
assert.doesNotMatch(html, /<h1/u);
assert.doesNotMatch(html, /<img/u);
assert.doesNotMatch(html, /tracker\.example/u);

console.log('memory-markdown-renderer-test: ok');
