import 'server-only';

import { asc, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { agents, piSessions } from '@/app/lib/db/schema';
import { deletePiSessionsByDbIds } from '@/app/lib/pi/session-deletion';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { DEFAULT_MANAGED_AGENT_ID } from './storage';

export type AgentProfile = {
  id: number;
  agentId: string;
  name: string;
  type: string;
  removable: boolean;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinking: PiThinkingLevel | null;
  enabledTools: string[] | null;
  createdAt: string;
  updatedAt: string;
};

const THINKING_LEVELS = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function normalizeManagedAgentId(agentId?: string | null): string {
  const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  if (!normalized) {
    return DEFAULT_MANAGED_AGENT_ID;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('Invalid agentId.');
  }
  return normalized;
}

function mapAgent(row: typeof agents.$inferSelect): AgentProfile {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    type: row.type,
    removable: Boolean(row.removable),
    defaultProvider: row.defaultProvider ?? null,
    defaultModel: row.defaultModel ?? null,
    defaultThinking: normalizeThinking(row.defaultThinking),
    enabledTools: parseEnabledTools(row.enabledToolsJson),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeThinking(value?: string | null): PiThinkingLevel | null {
  const normalized = value?.trim();
  return normalized && THINKING_LEVELS.has(normalized as PiThinkingLevel) ? normalized as PiThinkingLevel : null;
}

function normalizeEnabledTools(value?: string[] | null): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const normalized = typeof entry === 'string' ? entry.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseEnabledTools(value?: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeEnabledTools(Array.isArray(parsed) ? parsed : null);
  } catch {
    return null;
  }
}

function stringifyEnabledTools(value?: string[] | null): string | null {
  const normalized = normalizeEnabledTools(value);
  return normalized ? JSON.stringify(normalized) : null;
}

export async function ensureCanvasAgent(): Promise<AgentProfile> {
  const now = new Date();
  await db
    .insert(agents)
    .values({
      agentId: DEFAULT_MANAGED_AGENT_ID,
      name: 'Canvas Agent',
      type: 'main',
      removable: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const row = await db.query.agents.findFirst({
    where: eq(agents.agentId, DEFAULT_MANAGED_AGENT_ID),
  });

  if (!row) {
    throw new Error('Canvas Agent could not be loaded.');
  }

  return mapAgent(row);
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  await ensureCanvasAgent();
  const rows = await db.select().from(agents).orderBy(asc(agents.type), asc(agents.name), asc(agents.createdAt));
  return rows.map(mapAgent);
}

export async function getAgentProfile(agentId?: string | null): Promise<AgentProfile | null> {
  const normalizedAgentId = normalizeManagedAgentId(agentId);
  if (normalizedAgentId === DEFAULT_MANAGED_AGENT_ID) {
    return ensureCanvasAgent();
  }

  const row = await db.query.agents.findFirst({
    where: eq(agents.agentId, normalizedAgentId),
  });
  return row ? mapAgent(row) : null;
}

function slugifyAgentId(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalizeManagedAgentId(normalized || 'agent');
}

export async function createAgentProfile(input: {
  name: string;
  agentId?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinking?: PiThinkingLevel | null;
  enabledTools?: string[] | null;
}): Promise<AgentProfile> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('Agent name is required.');
  }

  const agentId = normalizeManagedAgentId(input.agentId || slugifyAgentId(name));
  if (agentId === DEFAULT_MANAGED_AGENT_ID) {
    throw new Error('Canvas Agent already exists and cannot be recreated.');
  }

  const now = new Date();
  await db.insert(agents).values({
    agentId,
    name,
    type: 'special',
    removable: true,
    defaultProvider: input.defaultProvider?.trim() || null,
    defaultModel: input.defaultModel?.trim() || null,
    defaultThinking: normalizeThinking(input.defaultThinking) || null,
    enabledToolsJson: stringifyEnabledTools(input.enabledTools),
    createdAt: now,
    updatedAt: now,
  });

  const created = await getAgentProfile(agentId);
  if (!created) {
    throw new Error('Agent could not be created.');
  }
  return created;
}

export async function updateAgentProfile(input: {
  agentId: string;
  name?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinking?: PiThinkingLevel | null;
  enabledTools?: string[] | null;
}): Promise<AgentProfile> {
  const agentId = normalizeManagedAgentId(input.agentId);
  const existing = await getAgentProfile(agentId);
  if (!existing) {
    throw new Error('Agent not found.');
  }

  const nextName = input.name === undefined || input.name === null ? existing.name : input.name.trim();
  if (!nextName) {
    throw new Error('Agent name is required.');
  }

  await db.update(agents)
    .set({
      name: nextName,
      defaultProvider: input.defaultProvider === undefined ? existing.defaultProvider : input.defaultProvider?.trim() || null,
      defaultModel: input.defaultModel === undefined ? existing.defaultModel : input.defaultModel?.trim() || null,
      defaultThinking: input.defaultThinking === undefined ? existing.defaultThinking : normalizeThinking(input.defaultThinking) || null,
      enabledToolsJson: input.enabledTools === undefined ? stringifyEnabledTools(existing.enabledTools) : stringifyEnabledTools(input.enabledTools),
      updatedAt: new Date(),
    })
    .where(eq(agents.agentId, agentId));

  const updated = await getAgentProfile(agentId);
  if (!updated) {
    throw new Error('Agent could not be updated.');
  }
  return updated;
}

export async function deleteAgentProfile(agentIdInput: string): Promise<void> {
  const agentId = normalizeManagedAgentId(agentIdInput);
  const existing = await getAgentProfile(agentId);
  if (!existing) {
    throw new Error('Agent not found.');
  }
  if (!existing.removable) {
    throw new Error('Canvas Agent cannot be removed.');
  }

  const sessions = await db.select({ id: piSessions.id }).from(piSessions).where(eq(piSessions.agentId, agentId));
  await deletePiSessionsByDbIds(sessions.map((session) => session.id));
  await db.delete(agents).where(eq(agents.agentId, agentId));
}
