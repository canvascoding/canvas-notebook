import { NextResponse } from 'next/server';
import { verifyApiKey, isComposioConfigured } from '@/app/lib/composio/composio-client';
import { getConnectedAccounts } from '@/app/lib/composio/composio-auth';

export async function GET() {
  try {
    const configured = await isComposioConfigured();
    if (!configured) {
      return NextResponse.json({ configured: false, apiKeyValid: false, connectedAccounts: [] });
    }

    let apiKeyValid = false;
    try {
      apiKeyValid = await verifyApiKey();
    } catch {
      apiKeyValid = false;
    }

    if (!apiKeyValid) {
      return NextResponse.json({ configured: true, apiKeyValid: false, connectedAccounts: [] });
    }

    const accounts = await getConnectedAccounts();
    const connectedAccounts = accounts.map((a) => ({
      id: a.id,
      toolkit: {
        slug: a.toolkit?.slug ?? '',
        name: a.toolkit?.slug ?? '',
      },
      connectedAt: a.createdAt,
      status: a.status,
    }));

    return NextResponse.json({ configured: true, apiKeyValid: true, connectedAccounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ configured: true, apiKeyValid: false, connectedAccounts: [], error: message }, { status: 500 });
  }
}