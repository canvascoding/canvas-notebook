import { routing } from '@/i18n/routing';

/**
 * Builds an application URL for a locale without invoking a client-side router
 * transition. Public auth and onboarding pages intentionally use a document
 * navigation here: it avoids carrying mutated browser DOM into hydration.
 */
export function buildLocalePath(locale: string, pathname: string): string {
  const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (locale === routing.defaultLocale) {
    return normalizedPathname;
  }

  return normalizedPathname === '/'
    ? `/${locale}`
    : `/${locale}${normalizedPathname}`;
}
