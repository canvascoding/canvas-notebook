import { NextRequest, NextResponse } from 'next/server';
import { initiateConnection } from '@/app/lib/composio/composio-auth';
import { isComposioConfigured } from '@/app/lib/composio/composio-client';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ toolkit: string }> },
) {
  try {
    const configured = await isComposioConfigured();
    if (!configured) {
      return NextResponse.json({ error: 'Composio not configured' }, { status: 400 });
    }

    const { toolkit } = await params;
    if (!toolkit) {
      return NextResponse.json({ error: 'Toolkit slug is required' }, { status: 400 });
    }

    const { redirectUrl, noAuth } = await initiateConnection(toolkit);
    if (noAuth) {
      return NextResponse.json({ noAuth: true, redirectUrl: null });
    }
    return NextResponse.json({ redirectUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}