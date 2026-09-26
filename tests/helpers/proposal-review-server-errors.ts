import { expect, type BrowserContext, type Page } from '@playwright/test';

/** A usable foreground view is not enough when background review requests fail. */
export function observeProposalReviewServerErrors(context: BrowserContext) {
  const errors: Array<{ path: string; status: number }> = [];
  const observe = (page: Page) => page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith('/api/files/version-center/v1/proposals/')
      && (response.status() >= 500 || response.status() === 429)) {
      // Deliberately exclude query strings, document content, headers and bodies.
      errors.push({ path: pathname, status: response.status() });
    }
  });
  context.pages().forEach(observe);
  context.on('page', observe);
  return () => expect(errors, 'No background proposal-review server errors or rate limits may be hidden by a successful foreground action.').toEqual([]);
}
