import { NextResponse } from 'next/server';
import { getAvailableToolkits } from '@/app/lib/composio/composio-toolkit-registry';
import { isComposioConfigured } from '@/app/lib/composio/composio-client';

export async function GET() {
  try {
    const configured = await isComposioConfigured();
    if (!configured) {
      return NextResponse.json({ toolkits: [] });
    }

    const toolkits = await getAvailableToolkits();
    return NextResponse.json({ toolkits });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ toolkits: [], error: message }, { status: 500 });
  }
}