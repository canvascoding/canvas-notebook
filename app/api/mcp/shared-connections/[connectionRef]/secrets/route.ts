import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateSharedMcpSecretSlots } from '@/app/lib/mcp/shared-connections';
import { inspectSharedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { sharedMcpRequestActor, sharedMcpRequestJson, sharedMcpResponse, sharedMcpResponseError, sharedMcpRevisionSchema, sharedMcpRevisions } from '../../http';

export async function PATCH(request: Request, context: { params: Promise<{ connectionRef: string }> }) {
  try {
    const actor = await sharedMcpRequestActor(request); if (actor instanceof NextResponse) return actor;
    const input = z.object({ ...sharedMcpRevisionSchema, patches: z.array(z.object({ name: z.string().min(1).max(64), value: z.string().max(65536).nullable() }).strict()).min(1).max(50) }).strict().parse(await sharedMcpRequestJson(request));
    const record = await updateSharedMcpSecretSlots(actor, (await context.params).connectionRef, sharedMcpRevisions(input), input.patches);
    return sharedMcpResponse(await inspectSharedIntegrationConnection(actor, record.resource.connectionRef));
  } catch (error) { return sharedMcpResponseError(error); }
}
