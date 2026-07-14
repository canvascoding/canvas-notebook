import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';

import {
  CANVAS_MARKDOWN_REHYPE_PLUGINS,
  CANVAS_MARKDOWN_REMARK_PLUGINS,
} from '../app/lib/markdown/canvas-markdown';

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(React.createElement(
    ReactMarkdown,
    {
      rehypePlugins: CANVAS_MARKDOWN_REHYPE_PLUGINS,
      remarkPlugins: CANVAS_MARKDOWN_REMARK_PLUGINS,
    },
    content,
  ));
}

const rendered = renderMarkdown(String.raw`Inline $E = mc^2$.

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$`);

assert.match(rendered, /class="katex"/);
assert.match(rendered, /class="katex-display"/);
assert.match(rendered, /<math[^>]+xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/);

const invalidFormula = renderMarkdown(String.raw`Invalid math $\notARealCommand{x}$.`);
assert.match(invalidFormula, /mathcolor="#cc0000"/);
assert.match(invalidFormula, /\\notARealCommand/);

const untrustedFormula = renderMarkdown(String.raw`$\href{javascript:alert(1)}{unsafe}$.`);
assert.doesNotMatch(untrustedFormula, /href="javascript:/i);
assert.doesNotMatch(untrustedFormula, /<script/i);

const streamingFragment = renderMarkdown('An unfinished formula $E = mc');
assert.match(streamingFragment, /An unfinished formula/);
assert.doesNotMatch(streamingFragment, /class="katex"/);

console.log('canvas-markdown-rendering-test: ok');
