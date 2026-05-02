import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const connected = url.searchParams.get('connected');

    const redirectUrl = `/settings?tab=integrations${connected ? `&connected=${connected}` : ''}`;

    return NextResponse.redirect(new URL(redirectUrl, request.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}