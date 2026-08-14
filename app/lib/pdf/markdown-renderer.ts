import fs from 'node:fs/promises';
import path from 'node:path';

import { CANVAS_KATEX_OPTIONS } from '@/app/lib/markdown/katex-options';
import { stripCanvasMarkdownFrontmatterForPresentation } from '@/app/lib/markdown/obsidian-metadata';
import { Marked, type Token, type Tokens } from 'marked';
import markedKatex from 'marked-katex-extension';

const markdownRenderer = new Marked(
  { gfm: true, breaks: true },
  markedKatex({
    ...CANVAS_KATEX_OPTIONS,
    nonStandard: true,
  }),
);

type CanvasPdfCalloutToken = Tokens.Generic & {
  calloutType: string;
  titleTokens: Token[];
};

type CanvasPdfDetailsToken = Tokens.Generic & {
  summaryTokens: Token[];
};

type CanvasPdfFootnoteToken = Tokens.Generic & {
  footnoteId: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toCalloutType(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9-]/g, '');
  return normalized || 'note';
}

function footnoteAnchorId(footnoteId: string): string {
  return `canvas-pdf-footnote-${encodeURIComponent(footnoteId)}`;
}

markdownRenderer.use({
  extensions: [
    {
      name: 'canvasPdfCallout',
      level: 'block',
      start(src) {
        return src.match(/^ {0,3}> \[!/mu)?.index;
      },
      tokenizer(src) {
        const match = /^(?:(?: {0,3}>[^\r\n]*)(?:\r?\n|$))+/u.exec(src);
        if (!match) return undefined;

        const raw = match[0];
        const lines = raw
          .trimEnd()
          .split(/\r?\n/u)
          .map((line) => line.replace(/^ {0,3}> ?/u, ''));
        const header = /^\[!([a-z0-9_-]+)\](?:[+-])?(?:[ \t]+(.*))?$/iu.exec(lines[0] || '');
        if (!header) return undefined;

        const calloutType = toCalloutType(header[1]);
        const title = header[2]?.trim() || calloutType;
        const body = lines.slice(1).join('\n').trim();

        return {
          type: 'canvasPdfCallout',
          raw,
          calloutType,
          titleTokens: this.lexer.inlineTokens(title),
          tokens: body ? this.lexer.blockTokens(body) : [],
        };
      },
      renderer(token) {
        const callout = token as CanvasPdfCalloutToken;
        return `<aside class="canvas-pdf-callout canvas-pdf-callout-${callout.calloutType}">
  <div class="canvas-pdf-callout-title">${this.parser.parseInline(callout.titleTokens)}</div>
  <div class="canvas-pdf-callout-content">${this.parser.parse(callout.tokens || [])}</div>
</aside>\n`;
      },
      childTokens: ['titleTokens', 'tokens'],
    },
    {
      name: 'canvasPdfDetails',
      level: 'block',
      start(src) {
        return src.match(/<details(?:\s|>)/iu)?.index;
      },
      tokenizer(src) {
        const match = /^<details(?:\s+open(?:=(?:"open"|'open'|open))?)?>[ \t]*\r?\n<summary>([^\r\n]*)<\/summary>[ \t]*\r?\n([\s\S]*?)\r?\n<\/details>(?:\r?\n|$)/iu.exec(src);
        if (!match) return undefined;

        const raw = match[0];
        const summary = match[1].trim();
        const body = match[2].trim();

        return {
          type: 'canvasPdfDetails',
          raw,
          summaryTokens: this.lexer.inlineTokens(summary),
          tokens: body ? this.lexer.blockTokens(body) : [],
        };
      },
      renderer(token) {
        const details = token as CanvasPdfDetailsToken;
        return `<section class="canvas-pdf-details" data-expanded="true">
  <div class="canvas-pdf-details-summary">${this.parser.parseInline(details.summaryTokens)}</div>
  <div class="canvas-pdf-details-content">${this.parser.parse(details.tokens || [])}</div>
</section>\n`;
      },
      childTokens: ['summaryTokens', 'tokens'],
    },
    {
      name: 'canvasPdfFootnoteDefinition',
      level: 'block',
      start(src) {
        return src.match(/^\[\^[^\]\s\r\n]+\]:/mu)?.index;
      },
      tokenizer(src) {
        const match = /^\[\^([^\]\s\r\n]+)\]:[ \t]*([^\r\n]*)(?:\r?\n((?:(?: {2,}|\t)[^\r\n]*(?:\r?\n|$))*))?/u.exec(src);
        if (!match) return undefined;

        const raw = match[0];
        const footnoteId = match[1];
        const continuation = match[3]
          ?.split(/\r?\n/u)
          .map((line) => line.replace(/^(?: {2,}|\t)/u, ''))
          .join('\n')
          .trim();
        const body = [match[2], continuation].filter(Boolean).join('\n').trim();

        return {
          type: 'canvasPdfFootnoteDefinition',
          raw,
          footnoteId,
          tokens: body ? this.lexer.blockTokens(body) : [],
        };
      },
      renderer(token) {
        const footnote = token as CanvasPdfFootnoteToken;
        const anchorId = footnoteAnchorId(footnote.footnoteId);
        return `<aside class="canvas-pdf-footnote-definition" id="${anchorId}">
  <span class="canvas-pdf-footnote-label">${escapeHtml(footnote.footnoteId)}</span>
  <div class="canvas-pdf-footnote-content">${this.parser.parse(footnote.tokens || [])}</div>
</aside>\n`;
      },
      childTokens: ['tokens'],
    },
    {
      name: 'canvasPdfFootnoteReference',
      level: 'inline',
      start(src) {
        return src.match(/\[\^[^\]\s\r\n]+\]/u)?.index;
      },
      tokenizer(src) {
        const match = /^\[\^([^\]\s\r\n]+)\]/u.exec(src);
        if (!match) return undefined;

        return {
          type: 'canvasPdfFootnoteReference',
          raw: match[0],
          footnoteId: match[1],
        };
      },
      renderer(token) {
        const footnote = token as CanvasPdfFootnoteToken;
        const anchorId = footnoteAnchorId(footnote.footnoteId);
        return `<sup class="canvas-pdf-footnote-reference"><a href="#${anchorId}">[${escapeHtml(footnote.footnoteId)}]</a></sup>`;
      },
    },
  ],
});

let embeddedKatexCssPromise: Promise<string> | null = null;

export async function renderMarkdownForPdf(markdown: string): Promise<string> {
  return markdownRenderer.parse(
    stripCanvasMarkdownFrontmatterForPresentation(markdown),
    { async: true },
  );
}

async function loadEmbeddedKatexCss(): Promise<string> {
  const katexDistDir = path.resolve(process.cwd(), 'node_modules/katex/dist');
  const cssPath = path.join(katexDistDir, 'katex.min.css');
  let css = await fs.readFile(cssPath, 'utf8');

  // Chromium supports WOFF2, so omit the larger legacy fallbacks before inlining fonts.
  css = css.replace(
    /,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g,
    '',
  );

  const fontNames = Array.from(
    new Set(Array.from(css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g), (match) => match[1])),
  );
  const encodedFonts = await Promise.all(fontNames.map(async (fontName) => {
    const font = await fs.readFile(path.join(katexDistDir, 'fonts', fontName));
    return [fontName, font.toString('base64')] as const;
  }));

  for (const [fontName, base64] of encodedFonts) {
    css = css.replaceAll(
      `url(fonts/${fontName})`,
      `url("data:font/woff2;base64,${base64}")`,
    );
  }

  return css;
}

export function getEmbeddedKatexCss(): Promise<string> {
  if (!embeddedKatexCssPromise) {
    embeddedKatexCssPromise = loadEmbeddedKatexCss().catch((error) => {
      embeddedKatexCssPromise = null;
      throw error;
    });
  }
  return embeddedKatexCssPromise;
}
