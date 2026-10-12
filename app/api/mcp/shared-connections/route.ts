import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSharedMcpConnection } from '@/app/lib/mcp/shared-connections';
import { inspectSharedIntegrationConnection, listSharedIntegrationConnections } from '@/app/lib/integration-tools/connections/store';
import type { McpServerConfig } from '@/app/lib/mcp/config';
import { sharedMcpGrantsSchema, sharedMcpOwnershipSchema, sharedMcpRequestActor, sharedMcpRequestJson, sharedMcpRequestOwnership, sharedMcpResponse, sharedMcpResponseError } from './http';

const createSchema = z.object({ ownership: sharedMcpOwnershipSchema, displayName: z.string().min(1).max(256), description: z.string().max(4096).nullable().optional(),
  responsibleUserId: z.string().min(1).max(256).nullable().optional(), accessMode: z.enum(['restricted', 'inherit']).optional(),
  allowedToolNames: z.array(z.string().min(1).max(512)).max(1000).nullable().optional(), grants: sharedMcpGrantsSchema.optional(),
  definitionId: z.string().min(1).max(256).optional(), config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.array(z.object({ name: z.string().min(1).max(64), value: z.string().max(65536) }).strict()).max(50).optional() }).strict();

export async function GET(request: Request) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    return sharedMcpResponse({ connections: await listSharedIntegrationConnections(actor, 'mcp') });
  } catch (error) { return sharedMcpResponseError(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    const input = createSchema.parse(await sharedMcpRequestJson(request));
    const record = await createSharedMcpConnection(actor, { ...input, ownership: await sharedMcpRequestOwnership(actor, input.ownership), config: input.config as McpServerConfig | undefined });
    return sharedMcpResponse(await inspectSharedIntegrationConnection(actor, record.resource.connectionRef));
  } catch (error) { return sharedMcpResponseError(error); }
}
