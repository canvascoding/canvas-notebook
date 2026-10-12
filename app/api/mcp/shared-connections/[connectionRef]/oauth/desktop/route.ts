import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { IntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { validateIntegrationConnectionRef } from '@/app/lib/integration-tools/connections/store';
import { cancelSharedMcpDesktopOAuth, finalizeSharedMcpDesktopOAuth, getSharedMcpDesktopOAuthStatus } from '@/app/lib/mcp/shared-desktop-oauth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { sharedMcpRequestDesktopInitiator, sharedMcpRequestJson, sharedMcpResponse, sharedMcpResponseError } from '../../../http';

const stateSchema = z.string().regex(/^desktop_[A-Za-z0-9_-]{32}$/u);
const workspaceQuerySchema = z.object({ workspaceId: z.string().trim().max(200).optional() }).strict();
const statusQuerySchema = workspaceQuerySchema.extend({ state: stateSchema }).strict();
const actionSchema = z.object({ state: stateSchema, action: z.enum(['finalize', 'cancel']) }).strict();

function readSharedMcpDesktopOAuthQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  if (query.getAll('state').length > 1 || query.getAll('workspaceId').length > 1) {
    throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Supply one sign-in state and workspace selection.', 400);
  }
  return statusQuerySchema.parse(Object.fromEntries(query));
}

export async function GET(request: NextRequest, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const initiator = await sharedMcpRequestDesktopInitiator(request); if (initiator instanceof NextResponse) return initiator;
    const limited = rateLimit(request, { limit: 90, windowMs: 60_000, keyPrefix: 'mcp-shared-desktop-oauth-status', verifiedUserId: initiator.actor.userId });
    if (!limited.ok) { limited.response.headers.set('Cache-Control', 'no-store'); return limited.response; }
    const { state } = readSharedMcpDesktopOAuthQuery(request);
    const connectionRef = validateIntegrationConnectionRef((await context.params).connectionRef);
    return sharedMcpResponse(await getSharedMcpDesktopOAuthStatus(initiator, connectionRef, state));
  } catch (error) {
    const response = sharedMcpResponseError(error); response.headers.set('Cache-Control', 'no-store'); return response;
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const initiator = await sharedMcpRequestDesktopInitiator(request); if (initiator instanceof NextResponse) return initiator;
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mcp-shared-desktop-oauth-action', verifiedUserId: initiator.actor.userId });
    if (!limited.ok) { limited.response.headers.set('Cache-Control', 'no-store'); return limited.response; }
    const query = new URL(request.url).searchParams;
    if (query.getAll('workspaceId').length > 1) throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Supply one workspace selection.', 400);
    workspaceQuerySchema.parse(Object.fromEntries(query));
    const input = actionSchema.parse(await sharedMcpRequestJson(request));
    const connectionRef = validateIntegrationConnectionRef((await context.params).connectionRef);
    const data = input.action === 'cancel'
      ? await cancelSharedMcpDesktopOAuth(initiator, connectionRef, input.state)
      : await finalizeSharedMcpDesktopOAuth(initiator, connectionRef, input.state);
    return sharedMcpResponse(data);
  } catch (error) {
    const response = sharedMcpResponseError(error); response.headers.set('Cache-Control', 'no-store'); return response;
  }
}
