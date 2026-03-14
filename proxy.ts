import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from "better-auth/cookies";

// Public routes that don't require authentication
const PUBLIC_PREFIX_ROUTES = ['/login', '/sign-in', '/sign-up', '/api/auth', '/api/automations/execute'];
const PUBLIC_EXACT_ROUTES = ['/'];

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
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'self'",
  ].join('; ');
  response.headers.set('Content-Security-Policy', cspHeader);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public routes and auth API routes
  if (
    PUBLIC_EXACT_ROUTES.includes(pathname) ||
    PUBLIC_PREFIX_ROUTES.some((route) => pathname.startsWith(route)) ||
    pathname.includes('/api/auth/')
  ) {
    const response = NextResponse.next();
    setCommonHeaders(response);
    return response;
  }

  // Check for session cookie using Better Auth utility
  const sessionCookie = getSessionCookie(request);
  
  // Debug logging disabled for cleaner output
  // console.log('[Middleware] Request URL:', request.url);
  // console.log('[Middleware] Cookies:', request.cookies.getAll().map(c => `${c.name}=${c.value.substring(0, 10)}...`));
  // console.log('[Middleware] Session Cookie Detected:', !!sessionCookie);

  const logMissingSession = process.env.NODE_ENV !== 'production' || process.env.AUTH_DEBUG === 'true';
  if (!sessionCookie && logMissingSession) {
    console.log(`[Middleware] No session cookie for ${pathname}. Redirecting/denying.`);
  }

  if (!sessionCookie) {
    // Redirect to login for page requests
    if (!pathname.startsWith('/api/')) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('from', pathname);
      const response = NextResponse.redirect(loginUrl);
      setCommonHeaders(response);
      return response;
    }

    // Return 401 for API requests
    const response = NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
    setCommonHeaders(response);
    return response;
  }

  const response = NextResponse.next();
  setCommonHeaders(response);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (images, etc)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
