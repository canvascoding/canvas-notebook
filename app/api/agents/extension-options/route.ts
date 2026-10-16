import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { managementErrorDetails } from '@/app/lib/agents/management-actions';
import { listManagedAgentExtensionOptions } from '@/app/lib/agents/extension-options';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { EXTENSION_SELECTION_LIMITS } from '@/app/lib/capabilities/extensions/contracts';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'private, no-store' };

/** Read-only POST keeps full precise preview/configuration intent out of URLs. */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: noStore });
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'agent-extension-options-post' });
  if (!limited.ok) { limited.response.headers.set('Cache-Control', noStore['Cache-Control']); return limited.response; }
  try {
    for (const key of request.nextUrl.searchParams.keys()) {
      if (!['organizationId', 'workspaceId', 'projectId'].includes(key) || request.nextUrl.searchParams.getAll(key).length !== 1) {
        throw new AgentWorkflowError('AGENT_EXTENSION_OPTIONS_INVALID', 'Choose one current actor context.', 400);
      }
    }
    const body = await readBoundedJson(request, EXTENSION_SELECTION_LIMITS.bytes);
    if (body.response) { body.response.headers.set('Cache-Control', noStore['Cache-Control']); return body.response; }
    const data = await listManagedAgentExtensionOptions({ userId: session.user.id, sessionId: session.session.id, source: 'api',
      organizationId: request.nextUrl.searchParams.get('organizationId'), workspaceId: request.nextUrl.searchParams.get('workspaceId'),
      projectId: request.nextUrl.searchParams.get('projectId') }, body.body, { signal: request.signal });
    return NextResponse.json({ success: true, data }, { headers: noStore });
  } catch (error) {
    const details = managementErrorDetails(error);
    return NextResponse.json({ success: false, code: details.code, error: details.message }, { status: details.status, headers: noStore });
  }
}
