import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import {
  inspectManagedAgent,
  managementErrorDetails,
  resetManagedAgentFiles,
  updateManagedAgentFile,
  type AgentManagementActor,
} from '@/app/lib/agents/management-actions';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import {
  AGENT_MANAGED_FILE_NAMES,
  DEFAULT_MANAGED_AGENT_ID,
  isManagedAgentFileName,
  resetManagedAgentFile,
  writeManagedAgentFile,
  type AgentManagedFileName,
} from '@/app/lib/agents/storage';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

function actor(request: NextRequest, session: AuthSession): AgentManagementActor {
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    source: 'api',
    organizationId: request.nextUrl.searchParams.get('organizationId'),
    workspaceId: request.nextUrl.searchParams.get('workspaceId'),
    projectId: request.nextUrl.searchParams.get('projectId'),
  };
}

function errorResponse(error: unknown, fallback: string) {
  const details = managementErrorDetails(error);
  return NextResponse.json(
    { success: false, code: details.code, error: details.message || fallback, ...(details.details || {}) },
    { status: details.status },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'agents-files-get' });
  if (!limited.ok) return limited.response;

  try {
    const data = await inspectManagedAgent(
      actor(request, session),
      request.nextUrl.searchParams.get('agentId') || DEFAULT_MANAGED_AGENT_ID,
      { includeFiles: true },
    );
    return NextResponse.json({ success: true, data: { files: data.files, agent: data.agent } });
  } catch (error) {
    return errorResponse(error, 'Failed to read agent files.');
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'agents-files-put' });
  if (!limited.ok) return limited.response;

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : DEFAULT_MANAGED_AGENT_ID;
    const fileName = typeof payload.fileName === 'string' ? payload.fileName.trim() : '';
    if (!isManagedAgentFileName(fileName)) throw new Error('Invalid managed agent fileName.');
    if (typeof payload.content !== 'string') throw new Error('content must be a string.');

    if (normalizeManagedAgentId(agentId) === DEFAULT_MANAGED_AGENT_ID) {
      const inspected = await inspectManagedAgent(actor(request, session), agentId);
      if (!inspected.access.canEdit) throw new Error('Agent access denied.');
      const content = await writeManagedAgentFile(fileName, payload.content, agentId, { userId: session.user.id });
      await recordAuditEvent({
        userId: session.user.id,
        agentId: DEFAULT_MANAGED_AGENT_ID,
        source: 'agents',
        eventType: 'agent',
        entityType: 'agent_managed_file',
        entityId: `${DEFAULT_MANAGED_AGENT_ID}:${fileName}`,
        action: 'agent_file.write',
        metadata: { fileName, contentLength: payload.content.length },
      });
      return NextResponse.json({ success: true, data: { fileName, content, agent: inspected.agent } });
    }

    if (typeof payload.expectedRevision !== 'number') throw new Error('expectedRevision is required.');
    const data = await updateManagedAgentFile({
      actor: actor(request, session),
      agentId,
      expectedRevision: payload.expectedRevision,
      fileName,
      content: payload.content,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return errorResponse(error, 'Failed to write agent file.');
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'agents-files-post' });
  if (!limited.ok) return limited.response;

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    if (payload.action !== 'reset') throw new Error('Only the reset action is supported.');
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : DEFAULT_MANAGED_AGENT_ID;
    const fileName = typeof payload.fileName === 'string' ? payload.fileName.trim() : null;
    if (fileName && !isManagedAgentFileName(fileName)) throw new Error('Invalid managed agent fileName.');

    if (normalizeManagedAgentId(agentId) === DEFAULT_MANAGED_AGENT_ID) {
      const inspected = await inspectManagedAgent(actor(request, session), agentId);
      if (!inspected.access.canEdit) throw new Error('Agent access denied.');
      const fileNames = fileName ? [fileName] : [...AGENT_MANAGED_FILE_NAMES];
      const files = [];
      for (const nextFileName of fileNames as AgentManagedFileName[]) {
        files.push({
          fileName: nextFileName,
          content: await resetManagedAgentFile(nextFileName, agentId, { userId: session.user.id }),
        });
      }
      return NextResponse.json({ success: true, data: { files, reset: true, agent: inspected.agent } });
    }

    if (typeof payload.expectedRevision !== 'number') throw new Error('expectedRevision is required.');
    const data = await resetManagedAgentFiles({
      actor: actor(request, session),
      agentId,
      expectedRevision: payload.expectedRevision,
      fileName,
    });
    const single = fileName ? data.files[0] : null;
    return NextResponse.json({
      success: true,
      data: single
        ? { ...single, agent: data.agent, reset: true }
        : { ...data, reset: true },
    });
  } catch (error) {
    return errorResponse(error, 'Failed to reset agent files.');
  }
}
