import type { NextRequest } from 'next/server';

import { workspaceStarterInitializationResponse } from '@/app/lib/workspaces/starter-document-initialization-api';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { workspaceId } = await context.params;
  return workspaceStarterInitializationResponse(request, workspaceId, 'observe');
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { workspaceId } = await context.params;
  return workspaceStarterInitializationResponse(request, workspaceId, 'complete');
}
