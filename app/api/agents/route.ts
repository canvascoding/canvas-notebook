import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  createAgentProfile,
  deleteAgentProfile,
  listAgentProfiles,
  updateAgentProfile,
} from '@/app/lib/agents/registry';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
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
    const agent = await createAgentProfile({
      name: stringValue(payload.name) || '',
      agentId: stringValue(payload.agentId) || null,
      defaultProvider: stringValue(payload.defaultProvider) || null,
      defaultModel: stringValue(payload.defaultModel) || null,
      defaultThinking: thinkingValue(payload.defaultThinking),
      enabledTools: stringArrayValue(payload.enabledTools),
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
    const agent = await updateAgentProfile({
      agentId,
      name: stringValue(payload.name),
      defaultProvider: Object.hasOwn(payload, 'defaultProvider') ? nullableStringValue(payload.defaultProvider) : undefined,
      defaultModel: Object.hasOwn(payload, 'defaultModel') ? nullableStringValue(payload.defaultModel) : undefined,
      defaultThinking: Object.hasOwn(payload, 'defaultThinking') ? thinkingValue(payload.defaultThinking) : undefined,
      enabledTools: Object.hasOwn(payload, 'enabledTools') ? stringArrayValue(payload.enabledTools) : undefined,
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
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete agent.' },
      { status: 400 },
    );
  }
}
