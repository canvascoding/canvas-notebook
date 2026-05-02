import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from "better-auth/cookies";
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Initialize the next-intl middleware
const handleI18nRouting = createIntlMiddleware(routing);

// Public routes that don't require authentication
const PUBLIC_PREFIX_ROUTES = ['/login', '/sign-in', '/sign-up', '/api/auth', '/api/automations/execute', '/api/automations/scheduler'];
const PUBLIC_EXACT_ROUTES = ['/', '/api/health', '/manifest.webmanifest'];

function isWebSocketRoute(pathname: string) {
  return pathname === '/ws/chat' || /^\/[a-z]{2}(?:-[A-Z]{2})?\/ws\/chat$/u.test(pathname);
}

function getLocaleFromPathname(pathname: string) {
  for (const locale of routing.locales) {
    if (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)) {
      return locale;
    }
  }

  return routing.defaultLocale;
}

function buildLocalePath(locale: string, pathname: string) {
  if (locale === routing.defaultLocale) {
    return pathname;
  }

  return pathname === '/' ? `/${locale}` : `/${locale}${pathname}`;
}

function setCommonHeaders(response: NextResponse) {
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );

  const cspHeader = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' ws: wss: https://o4511053822099456.ingest.de.sentry.io https://api.github.com",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
  ].join('; ');
  response.headers.set('Content-Security-Policy', cspHeader);
}

function isPublicRoute(pathname: string) {
  // Strip locale prefix if present for checking public routes
  const locales = routing.locales;
  let pathWithoutLocale = pathname;
  
  for (const locale of locales) {
    if (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)) {
      pathWithoutLocale = pathname.replace(`/${locale}`, '') || '/';
      break;
    }
  }

  return (
    PUBLIC_EXACT_ROUTES.includes(pathWithoutLocale) ||
    PUBLIC_PREFIX_ROUTES.some((route) => pathWithoutLocale.startsWith(route)) ||
    pathname.includes('/api/auth/')
  );
}

export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isWebSocketRoute(pathname)) {
    return NextResponse.next();
  }

  // 1. Handle i18n routing first
  const response = handleI18nRouting(request);
  
  // Set security headers on the i18n response
  setCommonHeaders(response);

  // 2. Allow public routes and auth API routes
  if (isPublicRoute(pathname)) {
    return response;
  }

  // 3. Check for session cookie using Better Auth utility
  const sessionCookie = getSessionCookie(request);
  
  const logMissingSession = process.env.NODE_ENV !== 'production' || process.env.AUTH_DEBUG === 'true';
  if (!sessionCookie && logMissingSession) {
    console.log(`[Middleware] No session cookie for ${pathname}. Redirecting/denying.`);
  }

  if (!sessionCookie) {
    // Redirect to login for page requests
    if (!pathname.startsWith('/api/')) {
      const locale = getLocaleFromPathname(pathname);
      const loginUrl = new URL(buildLocalePath(locale, '/login'), request.url);
      const from = `${pathname}${request.nextUrl.search}`;
      loginUrl.searchParams.set('from', from);
      const redirectResponse = NextResponse.redirect(loginUrl);
      setCommonHeaders(redirectResponse);
      return redirectResponse;
    }

    // Return 401 for API requests
    const errorResponse = NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
    setCommonHeaders(errorResponse);
    return errorResponse;
  }

  return response;
}

export const config = {
  matcher: [
    // Skip all internal paths and static files
    '/((?!api|ws|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
