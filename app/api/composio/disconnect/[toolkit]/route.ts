import { NextRequest, NextResponse } from 'next/server';
import { disconnectTool } from '@/app/lib/composio/composio-auth';
import { isComposioConfigured } from '@/app/lib/composio/composio-client';
import { clearToolkitCache } from '@/app/lib/composio/composio-toolkit-registry';

export async function DELETE(
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

    await disconnectTool(toolkit);
    clearToolkitCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}