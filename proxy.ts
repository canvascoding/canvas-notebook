import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from "better-auth/cookies";
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Initialize the next-intl middleware
const handleI18nRouting = createIntlMiddleware(routing);
const LICENSE_GATE_COOKIE = 'canvas_license_gate';

// Public routes that don't require authentication
const PUBLIC_PREFIX_ROUTES = ['/login', '/sign-in', '/sign-up', '/api/auth', '/api/license', '/api/automations/execute', '/api/automations/scheduler'];
const PUBLIC_EXACT_ROUTES = ['/', '/api/health', '/manifest.webmanifest'];
const LICENSE_ALLOWED_API_PREFIXES = ['/api/auth', '/api/health', '/api/license', '/api/onboarding'];

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

function getSecret(): string {
  return process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET || 'canvas-notebook-local-dev-secret-change-me';
}

function base64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64Url(signature);
}

async function hasValidLicenseGateCookie(request: NextRequest): Promise<boolean> {
  const cookie = request.cookies.get(LICENSE_GATE_COOKIE)?.value;
  if (!cookie) return false;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature) return false;
  if (await sign(payload) !== signature) return false;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const parsed = JSON.parse(atob(padded)) as {
      licensed?: boolean;
      expiresAt?: number;
    };
    return Boolean(parsed.licensed && parsed.expiresAt && parsed.expiresAt > Date.now());
  } catch {
    return false;
  }
}

async function loadLicenseStatus(request: NextRequest): Promise<{
  licensed?: boolean;
  plan?: string;
  instanceId?: string;
  expiresAt?: string | null;
} | null> {
  try {
    const statusUrl = new URL('/api/license/status', request.url);
    const response = await fetch(statusUrl, {
      headers: {
        cookie: request.headers.get('cookie') || '',
      },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function buildLicenseGateCookie(status: {
  licensed?: boolean;
  plan?: string;
  instanceId?: string;
  expiresAt?: string | null;
}): Promise<string> {
  const maxAgeMs = 60 * 60 * 12 * 1000;
  const expiresAt = Math.min(
    Date.now() + maxAgeMs,
    status.expiresAt ? new Date(status.expiresAt).getTime() : Date.now() + maxAgeMs,
  );
  const payload = btoa(JSON.stringify({
    licensed: Boolean(status.licensed),
    plan: status.plan,
    instanceId: status.instanceId,
    expiresAt,
  })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${payload}.${await sign(payload)}`;
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

  if (
    pathname.startsWith('/api/') &&
    !LICENSE_ALLOWED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
    !(await hasValidLicenseGateCookie(request))
  ) {
    const status = await loadLicenseStatus(request);
    if (status?.licensed) {
      const licensedResponse = NextResponse.next();
      setCommonHeaders(licensedResponse);
      licensedResponse.cookies.set(LICENSE_GATE_COOKIE, await buildLicenseGateCookie(status), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 12,
      });
      return licensedResponse;
    }

    const errorResponse = NextResponse.json(
      { success: false, error: 'License activation required', code: 'LICENSE_REQUIRED' },
      { status: 402 },
    );
    setCommonHeaders(errorResponse);
    return errorResponse;
  }

  return response;
}

export const config = {
  matcher: [
    // Skip all internal paths and static files
    '/api/:path*',
    '/((?!api|ws|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
