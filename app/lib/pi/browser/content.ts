import 'server-only';

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { Page } from 'puppeteer-core';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export type ExtractedBrowserContent = {
  url: string;
  title: string | null;
  content: string;
  contentLength: number;
  truncated: boolean;
};

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  turndown.use(gfm);
  turndown.addRule('removeEmptyLinks', {
    filter: (node) => node.nodeName === 'A' && !node.textContent?.trim(),
    replacement: () => '',
  });
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, '')
    .replace(/ +/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/\s+\./g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractReadablePageContent(
  page: Page,
  maxContentLength: number,
): Promise<ExtractedBrowserContent> {
  const html = await page.content();
  const finalUrl = page.url();
  const doc = new JSDOM(html, { url: finalUrl });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();

  let content: string;
  if (article?.content) {
    content = htmlToMarkdown(article.content);
  } else {
    const fallbackDoc = new JSDOM(html, { url: finalUrl });
    const document = fallbackDoc.window.document;
    document.querySelectorAll('script, style, noscript, nav, header, footer, aside').forEach((el) => el.remove());
    const main = document.querySelector('main, article, [role="main"], .content, #content') || document.body;
    content = main?.innerHTML ? htmlToMarkdown(main.innerHTML) : '(Could not extract content)';
  }

  const truncated = content.length > maxContentLength;
  return {
    url: finalUrl,
    title: article?.title || await page.title().catch(() => null),
    content: truncated ? content.slice(0, maxContentLength) : content,
    contentLength: content.length,
    truncated,
  };
}
