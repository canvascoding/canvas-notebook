import { NextRequest, NextResponse } from 'next/server';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { McpAccessError } from '@/app/lib/mcp/access';
import { IntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { resourceRequestActor } from '@/app/api/capabilities/resources/http';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { readPluginMcpIconAction } from '@/app/lib/plugins/plugin-mcp-icon-action';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
};

export async function GET(request: NextRequest, context: { params: Promise<{ selectionId: string }> }) {
  try {
    const parameters = request.nextUrl.searchParams;
    for (const key of parameters.keys()) {
      if (!['binding', 'workspaceId'].includes(key) || parameters.getAll(key).length !== 1) {
        throw new CapabilityResourceError('MCP_ICON_REQUEST_INVALID', 'The MCP image request is invalid.', 400);
      }
    }
    const requestedWorkspace = parameters.get('workspaceId'), headerWorkspace = request.headers.get(WORKSPACE_ID_HEADER)?.trim();
    if (headerWorkspace && requestedWorkspace && headerWorkspace !== requestedWorkspace) {
      throw new CapabilityResourceError('MCP_ICON_REQUEST_INVALID', 'The MCP image request is invalid.', 400);
    }
    const actor = await resourceRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const limited = rateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'plugins-mcp-icon' });
    if (!limited.ok) return limited.response;
    const selectionId = (await context.params).selectionId;
    const image = await readPluginMcpIconAction(actor, selectionId, parameters.get('binding') || '', request.signal);
    return new NextResponse(image ? new Uint8Array(image.buffer) : null, {
      status: image ? 200 : 204, headers: { ...headers, ...(image ? { 'Content-Type': image.contentType } : {}) },
    });
  } catch (error) {
    const known = error instanceof CapabilityResourceError || error instanceof McpAccessError || error instanceof IntegrationConnectionError;
    return NextResponse.json({ success: false, code: known ? error.code : 'MCP_ICON_UNAVAILABLE',
      error: 'This MCP image is unavailable.' }, { status: known ? error.status : 500, headers });
  }
}
