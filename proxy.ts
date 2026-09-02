import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from "better-auth/cookies";
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Initialize the next-intl middleware
const handleI18nRouting = createIntlMiddleware(routing);

// Public routes that don't require authentication
const PUBLIC_PREFIX_ROUTES = ['/login', '/sign-in', '/sign-up', '/setup', '/api/auth', '/api/license', '/api/setup', '/api/automations/execute', '/api/automations/scheduler'];
const PUBLIC_EXACT_ROUTES = [
  '/',
  '/api/browser/view/fixture-download',
  '/api/browser/view/fixture-page',
  '/api/health',
  '/api/mobile/v1/compatibility',
  '/api/organization/invitations/accept',
  '/api/organization/invitations/activate',
  '/api/organization/invitations/preview',
  '/invite/team',
  '/manifest.webmanifest',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/oauth/consent',
];
const PUBLIC_NON_LOCALIZED_EXACT_ROUTES = [
  '/mcp',
];
const PUBLIC_SHARE_PREFIX_ROUTES = [
  '/p/',
  '/public/files/',
  '/public/view/',
  '/public/markdown-assets/',
  '/public/markdown-export/',
  '/public/markdown-pdf/',
  '/public/marp-preview/',
];
function isWebSocketRoute(pathname: string) {
  return pathname === '/ws/chat' || /^\/[a-z]{2}(?:-[A-Z]{2})?\/ws\/chat$/u.test(pathname);
}

function isPublicShareRoute(pathname: string) {
  return PUBLIC_SHARE_PREFIX_ROUTES.some((route) => pathname.startsWith(route));
}

function isMobileHtmlPreviewRoute(pathname: string) {
  return /^\/api\/mobile\/v1\/files\/html-preview\/[A-Za-z0-9_-]{43}(?:\/|$)/u.test(pathname);
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
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' ws: wss: https://o4511053822099456.ingest.de.sentry.io https://api.github.com",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
  ].join('; ');
  response.headers.set('Content-Security-Policy', cspHeader);
}

function nextWithCommonHeaders() {
  const response = NextResponse.next();
  setCommonHeaders(response);
  return response;
}

function isFetchServerAction(request: NextRequest) {
  return request.method === 'POST' && request.headers.has('next-action');
}

function staleServerActionResponse(request: NextRequest) {
  const redirectTarget = `${request.nextUrl.pathname}${request.nextUrl.search}`.replace(/;/g, '%3B') || '/';
  const response = new NextResponse('Server action is no longer available. Reloading.', {
    status: 409,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-action-redirect': `${redirectTarget};replace`,
    },
  });
  setCommonHeaders(response);
  return response;
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

  // Canvas Notebook handles mutations through API routes. A next-action POST here
  // is from a stale client after a rebuild; reload the page instead of letting
  // Next.js emit a noisy "Failed to find Server Action" warning.
  if (isFetchServerAction(request)) {
    return staleServerActionResponse(request);
  }

  if (isWebSocketRoute(pathname)) {
    return NextResponse.next();
  }

  if (isPublicShareRoute(pathname)) {
    return NextResponse.next();
  }

  // Mobile HTML previews use a short-lived, read-only ticket instead of exposing
  // the Better Auth session to untrusted WebView content. The route verifies the
  // opaque ticket and workspace scope before serving HTML or a relative asset.
  if (isMobileHtmlPreviewRoute(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    if (isPublicRoute(pathname)) {
      return nextWithCommonHeaders();
    }

    const sessionCookie = getSessionCookie(request);
    const logMissingSession = process.env.NODE_ENV !== 'production' || process.env.AUTH_DEBUG === 'true';
    if (!sessionCookie && logMissingSession) {
      console.log(`[Middleware] No session cookie for ${pathname}. Denying API request.`);
    }

    if (!sessionCookie) {
      const errorResponse = NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
      setCommonHeaders(errorResponse);
      return errorResponse;
    }

    return nextWithCommonHeaders();
  }

  if (PUBLIC_NON_LOCALIZED_EXACT_ROUTES.includes(pathname)) {
    return nextWithCommonHeaders();
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
    // Email AI endpoints read their request bodies through a 1 MiB bounded
    // stream reader. Excluding exactly those routes prevents Next.js proxy
    // from cloning each body into the separate 256 MiB upload buffer first.
    // Their handlers repeat the full session check before reading.
    '/api/((?!email/compose/(?:ai|agent)(?:/|$)|email/accounts/[^/]+/messages/actions(?:/|$)|email/accounts/[^/]+/messages/[^/]+/(?:summary|ai-reply)(?:/|$)).*)',
    '/((?!api|ws|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
