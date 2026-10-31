import { NextRequest } from 'next/server';
import { updateApiIntegration } from '@/app/lib/api-keys/management';
import { apiAccessResponse, apiIntegrationId } from '../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, context: { params: Promise<{ integrationId: string }> }) {
  return apiAccessResponse(request, async body => updateApiIntegration(request.headers, await apiIntegrationId(context), body));
}
