import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { managementErrorDetails } from '@/app/lib/agents/management-actions';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { controlChatQueueRecovery, getChatQueueRecovery } from '@/app/lib/pi/queue-recovery';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie, X-Canvas-Workspace-Id' };

async function handle(request: NextRequest, mutate: boolean) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: noStore });
  const limited = rateLimit(request, { limit: mutate ? 30 : 120, windowMs: 60_000,
    keyPrefix: mutate ? 'chat-queue-write' : 'chat-queue-read', verifiedUserId: session.user.id });
  if (!limited.ok) { limited.response.headers.set('Cache-Control', noStore['Cache-Control']); return limited.response; }
  try {
    const expectedWorkspaceId = request.headers.get('x-canvas-workspace-id') ?? '';
    if (!mutate) {
      if ([...request.nextUrl.searchParams.keys()].some(key => key !== 'sessionId')
        || request.nextUrl.searchParams.getAll('sessionId').length !== 1) {
        throw new AgentWorkflowError('CHAT_QUEUE_RECOVERY_INVALID', 'Choose one exact chat session.', 400);
      }
      const queue = await getChatQueueRecovery({ userId: session.user.id,
        sessionId: request.nextUrl.searchParams.get('sessionId') ?? '', expectedWorkspaceId });
      return NextResponse.json({ success: true, queue }, { headers: noStore });
    }
    if (request.nextUrl.search) throw new AgentWorkflowError('CHAT_QUEUE_RECOVERY_INVALID', 'Choose one exact chat session.', 400);
    const body = await readBoundedJson(request, 2048);
    if (body.response) { body.response.headers.set('Cache-Control', noStore['Cache-Control']); return body.response; }
    if (!body.body || typeof body.body !== 'object' || Array.isArray(body.body)) {
      throw new AgentWorkflowError('CHAT_QUEUE_RECOVERY_INVALID', 'Choose one exact queued message.', 400);
    }
    const { sessionId, ...action } = body.body as Record<string, unknown>;
    const result = await controlChatQueueRecovery({ userId: session.user.id, sessionId: sessionId as string, expectedWorkspaceId }, action);
    return NextResponse.json({ success: true, ...result }, { headers: noStore });
  } catch (error) {
    const details = managementErrorDetails(error);
    return NextResponse.json({ success: false, code: details.code, error: details.message }, { status: details.status, headers: noStore });
  }
}

export async function GET(request: NextRequest) { return handle(request, false); }
export async function POST(request: NextRequest) { return handle(request, true); }
