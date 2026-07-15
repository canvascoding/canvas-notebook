import 'server-only';

import { randomUUID } from 'node:crypto';

import { openDb } from '@/app/lib/db';
export type AgentCapabilityBindingInput = {
  resourceType: 'skill' | 'plugin' | 'connection';
  scopeType: 'system' | 'organization' | 'user';
  resourceId: string;
  name: string;
  version?: string;
  requirement?: 'optional' | 'required';
};

export type AgentCapabilityBinding = {
  id: string;
  agentId: string;
  resourceType: 'skill' | 'plugin' | 'connection';
  scopeType: 'system' | 'organization' | 'user';
  resourceId: string;
  name: string;
  version: string;
  requirement: 'optional' | 'required';
  revision: number;
};

type BindingRow = {
  id: string;
  agent_id: string;
  resource_type: AgentCapabilityBinding['resourceType'];
  scope_type: AgentCapabilityBinding['scopeType'];
  resource_id: string;
  name: string;
  version: string;
  requirement: AgentCapabilityBinding['requirement'];
  revision: number | string;
};

function mapBinding(row: BindingRow): AgentCapabilityBinding {
  return {
    id: row.id,
    agentId: row.agent_id,
    resourceType: row.resource_type,
    scopeType: row.scope_type,
    resourceId: row.resource_id,
    name: row.name,
    version: row.version,
    requirement: row.requirement,
    revision: Number(row.revision) || 1,
  };
}

function normalizeBinding(input: AgentCapabilityBindingInput): Omit<AgentCapabilityBinding, 'id' | 'agentId' | 'revision'> {
  const resourceType = input.resourceType;
  if (resourceType !== 'skill' && resourceType !== 'plugin' && resourceType !== 'connection') {
    throw new Error('Agent capability resourceType is invalid.');
  }
  if (input.scopeType !== 'system' && input.scopeType !== 'organization' && input.scopeType !== 'user') {
    throw new Error('Agent capability scopeType is invalid.');
  }
  const resourceId = input.resourceId?.trim();
  const name = input.name?.trim();
  if (!resourceId || !name) throw new Error('Agent capability resourceId and name are required.');
  return {
    resourceType,
    scopeType: input.scopeType,
    resourceId,
    name,
    version: input.version?.trim() || 'unversioned',
    requirement: input.requirement === 'required' ? 'required' : 'optional',
  };
}

export async function listAgentCapabilityBindings(agentId: string): Promise<AgentCapabilityBinding[]> {
  const database = await openDb();
  try {
    const rows = await database.all(
      `SELECT id, agent_id, resource_type, scope_type, resource_id, name, version, requirement, revision
       FROM agent_capability_bindings
       WHERE agent_id = ?
       ORDER BY resource_type ASC, name ASC, resource_id ASC`,
      [agentId],
    ) as BindingRow[];
    return rows.map(mapBinding);
  } finally {
    await database.close();
  }
}

export async function replaceAgentCapabilityBindings(
  agentId: string,
  inputs: AgentCapabilityBindingInput[],
): Promise<AgentCapabilityBinding[]> {
  const normalized = inputs.map(normalizeBinding);
  const keys = new Set<string>();
  for (const binding of normalized) {
    const key = `${binding.resourceType}:${binding.scopeType}:${binding.resourceId}`;
    if (keys.has(key)) throw new Error(`Duplicate agent capability binding: ${key}`);
    keys.add(key);
  }

  const database = await openDb();
  try {
    await database.run('BEGIN');
    await database.run(`DELETE FROM agent_capability_bindings WHERE agent_id = ?`, [agentId]);
    const now = Date.now();
    for (const binding of normalized) {
      await database.run(
        `INSERT INTO agent_capability_bindings (
          id, agent_id, resource_type, scope_type, resource_id, name,
          version, requirement, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          `agent-binding-${randomUUID()}`,
          agentId,
          binding.resourceType,
          binding.scopeType,
          binding.resourceId,
          binding.name,
          binding.version,
          binding.requirement,
          now,
          now,
        ],
      );
    }
    await database.run('COMMIT');
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original write error.
    }
    throw error;
  } finally {
    await database.close();
  }
  return listAgentCapabilityBindings(agentId);
}
