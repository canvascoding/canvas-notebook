import assert from 'node:assert/strict';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownRenderer } from '../app/components/shared/MarkdownRenderer';

const chart = `xychart-beta
    title "Geräte – Sessions vs. Seitenaufrufe"
    x-axis ["Desktop", "Mobile"]
    y-axis "Anzahl" 0 --> 500
    bar [44, 99]
    line [176, 447]`;

for (const fence of ['```', '~~~~']) {
  const content = `${fence}mermaid\n${chart}\n${fence}\n`;
  const html = renderToStaticMarkup(
    <MarkdownRenderer content={content} sourcePositions={{ offset: 12 }} />,
  );
  assert.match(html, /Rendering diagram/u, 'reading mode must mount the Mermaid renderer');
  assert.doesNotMatch(html, /<pre\b/u, 'Mermaid must not fall back to an ordinary code block');
  assert.match(html, /data-markdown-atom="true"/u, 'the diagram must retain reading viewport anchoring');
  assert.match(html, /data-markdown-source-from="12"/u);
  assert.match(html, new RegExp(`data-markdown-source-to="${12 + content.trimEnd().length}"`, 'u'));
}

const ordinaryCode = renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{}} onError={() => {}}>
    <MarkdownRenderer content={'```text\nxychart-beta\n```\n\nInline `mermaid` stays code.'} />
  </NextIntlClientProvider>,
);
assert.match(ordinaryCode, /<pre\b/u);
assert.match(ordinaryCode, /markdown-code-block-copy/u, 'ordinary code must retain the copy action');
assert.match(ordinaryCode, /<code[^>]*>mermaid<\/code>/u);
assert.doesNotMatch(ordinaryCode, /Rendering diagram/u, 'only fenced Mermaid blocks render diagrams');

console.log('markdown-mermaid-reading-test: ok');
