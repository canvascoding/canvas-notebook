import { NextRequest, NextResponse } from 'next/server';
import { AgentAccessError } from '@/app/lib/agents/access';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { requireAutomationSession, applyAutomationRateLimit, getAutomationRouteErrorStatus } from '@/app/lib/automations/api';
import { listAutomationChatTargets } from '@/app/lib/automations/chat-targets';
import { assertCanAccessAutomationJob } from '@/app/lib/automations/policy';
import { getAutomationJob } from '@/app/lib/automations/store';

export async function GET(request: NextRequest) {
  const { session, response } = await requireAutomationSession(request);
  if (!session || response) return response;
  const limited = applyAutomationRateLimit(request, 'automation-chat-targets', 120);
  if (!limited.ok) return limited.response;
  const params = request.nextUrl.searchParams;
  try {
    const jobId = params.get('jobId');
    if (jobId) {
      const job = await getAutomationJob(jobId);
      if (!job) return NextResponse.json({ success: false, error: 'Automation not found.' }, { status: 404 });
      await assertCanAccessAutomationJob(session.user.id, job);
      if ((job.responsibleUserId || job.ownerUserId || job.createdByUserId) !== session.user.id) {
        return NextResponse.json({ success: false, error: 'Only the person responsible for this automation can select one of their chats.' }, { status: 403 });
      }
      if (params.get('workspaceId') !== job.workspaceId) {
        return NextResponse.json({ success: false, error: 'Choose chats in the automation workspace.' }, { status: 400 });
      }
    }
    const workspaceId = params.get('workspaceId')?.trim();
    if (!workspaceId) return NextResponse.json({ success: false, error: 'Choose a workspace first.' }, { status: 400 });
    const data = await listAutomationChatTargets({
      userId: session.user.id,
      agentId: normalizeManagedAgentId(params.get('agentId')),
      workspaceId,
      query: params.get('query') || undefined,
      cursor: params.get('cursor') || undefined,
      sessionId: params.get('sessionId') || undefined,
    });
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'The chats could not be loaded. Check your workspace and agent access.' }, {
      status: error instanceof AgentAccessError ? error.status : getAutomationRouteErrorStatus(error, 400),
    });
  }
}
