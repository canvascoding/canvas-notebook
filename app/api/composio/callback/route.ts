import { NextRequest, NextResponse } from 'next/server';
import { clearToolkitCache } from '@/app/lib/composio/composio-toolkit-registry';
import { resetSessionCache } from '@/app/lib/composio/composio-session';

function getBaseUrl(): string {
  const baseUrl = process.env.BASE_URL || process.env.APP_BASE_URL;
  if (baseUrl) return baseUrl;
  const port = process.env.PORT || '3000';
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return `http://localhost:${port}`;
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const connected = url.searchParams.get('connected');

    clearToolkitCache();
    resetSessionCache();

    const baseUrl = getBaseUrl();
    const redirectUrl = new URL(`/settings?tab=integrations${connected ? `&connected=${connected}` : ''}`, baseUrl);

    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}