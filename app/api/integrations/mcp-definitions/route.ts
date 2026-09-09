import { NextRequest, NextResponse } from 'next/server';

import { assertMcpConnectionAccess, McpAccessError, mcpErrorStatus } from '@/app/lib/mcp/access';
import { requireMcpRequestActor } from '@/app/lib/mcp/request-access';
import { McpDefinitionError, listMcpServerDefinitions, publishMcpServerDefinition, setMcpServerDefinitionEnabled } from '@/app/lib/mcp/server-definitions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type DefinitionAction = 'publish' | 'set_enabled';

type DefinitionPayload = {
  action?: DefinitionAction;
  server?: string;
  name?: string;
  id?: string;
  enabled?: boolean;
};

function definitionData(actor: { organizationId: string | null; canManageDefinitions: boolean }, definitions: Awaited<ReturnType<typeof listMcpServerDefinitions>>) {
  return {
    canManageDefinitions: actor.canManageDefinitions,
    organizationId: actor.organizationId,
    definitions: definitions.map(({ id, name, enabled, revision, config }) => ({ id, name, enabled, revision, config })),
  };
}

export async function GET(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;
  try {
    const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'integrations-mcp-definitions' });
    if (!limited.ok) return limited.response;
    const definitions = actor.organizationId ? await listMcpServerDefinitions(actor.organizationId) : [];
    return NextResponse.json({ success: true, data: definitionData(actor, definitions) });
  } catch (error) {
    if (error instanceof McpDefinitionError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    console.error('[API] integrations/mcp-definitions GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load MCP definitions' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const actor = await requireMcpRequestActor(request);
  if (actor instanceof NextResponse) return actor;
  try {
    if (!actor.canManageDefinitions || !actor.organizationId) throw new McpAccessError('Only organization admins can manage approved MCP servers.');
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'integrations-mcp-definitions-post' });
    if (!limited.ok) return limited.response;
    const payload = await request.json().catch(() => ({})) as DefinitionPayload;
    if (payload.action === 'publish') {
      const server = typeof payload.server === 'string' ? payload.server.trim() : '';
      const name = typeof payload.name === 'string' ? payload.name : server;
      const id = typeof payload.id === 'string' ? payload.id : undefined;
      if (!server) return NextResponse.json({ success: false, error: 'MCP server is required' }, { status: 400 });
      const scope = { userId: actor.userId };
      const { connection } = await assertMcpConnectionAccess(server, scope, { allowDisabled: true, management: true, actor });
      const definition = await publishMcpServerDefinition(actor.organizationId, name, connection, id);
      return NextResponse.json({ success: true, data: { id: definition.id, name: definition.name, enabled: definition.enabled, revision: definition.revision, config: definition.config } });
    }
    if (payload.action === 'set_enabled') {
      if (typeof payload.id !== 'string' || typeof payload.enabled !== 'boolean') return NextResponse.json({ success: false, error: 'Definition ID and enabled state are required' }, { status: 400 });
      await setMcpServerDefinitionEnabled(actor.organizationId, payload.id, payload.enabled);
      return NextResponse.json({ success: true, data: { id: payload.id, enabled: payload.enabled } });
    }
    return NextResponse.json({ success: false, error: 'Unsupported MCP definition action' }, { status: 400 });
  } catch (error) {
    if (error instanceof McpAccessError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: mcpErrorStatus(error) });
    if (error instanceof McpDefinitionError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    console.error('[API] integrations/mcp-definitions POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update MCP definitions', ...(typeof (error as { code?: unknown })?.code === 'string' ? { code: (error as { code: string }).code } : {}) }, { status: mcpErrorStatus(error, 500) });
  }
}
