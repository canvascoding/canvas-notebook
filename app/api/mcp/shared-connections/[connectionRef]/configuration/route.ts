import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateSharedMcpConfiguration } from '@/app/lib/mcp/shared-connections';
import { inspectSharedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import type { McpServerConfig } from '@/app/lib/mcp/config';
import { sharedMcpRequestActor, sharedMcpRequestJson, sharedMcpResponse, sharedMcpResponseError, sharedMcpRevisionSchema, sharedMcpRevisions } from '../../http';

export async function PUT(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    const input = z.object({ ...sharedMcpRevisionSchema, definitionId: z.string().min(1).max(256).optional(), config: z.record(z.string(), z.unknown()).optional(),
      secrets: z.array(z.object({ name: z.string().min(1).max(64), value: z.string().max(65536) }).strict()).max(50).optional() }).strict().parse(await sharedMcpRequestJson(request));
    const record = await updateSharedMcpConfiguration(actor, (await context.params).connectionRef, sharedMcpRevisions(input), {
      definitionId: input.definitionId, config: input.config as McpServerConfig | undefined, secrets: input.secrets });
    return sharedMcpResponse(await inspectSharedIntegrationConnection(actor, record.resource.connectionRef));
  } catch (error) { return sharedMcpResponseError(error); }
}
