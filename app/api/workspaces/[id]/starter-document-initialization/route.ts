import type { NextRequest } from 'next/server';

import { workspaceStarterInitializationResponse } from '@/app/lib/workspaces/starter-document-initialization-api';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return workspaceStarterInitializationResponse(request, id, 'observe');
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return workspaceStarterInitializationResponse(request, id, 'complete');
}
