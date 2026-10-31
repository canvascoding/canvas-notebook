import { NextRequest } from 'next/server';
import { listApiIntegrationCredentials, revokeApiKey, rotateApiKey } from '@/app/lib/api-keys/management';
import { apiAccessPage, apiAccessResponse, apiIntegrationId } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ integrationId: string }> };

export async function GET(request: NextRequest, context: Context) {
  return apiAccessResponse(request, async () => listApiIntegrationCredentials(request.headers, await apiIntegrationId(context), apiAccessPage(request)));
}

export async function POST(request: NextRequest, context: Context) {
  return apiAccessResponse(request, async body => rotateApiKey(request.headers, await apiIntegrationId(context), body));
}

export async function DELETE(request: NextRequest, context: Context) {
  return apiAccessResponse(request, async body => revokeApiKey(request.headers, await apiIntegrationId(context), body));
}
