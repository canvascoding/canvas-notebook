import { NextResponse } from 'next/server';
import { completeSharedComposioOAuthFlow } from '@/app/lib/composio/composio-shared-connections';
import { sharedComposioResponseError } from '../http';

export async function GET(request: Request) {
  let response: NextResponse;
  try {
    const input = new URL(request.url);
    const flow = await completeSharedComposioOAuthFlow(input.searchParams.get('flow') || '', input.searchParams.get('error'));
    const base = process.env.BASE_URL || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`;
    const destination = new URL(flow.returnPath, base);
    destination.searchParams.set(destination.searchParams.has('sharedOAuth') ? 'sharedOAuth' : 'composio', flow.status);
    destination.searchParams.set('connectionRef', flow.connectionRef);
    response = NextResponse.redirect(destination);
  } catch (error) { response = sharedComposioResponseError(error); }
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
