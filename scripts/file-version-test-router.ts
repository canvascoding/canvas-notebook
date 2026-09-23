import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';

export const fileVersionTestRouter: AppRouterInstance = {
  bfcacheId: 'review-test',
  back() {}, forward() {}, refresh() {}, prefetch() {},
  push(href) { window.history.pushState(window.history.state, '', href); },
  replace(href) { window.history.replaceState(window.history.state, '', href); },
};
