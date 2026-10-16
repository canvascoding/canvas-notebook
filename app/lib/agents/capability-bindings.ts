import 'server-only';

import { randomUUID } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { AgentWorkflowError, parseStoredAgentWorkflowPackage, type StoredAgentWorkflowPackage, type AgentWorkflowStoredBinding } from './workflow-contracts';
import { assertStoredAgentExtensionBindingsMatchHeader, decodeStoredAgentExtensionBinding } from '@/app/lib/capabilities/extensions/stored-binding-dispatch';
import { parseStoredAgentWorkflowHeader } from './workflow-version';
import { parseStoredPackageExtensionBinding, type StoredPackageExtensionBinding } from '@/app/lib/capabilities/extensions/stored-package-contracts';
import { parseStoredStandaloneExtensionBinding, type StoredStandaloneExtensionBinding } from '@/app/lib/capabilities/extensions/stored-contracts';
import { parseStoredCoreExtensionBinding, type StoredCoreExtensionBinding } from '@/app/lib/capabilities/extensions/stored-core-contracts';
export type AgentCapabilityBindingInput = {
  resourceType: 'skill' | 'plugin' | 'connection';
  scopeType: 'system' | 'organization' | 'user';
  resourceId: string;
  name: string;
  version?: string;
  requirement?: 'optional' | 'required';
  /** Private server-only configuration, intentionally absent from public binding DTOs. */
  configuration?: StoredAgentWorkflowPackage | null;
  /** Exact V2 aggregate row. Public requests cannot directly populate this private field. */
  extensionConfiguration?: StoredPackageExtensionBinding | StoredStandaloneExtensionBinding | StoredCoreExtensionBinding;
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
  configuration_json?: string | null;
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

export async function listAgentCapabilityBindings(agentId: string, connection?: SqlConnection): Promise<AgentCapabilityBinding[]> {
  const database = connection ?? await openDb();
  try {
    const rows = await database.all(
      `SELECT id, agent_id, resource_type, scope_type, resource_id, name, version, requirement, revision
       FROM agent_capability_bindings
       WHERE agent_id = $1
       ORDER BY resource_type ASC, name ASC, resource_id ASC`,
      [agentId],
    ) as BindingRow[];
    return rows.map(mapBinding);
  } finally {
    if (!connection) await database.close();
  }
}

export async function replaceAgentCapabilityBindings(
  agentId: string,
  inputs: AgentCapabilityBindingInput[],
  connection?: SqlConnection,
  options: { workflowMutation?: boolean } = {},
): Promise<AgentCapabilityBinding[]> {
  const normalized = inputs.map(normalizeBinding);
  const keys = new Set<string>();
  for (const binding of normalized) {
    const key = `${binding.resourceType}:${binding.scopeType}:${binding.resourceId}`;
    if (keys.has(key)) throw new Error(`Duplicate agent capability binding: ${key}`);
    keys.add(key);
  }

  const database = connection ?? await openDb();
  try {
    if (!connection) await database.run('BEGIN');
    const header = await database.get('SELECT workflow_version FROM agents WHERE agent_id=$1', [agentId]) as { workflow_version?: unknown } | undefined;
    if (header?.workflow_version != null && options.workflowMutation !== true) {
      throw new AgentWorkflowError('AGENT_WORKFLOW_UPDATE_REQUIRED', 'Update the explicit workflow configuration to change its package bindings.', 409);
    }
    if (options.workflowMutation !== true && await database.get('SELECT id FROM agent_capability_bindings WHERE agent_id=$1 AND configuration_json IS NOT NULL LIMIT 1', [agentId])) {
      throw new AgentWorkflowError('AGENT_WORKFLOW_UPDATE_REQUIRED', 'The stored workflow must be explicitly reviewed before changing its package bindings.', 409);
    }
    await database.run(`DELETE FROM agent_capability_bindings WHERE agent_id = $1`, [agentId]);
    const now = Date.now();
    for (let index = 0; index < normalized.length; index++) {
      const binding = normalized[index];
      const input = inputs[index];
      if (input.configuration != null && input.extensionConfiguration !== undefined) {
        throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'A binding cannot carry two private formats.', 409);
      }
      const configuration = input.extensionConfiguration === undefined
        ? input.configuration == null ? null : parseStoredAgentWorkflowPackage(input.configuration)
        : (input.extensionConfiguration.kind === 'core_plugin' || input.extensionConfiguration.kind === 'core_skill') ? parseStoredCoreExtensionBinding(input.extensionConfiguration)
        : binding.resourceType === 'connection' ? parseStoredStandaloneExtensionBinding(input.extensionConfiguration)
          : parseStoredPackageExtensionBinding(input.extensionConfiguration);
      if (configuration && 'kind' in configuration && (configuration.kind === 'core_plugin' || configuration.kind === 'core_skill')) {
        const source = configuration.entry.selection.coreSource;
        if (binding.resourceType !== (configuration.kind === 'core_plugin' ? 'plugin' : 'skill') || binding.scopeType !== 'system' || binding.resourceId !== source.resourceRef
          || binding.version !== source.coreRevision || binding.name !== source.resourceRef.split(':').at(-1)) {
          throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The built-in plugin binding identity cannot be verified.', 409);
        }
      }
      await database.run(
        `INSERT INTO agent_capability_bindings (
          id, agent_id, resource_type, scope_type, resource_id, name,
          version, requirement, revision, created_at, updated_at, configuration_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11)`,
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
          configuration ? JSON.stringify(configuration) : null,
        ],
      );
    }
    if (options.workflowMutation === true) {
      const currentHeader = await database.get('SELECT workflow_version,workflow_revision FROM agents WHERE agent_id=$1', [agentId]) as
        { workflow_version?: unknown; workflow_revision?: unknown } | undefined;
      let version: ReturnType<typeof parseStoredAgentWorkflowHeader>;
      try { version = parseStoredAgentWorkflowHeader(currentHeader?.workflow_version, currentHeader?.workflow_revision); }
      catch { throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored extension header cannot be verified.', 409); }
      assertStoredAgentExtensionBindingsMatchHeader(version.workflowVersion, await listRawAgentCapabilityBindings(agentId, database));
    }
    const bindings = await listAgentCapabilityBindings(agentId, database);
    if (!connection) await database.run('COMMIT');
    return bindings;
  } catch (error) {
    if (!connection) {
      try {
        await database.run('ROLLBACK');
      } catch {
        // Preserve the original write error.
      }
    }
    throw error;
  } finally {
    if (!connection) await database.close();
  }
}

/** Internal only: normal list/inspect DTOs do not receive private connection bindings. */
export async function listRawAgentCapabilityBindings(agentId: string, connection?: SqlConnection): Promise<AgentWorkflowStoredBinding[]> {
  const database = connection ?? await openDb();
  try {
    const rows = await database.all(`SELECT * FROM agent_capability_bindings WHERE agent_id=$1 ORDER BY resource_type,name,resource_id`, [agentId]) as BindingRow[];
    return rows.map(row => {
      const decoded = decodeStoredAgentExtensionBinding(row.resource_type, row.configuration_json);
      if (decoded.coreConfiguration) {
        const source = decoded.coreConfiguration.entry.selection.coreSource;
        if (row.scope_type !== 'system' || row.resource_id !== source.resourceRef || row.version !== source.coreRevision || row.name !== source.resourceRef.split(':').at(-1)
          || row.requirement !== decoded.coreConfiguration.entry.requirement) {
          throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'The stored built-in plugin identity cannot be verified.', 409);
        }
      }
      return { ...mapBinding(row), ...decoded };
    });
  } finally { if (!connection) await database.close(); }
}
