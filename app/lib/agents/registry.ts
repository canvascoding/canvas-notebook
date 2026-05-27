import 'server-only';

import { asc, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { agents } from '@/app/lib/db/schema';
import { DEFAULT_MANAGED_AGENT_ID } from './storage';

export type AgentProfile = {
  id: number;
  agentId: string;
  name: string;
  type: string;
  removable: boolean;
  defaultProvider: string | null;
  defaultModel: string | null;
  createdAt: string;
  updatedAt: string;
};

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

