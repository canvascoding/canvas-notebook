import { expect, type BrowserContext, type Page } from '@playwright/test';

export type ProposalReviewServerError = Readonly<{ path: string; status: number }>;
export type ProposalReviewServerErrorExpectation = ProposalReviewServerError & Readonly<{
  minCount?: number;
  maxCount?: number;
}>;

/** A usable foreground view is not enough when background review requests fail. */
export function observeProposalReviewServerErrors(context: BrowserContext,
  expected: ReadonlyArray<ProposalReviewServerErrorExpectation> = []) {
  const errors: ProposalReviewServerError[] = [];
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
  return () => {
    const unexpected = errors.filter(error => !expected.some(rule => rule.path === error.path && rule.status === error.status));
    const countsOutsideBounds = expected.flatMap(rule => {
      const count = errors.filter(error => error.path === rule.path && error.status === rule.status).length;
      const minimum = rule.minCount ?? 1;
      const maximum = rule.maxCount ?? minimum;
      return count < minimum || count > maximum ? [{ path: rule.path, status: rule.status, count, minimum, maximum }] : [];
    });
    expect({ unexpected, countsOutsideBounds },
      'Only explicitly bounded proposal-review transport failures may occur.').toEqual({ unexpected: [], countsOutsideBounds: [] });
  };
}
