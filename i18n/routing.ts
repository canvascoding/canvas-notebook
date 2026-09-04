import {defineRouting} from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['de', 'en'],
  defaultLocale: 'de',
  // The self-hosted custom Next.js server can expose middleware rewrites as
  // 307 responses. Explicit prefixes avoid a rewrite loop for the default
  // German locale while keeping locale selection deterministic after restart.
  localePrefix: 'always'
});
