import 'server-only';

import type { Page } from 'puppeteer-core';
import { extractWebContent } from '@/app/lib/integrations/web-content-service';

export type ExtractedBrowserContent = {
  url: string;
  title: string | null;
  content: string;
  contentLength: number;
  truncated: boolean;
};

/** Extract completely; the gateway stores this value before choosing an excerpt. */
export async function extractReadablePageContent(page: Page): Promise<ExtractedBrowserContent> {
  const html = await page.content();
  const url = page.url();
  const extracted = extractWebContent(html, url, 'text/html');
  return {
    url, title: extracted.title || await page.title().catch(() => null),
    content: extracted.content, contentLength: extracted.content.length, truncated: false,
  };
}
