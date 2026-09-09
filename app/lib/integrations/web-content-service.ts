import 'server-only';

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { fetchExternalResourceSafely } from '@/app/lib/security/safe-external-fetch';

export function clampWebInteger(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(Math.trunc(value), maximum))
    : fallback;
}

export function cleanWebText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/giu, '[embedded image omitted]')
    .replace(/data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?;base64,[a-z0-9+/=]+/giu, '[embedded image omitted]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractWebContent(text: string, url: string, contentType: string): { title: string; content: string } {
  if (!/html|xml/.test(contentType)) {
    return { title: '', content: cleanWebText(text) };
  }
  const dom = new JSDOM(text, { url });
  try {
    const document = dom.window.document;
    const title = document.title.trim();
    document.querySelectorAll('script, style, noscript').forEach(element => element.remove());
    document.querySelectorAll('img[src^="data:"], source[srcset^="data:"]').forEach(element => element.remove());
    // Readability mutates its document. Keep the original for a real fallback.
    const article = new Readability(document.cloneNode(true) as Document).parse();
    const main = document.querySelector('main, article, [role="main"], .content, #content') || document.body;
    main?.querySelectorAll('nav, header, footer, aside').forEach(element => element.remove());
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    turndown.use(gfm);
    const content = turndown.turndown(article?.content || main?.innerHTML || '')
      .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, '')
      .replace(/ +/g, ' ');
    return { title: article?.title || title, content: cleanWebText(content) };
  } finally {
    dom.window.close();
  }
}

export type WebContentResult = {
  url: string;
  finalUrl?: string;
  success: boolean;
  statusCode?: number;
  title?: string;
  content?: string;
  error?: string;
  fetchTime: string;
};

/** Returns the full cleaned text within the download cap; presentation follows storage. */
export async function fetchReadableWebContent(url: string, options: { timeoutSeconds?: number; signal?: AbortSignal } = {}): Promise<WebContentResult> {
  const fetchTime = new Date().toISOString();
  options.signal?.throwIfAborted();
  try {
    const resource = await fetchExternalResourceSafely(url, {
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: clampWebInteger(options.timeoutSeconds, 15, 60) * 1_000,
      signal: options.signal,
    });
    const contentType = resource.contentType.toLowerCase();
    if (!/html|^text\/|(?:application|text)\/(?:[^;]+\+)?(?:xml|json)/.test(contentType)) {
      return { url, success: false, error: `Unsupported page content type: ${contentType.slice(0, 120)}`, fetchTime };
    }
    const extracted = extractWebContent(resource.buffer.toString('utf8'), resource.finalUrl, contentType);
    if (!extracted.content) return { url, success: false, error: 'No readable text; the page may require browser rendering.', fetchTime };
    return { url, finalUrl: resource.finalUrl, success: true, statusCode: resource.statusCode, ...extracted, fetchTime };
  } catch (error) {
    options.signal?.throwIfAborted();
    return { url, success: false, error: error instanceof Error ? error.message : 'Could not fetch page content.', fetchTime };
  }
}
