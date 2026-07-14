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

const obsidianMarkdown = renderMarkdown(`---
title: Hidden metadata
---

See [[research/Market Analysis#Results|the results]] and ==important text==. %%hidden comment%%

> [!warning]- Check this
> Callout body.

Reusable paragraph ^decision-1`);
assert.doesNotMatch(obsidianMarkdown, /Hidden metadata|hidden comment/);
assert.match(obsidianMarkdown, /data-canvas-wiki-target="research\/Market Analysis#Results"/);
assert.match(obsidianMarkdown, /class="canvas-wiki-link"/);
assert.match(obsidianMarkdown, /<mark class="canvas-markdown-highlight">important text<\/mark>/);
assert.match(obsidianMarkdown, /data-callout="warning"/);
assert.match(obsidianMarkdown, /data-callout-fold="-"/);
assert.match(obsidianMarkdown, /id="block-decision-1"/);
assert.doesNotMatch(obsidianMarkdown, /\^decision-1/);

const escapedObsidianMarkdown = renderMarkdown(String.raw`\[[Literal]] and \![[Embed]]`);
assert.match(escapedObsidianMarkdown, /\[\[Literal\]\]/);
assert.match(escapedObsidianMarkdown, /!\[\[Embed\]\]/);
assert.doesNotMatch(escapedObsidianMarkdown, /data-canvas-wiki-target/);

console.log('canvas-markdown-rendering-test: ok');
