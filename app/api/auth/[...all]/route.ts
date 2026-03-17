import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getBootstrapAdminEmail, isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';

function invalidCredentialsResponse() {
  return NextResponse.json({ message: 'Invalid email or password' }, { status: 401 });
}

export async function GET(request: NextRequest) {
  return auth.handler(request);
}

export async function POST(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname.endsWith('/sign-up/email')) {
    return NextResponse.json({ message: 'Sign up is disabled' }, { status: 403 });
  }

  if (pathname.endsWith('/sign-in/email')) {
    const body = (await request.clone().json().catch(() => null)) as { email?: unknown } | null;
    const email = typeof body?.email === 'string' ? body.email : null;

    if (!getBootstrapAdminEmail() || !isBootstrapAdminEmail(email)) {
      return invalidCredentialsResponse();
    }
  }

  return auth.handler(request);
}
