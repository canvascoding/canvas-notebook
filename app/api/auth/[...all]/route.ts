import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';

export async function GET(request: NextRequest) {
  return auth.handler(request);
}

export async function POST(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname.endsWith('/sign-up/email')) {
    return NextResponse.json({ message: 'Sign up is disabled' }, { status: 403 });
  }

  return auth.handler(request);
}
