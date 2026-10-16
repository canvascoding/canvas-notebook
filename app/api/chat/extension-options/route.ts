import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { managementErrorDetails } from '@/app/lib/agents/management-actions';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { listChatExtensionOptions } from '@/app/lib/chat/extension-options';
import { CHAT_EXTENSION_OPTIONS_MAX_BYTES } from '@/app/lib/chat/extension-options-contracts';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { withExtensionObservation } from '@/app/lib/plugins/extension-search-observation';

export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'private, no-store' };
/** Metadata only. This endpoint neither creates a Session nor accepts/sends a message. */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: noStore });
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'chat-extension-options-post' });
  if (!limited.ok) { limited.response.headers.set('Cache-Control', noStore['Cache-Control']); return limited.response; }
  try {
    for (const key of request.nextUrl.searchParams.keys()) if (!['organizationId', 'workspaceId', 'projectId'].includes(key)
      || request.nextUrl.searchParams.getAll(key).length !== 1) throw new AgentWorkflowError('CHAT_EXTENSION_OPTIONS_INVALID', 'Choose one exact current context.', 400);
    const body = await readBoundedJson(request, CHAT_EXTENSION_OPTIONS_MAX_BYTES);
    if (body.response) { body.response.headers.set('Cache-Control', noStore['Cache-Control']); return body.response; }
    const { result: data, serverTiming } = await withExtensionObservation(() => listChatExtensionOptions({ userId: session.user.id, sessionId: session.session.id, source: 'api',
      organizationId: request.nextUrl.searchParams.get('organizationId'), workspaceId: request.nextUrl.searchParams.get('workspaceId'),
      projectId: request.nextUrl.searchParams.get('projectId') }, body.body, { signal: request.signal }));
    return NextResponse.json({ success: true, data }, { headers: { ...noStore, 'Server-Timing': serverTiming } });
  } catch (error) {
    const details = managementErrorDetails(error);
    return NextResponse.json({ success: false, code: details.code, error: details.message }, { status: details.status, headers: noStore });
  }
}
