import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import {
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  updateAgentProfile,
} from '@/app/lib/agents/registry';
import { normalizeAgentIconId } from '@/app/lib/agents/icons';
import {
  isManagedAgentFileName,
  isWritableManagedAgentFileName,
  writeManagedAgentFile,
  type AgentManagedFileName,
} from '@/app/lib/agents/storage';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { assertBrowserToolCanBeEnabled } from '@/app/lib/pi/browser/settings-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const THINKING_LEVELS = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-list-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const agents = await listAgentProfiles();
    return NextResponse.json({ success: true, data: { agents } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to list agents.' },
      { status: 500 },
    );
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function thinkingValue(value: unknown): PiThinkingLevel | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && THINKING_LEVELS.has(normalized as PiThinkingLevel) ? normalized as PiThinkingLevel : null;
}

function stringArrayValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function managedFilesValue(value: unknown): Partial<Record<AgentManagedFileName, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Partial<Record<AgentManagedFileName, string>> = {};
  for (const [fileName, content] of Object.entries(value)) {
    if (isManagedAgentFileName(fileName) && typeof content === 'string') {
      result[fileName] = content;
    }
  }
  return result;
}

async function writeInitialAgentFiles(
  agentId: string,
  files: Partial<Record<AgentManagedFileName, string>>,
  userId: string,
): Promise<void> {
  for (const [fileName, content] of Object.entries(files)) {
    if (!isManagedAgentFileName(fileName) || !isWritableManagedAgentFileName(fileName, agentId)) {
      continue;
    }
    await writeManagedAgentFile(fileName, content ?? '', agentId, { userId });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'agents-create-post',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const enabledTools = stringArrayValue(payload.enabledTools);
    await assertBrowserToolCanBeEnabled({ nextEnabledTools: enabledTools });
    const agent = await createAgentProfile({
      name: stringValue(payload.name) || '',
      agentId: stringValue(payload.agentId) || null,
      iconId: normalizeAgentIconId(payload.iconId),
      defaultProvider: stringValue(payload.defaultProvider) || null,
      defaultModel: stringValue(payload.defaultModel) || null,
      defaultThinking: thinkingValue(payload.defaultThinking),
      enabledTools,
      relevantSkills: stringArrayValue(payload.relevantSkills),
      relevantConnections: stringArrayValue(payload.relevantConnections),
    });
    const managedFiles = managedFilesValue(payload.files);
    await writeInitialAgentFiles(agent.agentId, managedFiles, session.user.id);
    await recordAuditEvent({
      userId: session.user.id,
      agentId: agent.agentId,
      source: 'agents',
      eventType: 'agent',
      entityType: 'agent_profile',
      entityId: agent.agentId,
      action: 'agent.create',
      status: 'success',
      summary: `Agent ${agent.agentId} created.`,
      metadata: {
        name: agent.name,
        defaultProvider: agent.defaultProvider,
        defaultModel: agent.defaultModel,
        defaultThinking: agent.defaultThinking,
        managedFiles: Object.keys(managedFiles),
      },
    });
    return NextResponse.json({ success: true, data: { agent } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create agent.' },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'agents-update-patch',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = stringValue(payload.agentId);
    if (!agentId) {
      throw new Error('agentId is required.');
    }
    const nextEnabledTools = Object.hasOwn(payload, 'enabledTools') ? stringArrayValue(payload.enabledTools) : undefined;
    if (nextEnabledTools !== undefined) {
      const existingAgent = await getAgentProfile(agentId);
      await assertBrowserToolCanBeEnabled({
        previousEnabledTools: existingAgent?.enabledTools ?? null,
        nextEnabledTools,
      });
    }
    const agent = await updateAgentProfile({
      agentId,
      name: stringValue(payload.name),
      iconId: Object.hasOwn(payload, 'iconId') ? normalizeAgentIconId(payload.iconId) : undefined,
      defaultProvider: Object.hasOwn(payload, 'defaultProvider') ? nullableStringValue(payload.defaultProvider) : undefined,
      defaultModel: Object.hasOwn(payload, 'defaultModel') ? nullableStringValue(payload.defaultModel) : undefined,
      defaultThinking: Object.hasOwn(payload, 'defaultThinking') ? thinkingValue(payload.defaultThinking) : undefined,
      enabledTools: nextEnabledTools,
      relevantSkills: Object.hasOwn(payload, 'relevantSkills') ? stringArrayValue(payload.relevantSkills) : undefined,
      relevantConnections: Object.hasOwn(payload, 'relevantConnections') ? stringArrayValue(payload.relevantConnections) : undefined,
    });
    await recordAuditEvent({
      userId: session.user.id,
      agentId: agent.agentId,
      source: 'agents',
      eventType: 'agent',
      entityType: 'agent_profile',
      entityId: agent.agentId,
      action: 'agent.update',
      status: 'success',
      summary: `Agent ${agent.agentId} updated.`,
      metadata: {
        changedFields: Object.keys(payload).filter((key) => key !== 'files'),
        defaultProvider: agent.defaultProvider,
        defaultModel: agent.defaultModel,
        defaultThinking: agent.defaultThinking,
      },
    });
    return NextResponse.json({ success: true, data: { agent } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update agent.' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'agents-delete',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const agentId = request.nextUrl.searchParams.get('agentId');
    if (!agentId) {
      throw new Error('agentId is required.');
    }
    await deleteAgentProfile(agentId);
    await recordAuditEvent({
      userId: session.user.id,
      agentId,
      source: 'agents',
      eventType: 'agent',
      entityType: 'agent_profile',
      entityId: agentId,
      action: 'agent.delete',
      status: 'success',
      summary: `Agent ${agentId} deleted.`,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete agent.' },
      { status: 400 },
    );
  }
}
