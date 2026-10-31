import { NextRequest } from 'next/server';
import { createApiIntegration, listApiIntegrations } from '@/app/lib/api-keys/management';
import { apiAccessPage, apiAccessResponse } from '../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return apiAccessResponse(request, () => listApiIntegrations(request.headers, apiAccessPage(request)));
}

export async function POST(request: NextRequest) {
  return apiAccessResponse(request, body => createApiIntegration(request.headers, body));
}
