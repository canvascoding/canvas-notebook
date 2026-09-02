import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { agents, piSessions } from '@/app/lib/db/schema';
import { deletePiSessionsByDbIds } from '@/app/lib/pi/session-deletion';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { DEFAULT_AGENT_ICON_ID, normalizeAgentIconId, type AgentIconId } from './icons';
import { MAIN_AGENT_DISPLAY_NAME, normalizeMainAgentIdAlias } from './main-agent';
import { DEFAULT_MANAGED_AGENT_ID, EMAIL_MANAGED_AGENT_ID, SYSTEM_MANAGED_AGENT_IDS } from './storage';
import { EMAIL_AGENT_DEFAULT_ENABLED_TOOLS } from '../pi/email-agent-policy';
import { DISABLED_ALL_TOOLS_SENTINEL } from '../pi/enabled-tools';
import { MEMORY_MANAGER_AGENT_ID, MEMORY_MANAGER_AGENT_NAME } from '../memory/constants';

export { EMAIL_MANAGED_AGENT_ID } from './storage';
export { MAIN_AGENT_DISPLAY_NAME } from './main-agent';
const LEGACY_MAIN_AGENT_DISPLAY_NAMES = new Set(['Canvas Agent']);

const LEGACY_EMAIL_AGENT_DEFAULT_ENABLED_TOOLS = [
  'email_list_accounts',
  'email_search',
  'email_read',
  'email_create_draft',
  'email_update_draft',
  'workspace_email_list_mailboxes',
  'workspace_email_search_messages',
  'workspace_email_read_message',
  'workspace_email_list_thread_messages',
  'workspace_email_list_cases',
  'workspace_email_create_or_update_case',
  'workspace_email_create_outbox_draft',
  'workspace_email_update_outbox_draft',
  'workspace_email_list_outbox_drafts',
];

const PREVIOUS_EMAIL_AGENT_DEFAULT_ENABLED_TOOLS = [
  'email_list_mailboxes',
  'email_search_messages',
  'email_read_message',
  'email_list_thread_messages',
  'email_list_cases',
  'email_create_or_update_case',
  'email_create_outbox_draft',
  'email_update_outbox_draft',
  'email_list_outbox_drafts',
];

function isSystemManagedAgentId(agentId: string): boolean {
  return (SYSTEM_MANAGED_AGENT_IDS as readonly string[]).includes(agentId);
}

export type AgentProfile = {
  id: number;
  agentId: string;
  name: string;
  iconId: AgentIconId;
  type: string;
  removable: boolean;
  defaultProviderInstallationId: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinking: PiThinkingLevel | null;
  enabledTools: string[] | null;
  relevantSkills: string[] | null;
  relevantConnections: string[] | null;
  scopeType: 'user' | 'organization' | 'system';
  organizationId: string | null;
  ownerUserId: string | null;
  createdByUserId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export class AgentRevisionConflictError extends Error {
  readonly code = 'AGENT_REVISION_CONFLICT';

  constructor(readonly currentRevision: number) {
    super(`Agent revision changed. Reload the agent and retry with revision ${currentRevision}.`);
    this.name = 'AgentRevisionConflictError';
  }
}

const THINKING_LEVELS = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PROVIDER_INSTALLATION_ID_PATTERN = /^aip_[a-f0-9]{24}$/u;

type AgentDefaultTuple = {
  defaultProviderInstallationId: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinking: PiThinkingLevel | null;
};

function normalizeAgentDefaultTuple(input: {
  defaultProviderInstallationId?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinking?: PiThinkingLevel | null;
}): AgentDefaultTuple {
  const tuple: AgentDefaultTuple = {
    defaultProviderInstallationId: input.defaultProviderInstallationId?.trim() || null,
    defaultProvider: input.defaultProvider?.trim() || null,
    defaultModel: input.defaultModel?.trim() || null,
    defaultThinking: normalizeThinking(input.defaultThinking),
  };
  if (Object.values(tuple).every((value) => value === null)) return tuple;
  if (Object.values(tuple).some((value) => value === null)) {
    throw new Error(
      'Agent model defaults require providerInstallationId, provider, model, and thinking level together.',
    );
  }
  if (!PROVIDER_INSTALLATION_ID_PATTERN.test(tuple.defaultProviderInstallationId!)) {
    throw new Error('Agent model default providerInstallationId is invalid.');
  }
  return tuple;
}

export function normalizeManagedAgentId(agentId?: string | null): string {
  const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  if (!normalized) {
    return DEFAULT_MANAGED_AGENT_ID;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('Invalid agentId.');
  }
  return normalizeMainAgentIdAlias(normalized);
}

function mapAgent(row: typeof agents.$inferSelect): AgentProfile {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    iconId: normalizeAgentIconId(row.iconId),
    type: row.type,
    removable: Boolean(row.removable),
    defaultProviderInstallationId: row.defaultProviderInstallationId ?? null,
    defaultProvider: row.defaultProvider ?? null,
    defaultModel: row.defaultModel ?? null,
    defaultThinking: normalizeThinking(row.defaultThinking),
    enabledTools: parseEnabledTools(row.enabledToolsJson),
    relevantSkills: parseStringList(row.relevantSkillsJson),
    relevantConnections: parseStringList(row.relevantConnectionsJson),
    scopeType: row.scopeType === 'system' || isSystemManagedAgentId(row.agentId)
      ? 'system'
      : row.scopeType === 'organization'
        ? 'organization'
        : 'user',
    organizationId: row.organizationId ?? null,
    ownerUserId: row.ownerUserId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    revision: row.revision || 1,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeThinking(value?: string | null): PiThinkingLevel | null {
  const normalized = value?.trim();
  return normalized && THINKING_LEVELS.has(normalized as PiThinkingLevel) ? normalized as PiThinkingLevel : null;
}

function normalizeStringList(value?: string[] | null): string[] | null {
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

function normalizeEnabledTools(value?: string[] | null): string[] | null {
  return normalizeStringList(value);
}

function parseEnabledTools(value?: string | null): string[] | null {
  return parseStringList(value);
}

function parseStringList(value?: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeStringList(Array.isArray(parsed) ? parsed : null);
  } catch {
    return null;
  }
}

function stringifyEnabledTools(value?: string[] | null): string | null {
  const normalized = normalizeEnabledTools(value);
  return normalized ? JSON.stringify(normalized) : null;
}

function stringifyStringList(value?: string[] | null): string | null {
  const normalized = normalizeStringList(value);
  return normalized ? JSON.stringify(normalized) : null;
}

export async function ensureCanvasAgent(): Promise<AgentProfile> {
  const now = new Date();
  await db
    .insert(agents)
    .values({
      agentId: DEFAULT_MANAGED_AGENT_ID,
      name: MAIN_AGENT_DISPLAY_NAME,
      iconId: DEFAULT_AGENT_ICON_ID,
      type: 'main',
      removable: false,
      scopeType: 'system',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  let row = await db.query.agents.findFirst({
    where: eq(agents.agentId, DEFAULT_MANAGED_AGENT_ID),
  });

  if (!row) {
    throw new Error('Bradley could not be loaded.');
  }

  if (LEGACY_MAIN_AGENT_DISPLAY_NAMES.has(row.name)) {
    await db
      .update(agents)
      .set({
        name: MAIN_AGENT_DISPLAY_NAME,
        revision: sql`${agents.revision} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(agents.agentId, DEFAULT_MANAGED_AGENT_ID),
        eq(agents.name, row.name),
      ));

    row = await db.query.agents.findFirst({
      where: eq(agents.agentId, DEFAULT_MANAGED_AGENT_ID),
    });
    if (!row) {
      throw new Error('Bradley could not be loaded after the display-name migration.');
    }
  }

  return mapAgent(row);
}

export async function ensureEmailAgent(): Promise<AgentProfile> {
  const now = new Date();
  await db
    .insert(agents)
    .values({
      agentId: EMAIL_MANAGED_AGENT_ID,
      name: 'Email Agent',
      iconId: 'messages',
      type: 'special',
      removable: false,
      enabledToolsJson: JSON.stringify(EMAIL_AGENT_DEFAULT_ENABLED_TOOLS),
      scopeType: 'system',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const row = await db.query.agents.findFirst({
    where: eq(agents.agentId, EMAIL_MANAGED_AGENT_ID),
  });
  if (!row) throw new Error('Email Agent could not be loaded.');
  const configuredTools = parseEnabledTools(row.enabledToolsJson);
  const isUnmodifiedLegacyProfile = [
    LEGACY_EMAIL_AGENT_DEFAULT_ENABLED_TOOLS,
    PREVIOUS_EMAIL_AGENT_DEFAULT_ENABLED_TOOLS,
  ].some((defaultTools) => (
    configuredTools?.length === defaultTools.length
      && configuredTools.every((tool, index) => tool === defaultTools[index])
  ));
  if (isUnmodifiedLegacyProfile) {
    await db.update(agents).set({
      enabledToolsJson: JSON.stringify(EMAIL_AGENT_DEFAULT_ENABLED_TOOLS),
      revision: row.revision + 1,
      updatedAt: now,
    }).where(eq(agents.id, row.id));
    return mapAgent({ ...row, enabledToolsJson: JSON.stringify(EMAIL_AGENT_DEFAULT_ENABLED_TOOLS), revision: row.revision + 1, updatedAt: now });
  }
  return mapAgent(row);
}

/**
 * Provisions the reserved memory-review runtime identity without adding it to
 * the managed chat-agent registry. Its restricted policy and empty tool set
 * keep it non-interactive while still allowing the runtime resolver to audit
 * model calls against a real agent record.
 */
export async function ensureMemoryManagerAgent(): Promise<AgentProfile> {
  const now = new Date();
  await db
    .insert(agents)
    .values({
      agentId: MEMORY_MANAGER_AGENT_ID,
      name: MEMORY_MANAGER_AGENT_NAME,
      iconId: 'brain',
      type: 'system-worker',
      removable: false,
      enabledToolsJson: JSON.stringify([DISABLED_ALL_TOOLS_SENTINEL]),
      accessPolicy: 'restricted',
      scopeType: 'system',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  let row = await db.query.agents.findFirst({
    where: eq(agents.agentId, MEMORY_MANAGER_AGENT_ID),
  });
  if (!row) throw new Error('Memory Review Agent could not be loaded.');
  const expectedTools = JSON.stringify([DISABLED_ALL_TOOLS_SENTINEL]);
  if (
    row.name !== MEMORY_MANAGER_AGENT_NAME
    || row.iconId !== 'brain'
    || row.type !== 'system-worker'
    || row.removable
    || row.enabledToolsJson !== expectedTools
    || row.accessPolicy !== 'restricted'
    || row.scopeType !== 'system'
  ) {
    await db.update(agents).set({
      name: MEMORY_MANAGER_AGENT_NAME,
      iconId: 'brain',
      type: 'system-worker',
      removable: false,
      enabledToolsJson: expectedTools,
      accessPolicy: 'restricted',
      scopeType: 'system',
      organizationId: null,
      ownerUserId: null,
      revision: row.revision + 1,
      updatedAt: now,
    }).where(eq(agents.id, row.id));
    row = await db.query.agents.findFirst({ where: eq(agents.agentId, MEMORY_MANAGER_AGENT_ID) });
    if (!row) throw new Error('Memory Review Agent could not be loaded after repair.');
  }
  return mapAgent(row);
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  await Promise.all([ensureCanvasAgent(), ensureEmailAgent()]);
  const rows = await db.select().from(agents).orderBy(asc(agents.type), asc(agents.name), asc(agents.createdAt));
  return rows.map(mapAgent);
}

export async function getAgentProfile(agentId?: string | null): Promise<AgentProfile | null> {
  const normalizedAgentId = normalizeManagedAgentId(agentId);
  if (normalizedAgentId === DEFAULT_MANAGED_AGENT_ID) {
    return ensureCanvasAgent();
  }
  if (normalizedAgentId === EMAIL_MANAGED_AGENT_ID) {
    return ensureEmailAgent();
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
  iconId?: AgentIconId | null;
  defaultProviderInstallationId?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinking?: PiThinkingLevel | null;
  enabledTools?: string[] | null;
  relevantSkills?: string[] | null;
  relevantConnections?: string[] | null;
  accessPolicy?: 'legacy' | 'restricted';
  scopeType?: 'user' | 'organization';
  organizationId?: string | null;
  ownerUserId?: string | null;
  createdByUserId?: string | null;
}): Promise<AgentProfile> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('Agent name is required.');
  }

  const agentId = normalizeManagedAgentId(input.agentId || slugifyAgentId(name));
  if (isSystemManagedAgentId(agentId) || agentId === MEMORY_MANAGER_AGENT_ID) {
    throw new Error('Built-in agents cannot be recreated.');
  }

  const agentDefault = normalizeAgentDefaultTuple(input);
  const scopeType = input.scopeType === 'organization' ? 'organization' : 'user';
  const organizationId = input.organizationId?.trim() || null;
  const ownerUserId = input.ownerUserId?.trim() || null;
  const createdByUserId = input.createdByUserId?.trim() || null;
  if (scopeType === 'organization' && !organizationId) {
    throw new Error('organizationId is required for an organization agent.');
  }
  if (scopeType === 'organization' && ownerUserId) {
    throw new Error('Organization agents cannot have a personal owner.');
  }
  if (scopeType === 'user' && organizationId && !ownerUserId) {
    throw new Error('ownerUserId is required for a personal organization member agent.');
  }

  const now = new Date();
  await db.insert(agents).values({
    agentId,
    name,
    iconId: normalizeAgentIconId(input.iconId),
    type: 'special',
    removable: true,
    ...agentDefault,
    enabledToolsJson: stringifyEnabledTools(input.enabledTools),
    relevantSkillsJson: stringifyStringList(input.relevantSkills),
    relevantConnectionsJson: stringifyStringList(input.relevantConnections),
    accessPolicy: input.accessPolicy === 'restricted' ? 'restricted' : 'legacy',
    scopeType,
    organizationId,
    ownerUserId,
    createdByUserId,
    revision: 1,
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
  iconId?: AgentIconId | null;
  defaultProviderInstallationId?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinking?: PiThinkingLevel | null;
  enabledTools?: string[] | null;
  relevantSkills?: string[] | null;
  relevantConnections?: string[] | null;
  scopeType?: 'user' | 'organization';
  organizationId?: string | null;
  ownerUserId?: string | null;
  expectedRevision?: number;
}): Promise<AgentProfile> {
  const agentId = normalizeManagedAgentId(input.agentId);
  const existing = await getAgentProfile(agentId);
  if (!existing) {
    throw new Error('Agent not found.');
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
    throw new AgentRevisionConflictError(existing.revision);
  }

  const nextName = input.name === undefined || input.name === null ? existing.name : input.name.trim();
  if (!nextName) {
    throw new Error('Agent name is required.');
  }

  const updatesAgentDefault = input.defaultProviderInstallationId !== undefined
    || input.defaultProvider !== undefined
    || input.defaultModel !== undefined
    || input.defaultThinking !== undefined;
  const agentDefault = updatesAgentDefault
    ? normalizeAgentDefaultTuple({
        defaultProviderInstallationId: input.defaultProviderInstallationId === undefined
          ? existing.defaultProviderInstallationId
          : input.defaultProviderInstallationId,
        defaultProvider: input.defaultProvider === undefined ? existing.defaultProvider : input.defaultProvider,
        defaultModel: input.defaultModel === undefined ? existing.defaultModel : input.defaultModel,
        defaultThinking: input.defaultThinking === undefined ? existing.defaultThinking : input.defaultThinking,
      })
    : null;

  const isSystemAgent = isSystemManagedAgentId(existing.agentId);
  const nextScopeType = isSystemAgent ? 'system' : (input.scopeType ?? existing.scopeType);
  const nextOrganizationId = input.organizationId === undefined
    ? existing.organizationId
    : input.organizationId?.trim() || null;
  const nextOwnerUserId = input.ownerUserId === undefined
    ? existing.ownerUserId
    : input.ownerUserId?.trim() || null;
  if (isSystemAgent && input.scopeType !== undefined) {
    throw new Error('Built-in agent scope cannot be changed.');
  }
  if (nextScopeType === 'organization' && !nextOrganizationId) {
    throw new Error('organizationId is required for an organization agent.');
  }
  if (nextScopeType === 'organization' && nextOwnerUserId) {
    throw new Error('Organization agents cannot have a personal owner.');
  }

  await db.update(agents)
    .set({
      name: nextName,
      iconId: input.iconId === undefined ? existing.iconId : normalizeAgentIconId(input.iconId),
      defaultProviderInstallationId: updatesAgentDefault
        ? agentDefault!.defaultProviderInstallationId
        : existing.defaultProviderInstallationId,
      defaultProvider: updatesAgentDefault ? agentDefault!.defaultProvider : existing.defaultProvider,
      defaultModel: updatesAgentDefault ? agentDefault!.defaultModel : existing.defaultModel,
      defaultThinking: updatesAgentDefault ? agentDefault!.defaultThinking : existing.defaultThinking,
      enabledToolsJson: input.enabledTools === undefined ? stringifyEnabledTools(existing.enabledTools) : stringifyEnabledTools(input.enabledTools),
      relevantSkillsJson: input.relevantSkills === undefined ? stringifyStringList(existing.relevantSkills) : stringifyStringList(input.relevantSkills),
      relevantConnectionsJson: input.relevantConnections === undefined ? stringifyStringList(existing.relevantConnections) : stringifyStringList(input.relevantConnections),
      scopeType: isSystemAgent ? 'system' : nextScopeType,
      organizationId: isSystemAgent ? null : nextOrganizationId,
      ownerUserId: isSystemAgent ? null : nextOwnerUserId,
      revision: sql`${agents.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(input.expectedRevision === undefined
      ? eq(agents.agentId, agentId)
      : and(eq(agents.agentId, agentId), eq(agents.revision, input.expectedRevision)));

  const updated = await getAgentProfile(agentId);
  if (!updated) {
    throw new Error('Agent could not be updated.');
  }
  if (
    input.expectedRevision !== undefined &&
    updated.revision !== input.expectedRevision + 1
  ) {
    throw new AgentRevisionConflictError(updated.revision);
  }
  return updated;
}

export async function deleteAgentProfile(agentIdInput: string, expectedRevision?: number): Promise<void> {
  const agentId = normalizeManagedAgentId(agentIdInput);
  const existing = await getAgentProfile(agentId);
  if (!existing) {
    throw new Error('Agent not found.');
  }
  if (!existing.removable) {
    throw new Error('Built-in agents cannot be removed.');
  }
  if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
    throw new AgentRevisionConflictError(existing.revision);
  }

  const sessions = await db.select({ id: piSessions.id }).from(piSessions).where(eq(piSessions.agentId, agentId));
  await deletePiSessionsByDbIds(sessions.map((session) => session.id));
  await db.delete(agents).where(expectedRevision === undefined
    ? eq(agents.agentId, agentId)
    : and(eq(agents.agentId, agentId), eq(agents.revision, expectedRevision)));
}
