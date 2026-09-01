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
assert.match(obsidianMarkdown, /data-callout-title="Check this"/);
assert.match(obsidianMarkdown, /id="block-decision-1"/);
assert.doesNotMatch(obsidianMarkdown, /\^decision-1/);

const escapedObsidianMarkdown = renderMarkdown(String.raw`\[[Literal]] and \![[Embed]]`);
assert.match(escapedObsidianMarkdown, /\[\[Literal\]\]/);
assert.match(escapedObsidianMarkdown, /!\[\[Embed\]\]/);
assert.doesNotMatch(escapedObsidianMarkdown, /data-canvas-wiki-target/);

const inlineFootnoteMarkdown = renderMarkdown('Claim.^[Inline source note]');
assert.match(inlineFootnoteMarkdown, /data-inline-footnote="Inline source note"/);
assert.match(inlineFootnoteMarkdown, /data-inline-footnote-index="1"/);

const mentionMarkdown = renderMarkdown('Owner: @{Ada Lovelace|user-ada}.');
assert.match(mentionMarkdown, /class="canvas-markdown-mention"/);
assert.match(mentionMarkdown, /data-canvas-mention-label="Ada Lovelace"/);
assert.match(mentionMarkdown, /data-canvas-mention-user-id="user-ada"/);
assert.doesNotMatch(mentionMarkdown, /@\{Ada Lovelace\|user-ada\}/);

const standaloneEmbedMarkdown = renderMarkdown('![[Plan#Outcome]]');
assert.match(standaloneEmbedMarkdown, /data-canvas-wiki-transclude="true"/);
assert.match(standaloneEmbedMarkdown, /canvas-wiki-embed-container/);

const legacyWikiImageEmbedMarkdown = renderMarkdown(
  '![[02_brand/bradley-explorations/bradley-thinking-transparent.png|bradley-thinking-transparent.png]] Standard avatar.',
);
assert.match(
  legacyWikiImageEmbedMarkdown,
  /<img src="02_brand\/bradley-explorations\/bradley-thinking-transparent\.png" alt="bradley-thinking-transparent\.png"\/?>/,
);
assert.doesNotMatch(legacyWikiImageEmbedMarkdown, /data-canvas-wiki-target|canvas-wiki-embed/);

const standaloneLegacyWikiImageEmbedMarkdown = renderMarkdown('![[assets/chart.png|Chart]]');
assert.match(standaloneLegacyWikiImageEmbedMarkdown, /<img src="assets\/chart\.png" alt="Chart"\/?>/);
assert.doesNotMatch(standaloneLegacyWikiImageEmbedMarkdown, /data-canvas-wiki-transclude/);

const headingAnchorMarkdown = renderMarkdown(`# Einführung & Überblick

[Zum Überblick](#einführung-überblick)

## Wiederholt

## Wiederholt`);
assert.match(headingAnchorMarkdown, /<h1 id="einführung-überblick">/);
assert.match(headingAnchorMarkdown, /href="#einf%C3%BChrung-%C3%BCberblick"/);
assert.match(headingAnchorMarkdown, /<h2 id="wiederholt">/);
assert.match(headingAnchorMarkdown, /<h2 id="wiederholt-1">/);

console.log('canvas-markdown-rendering-test: ok');
