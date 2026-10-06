import { NextResponse } from 'next/server';
import { completeSharedComposioOAuthFlow } from '@/app/lib/composio/composio-shared-connections';
import { sharedComposioResponseError } from '../http';

export async function GET(request: Request) {
  try {
    const input = new URL(request.url);
    const flow = await completeSharedComposioOAuthFlow(input.searchParams.get('flow') || '', input.searchParams.get('error'));
    const base = process.env.BASE_URL || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`;
    const destination = new URL(flow.returnPath, base);
    destination.searchParams.set('composio', flow.status);
    destination.searchParams.set('connectionRef', flow.connectionRef);
    return NextResponse.redirect(destination);
  } catch (error) { return sharedComposioResponseError(error); }
}
