import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { packageRequestActor } from '@/app/api/capabilities/packages/http';
import { extensionPackagePinSchema } from '@/app/lib/capabilities/extensions/contracts';
import { readAgentExtensionPackageIcon } from '@/app/lib/agents/extension-package-icons';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { managementErrorDetails } from '@/app/lib/agents/management-actions';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import type { CapabilityPackageDeclaredIcon } from '@/app/lib/capabilities/packages/package-icon-image';

export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
};
const querySchema = extensionPackagePinSchema.extend({
  workspaceId: z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)).optional(),
  childRelativeRoot: z.string().max(1024).optional(),
}).strict();

function imageResponse(image: CapabilityPackageDeclaredIcon | null): NextResponse {
  if (image && 'url' in image) return new NextResponse(null, { status: 307, headers: { ...headers, Location: image.url } });
  return new NextResponse(image ? new Uint8Array(image.bytes) : null,
    { status: image ? 200 : 204, headers: { ...headers, ...(image ? { 'Content-Type': image.contentType } : {}) } });
}

/** Optional images follow the same exact published pin and fresh SourceUse as the package chooser. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const actor = await packageRequestActor(request);
    if (actor instanceof NextResponse) {
      for (const [key, value] of Object.entries(headers)) actor.headers.set(key, value);
      return actor;
    }
    const limited = rateLimit(request, { limit: 240, windowMs: 60_000, keyPrefix: 'agent-extension-options-icon', verifiedUserId: actor.userId });
    if (!limited.ok) {
      for (const [key, value] of Object.entries(headers)) limited.response.headers.set(key, value);
      return limited.response;
    }
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) if (params.getAll(key).length !== 1) {
      throw new AgentWorkflowError('AGENT_EXTENSION_OPTIONS_INVALID', 'Choose one exact package image.', 400);
    }
    const parsed = querySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) throw new AgentWorkflowError('AGENT_EXTENSION_OPTIONS_INVALID', 'Choose one exact package image.', 400);
    const { workspaceId, childRelativeRoot, ...pin } = parsed.data;
    if (workspaceId !== undefined && workspaceId !== actor.workspaceId) {
      throw new AgentWorkflowError('AGENT_EXTENSION_OPTIONS_INVALID', 'Choose one current workspace.', 400);
    }
    return imageResponse(await readAgentExtensionPackageIcon(actor, pin, childRelativeRoot === undefined ? {} : { childRelativeRoot }));
  } catch (error) {
    const details = managementErrorDetails(error);
    return NextResponse.json({ success: false, code: details.code, error: details.message }, { status: details.status, headers });
  }
}
