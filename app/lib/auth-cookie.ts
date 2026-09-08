import { getSessionCookie } from 'better-auth/cookies';

export function usesSecureAuthCookies(env: Record<string,string|undefined> = process.env) {
  return env.AUTH_COOKIE_SECURE === 'true' || Boolean((env.BETTER_AUTH_BASE_URL || env.BASE_URL)?.startsWith('https://'));
}

export function canvasAuthCookieOptions(env: Record<string,string|undefined> = process.env) {
  const secure=usesSecureAuthCookies(env);
  return {
    // Better Auth otherwise prepends __Secure- even to a custom __Host- name.
    // Keep its conventional OAuth cookie names, and name the session explicitly.
    useSecureCookies:false,
    cookiePrefix:secure ? '__Secure-better-auth' : 'better-auth',
    cookies:{session_token:{name:secure ? '__Host-better-auth.session_token' : 'better-auth.session_token'}},
  };
}

export function getCanvasSessionCookie(request: Parameters<typeof getSessionCookie>[0]) {
  return getSessionCookie(request,{cookiePrefix:usesSecureAuthCookies() ? '__Host-better-auth' : 'better-auth'});
}
