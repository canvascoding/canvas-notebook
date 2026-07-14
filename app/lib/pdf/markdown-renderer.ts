import fs from 'node:fs/promises';
import path from 'node:path';

import { CANVAS_KATEX_OPTIONS } from '@/app/lib/markdown/katex-options';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';

const markdownRenderer = new Marked(
  { gfm: true, breaks: true },
  markedKatex({
    ...CANVAS_KATEX_OPTIONS,
    nonStandard: true,
  }),
);

let embeddedKatexCssPromise: Promise<string> | null = null;

export async function renderMarkdownForPdf(markdown: string): Promise<string> {
  return markdownRenderer.parse(markdown, { async: true });
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
