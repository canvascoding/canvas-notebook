import { getIronSession, IronSession } from 'iron-session';
import { cookies, headers } from 'next/headers';

export interface SessionData {
  username: string;
  isLoggedIn: boolean;
}

const baseSessionOptions = {
  password: process.env.SESSION_SECRET || 'change_this_to_a_random_32_character_secret_key_in_production',
  cookieName: 'canvas-notebook-session',
  cookieOptions: {
    secure: false,
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const forwardedProto = requestHeaders.get('x-forwarded-proto');
  const envSetting = process.env.SESSION_SECURE_COOKIES;

  let secureCookie = false;
  if (envSetting === 'true') {
    secureCookie = true;
  } else if (envSetting === 'false') {
    secureCookie = false;
  } else if (process.env.NODE_ENV === 'production') {
    secureCookie = forwardedProto === 'https';
  }

  const sessionOptions = {
    ...baseSessionOptions,
    cookieOptions: {
      ...baseSessionOptions.cookieOptions,
      secure: secureCookie,
    },
  };

  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession();
  return session.isLoggedIn === true;
}
