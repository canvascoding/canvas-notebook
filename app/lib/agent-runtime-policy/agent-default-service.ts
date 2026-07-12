import 'server-only';

import { AiRuntimeInputError, parseRuntimeSelection } from '@/app/lib/agent-runtime-policy/runtime-service';
import type { AiRuntimeSelection } from '@/app/lib/agent-runtime-policy/types';
import { getDatabaseProvider, openDb } from '@/app/lib/db';

export class AgentDefaultPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
    public readonly currentCatalogRevision?: number,
  ) {
    super(message);
    this.name = 'AgentDefaultPolicyError';
  }
}

export type AgentDefaultFields = {
  providerInstallationId?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
};

function normalizedOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseAgentDefaultFields(input: AgentDefaultFields): AiRuntimeSelection | null {
  const values = {
    providerInstallationId: normalizedOptionalString(input.providerInstallationId),
    providerId: normalizedOptionalString(input.providerId),
    modelId: normalizedOptionalString(input.modelId),
    thinkingLevel: normalizedOptionalString(input.thinkingLevel),
  };
  if (Object.values(values).every((value) => value === null)) return null;
  if (Object.values(values).some((value) => value === null)) {
    throw new AiRuntimeInputError(
      'INCOMPLETE_AGENT_DEFAULT',
      'providerInstallationId, providerId, modelId, and thinkingLevel must be set together.',
    );
  }
  return parseRuntimeSelection(values);
}

export function parseAgentDefaultCatalogRevision(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AiRuntimeInputError(
      'INVALID_CATALOG_REVISION',
      'expectedCatalogRevision must be a non-negative integer.',
    );
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function affectedRows(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const result = value as { changes?: unknown; rowCount?: unknown };
  return numberValue(result.changes ?? result.rowCount);
}

function storedThinkingLevels(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Catalog validation and the agent-default write share one database
 * transaction. SQLite obtains the write lock up front; Postgres locks the
 * catalog-default row so a catalog revision cannot commit between validation
 * and the agent update.
 */
export async function writeAgentDefaultWithCatalogValidation(input: {
  organizationId: string;
  agentId: string;
  selection: AiRuntimeSelection | null;
  expectedCatalogRevision?: number;
}): Promise<{ catalogRevision: number | null }> {
  const connection = await openDb();
  let transactionStarted = false;
  try {
    await connection.run(getDatabaseProvider() === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    transactionStarted = true;

    let catalogRevision: number | null = null;
    if (input.selection) {
      if (input.expectedCatalogRevision === undefined) {
        throw new AiRuntimeInputError(
          'INVALID_CATALOG_REVISION',
          'expectedCatalogRevision is required for an agent model default.',
        );
      }
      const defaults = await connection.get(
        `SELECT catalog_revision
         FROM ai_runtime_defaults
         WHERE organization_id = ?
         LIMIT 1${getDatabaseProvider() === 'postgres' ? ' FOR UPDATE' : ''}`,
        [input.organizationId],
      ) as { catalog_revision?: unknown } | undefined;
      catalogRevision = numberValue(defaults?.catalog_revision);
      if (catalogRevision !== input.expectedCatalogRevision) {
        throw new AgentDefaultPolicyError(
          'AGENT_DEFAULT_CATALOG_REVISION_CONFLICT',
          'The AI runtime catalog changed. Reload the available models and try again.',
          409,
          catalogRevision,
        );
      }

      const provider = await connection.get(
        `SELECT provider_id, enabled, status
         FROM ai_provider_installations
         WHERE organization_id = ? AND id = ?
         LIMIT 1`,
        [input.organizationId, input.selection.providerInstallationId],
      ) as { provider_id?: string; enabled?: unknown; status?: string } | undefined;
      if (!provider || !booleanValue(provider.enabled)) {
        throw new AgentDefaultPolicyError(
          'PROVIDER_INSTALLATION_NOT_ALLOWED',
          'Agent defaults must use an enabled provider installation from the app catalog.',
        );
      }
      if (provider.status !== 'ready') {
        throw new AgentDefaultPolicyError('PROVIDER_NOT_READY', 'The selected provider installation is not ready.');
      }
      if (provider.provider_id !== input.selection.providerId) {
        throw new AgentDefaultPolicyError(
          'PROVIDER_ID_MISMATCH',
          'The selected provider does not match its provider installation.',
        );
      }

      const model = await connection.get(
        `SELECT enabled, thinking_levels_json
         FROM ai_provider_models
         WHERE organization_id = ? AND provider_installation_id = ? AND model_id = ?
         LIMIT 1`,
        [input.organizationId, input.selection.providerInstallationId, input.selection.modelId],
      ) as { enabled?: unknown; thinking_levels_json?: unknown } | undefined;
      if (!model || !booleanValue(model.enabled)) {
        throw new AgentDefaultPolicyError(
          'MODEL_NOT_ALLOWED',
          'Agent defaults must use an enabled model from the app catalog.',
        );
      }
      if (!storedThinkingLevels(model.thinking_levels_json).includes(input.selection.thinkingLevel)) {
        throw new AgentDefaultPolicyError(
          'INVALID_INTELLIGENCE',
          'The selected intelligence level is not supported by this model.',
        );
      }
    }

    const update = await connection.run(
      `UPDATE agents
       SET default_provider_installation_id = ?, default_provider = ?, default_model = ?,
           default_thinking = ?, updated_at = ?
       WHERE agent_id = ? AND type <> 'main'`,
      [
        input.selection?.providerInstallationId ?? null,
        input.selection?.providerId ?? null,
        input.selection?.modelId ?? null,
        input.selection?.thinkingLevel ?? null,
        Date.now(),
        input.agentId,
      ],
    );
    if (affectedRows(update) !== 1) {
      throw new AiRuntimeInputError('AGENT_NOT_FOUND', 'Specialized agent not found.');
    }

    await connection.run('COMMIT');
    transactionStarted = false;
    return { catalogRevision };
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original validation/write failure.
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }
}

export function agentDefaultErrorResponse(error: unknown): {
  status: number;
  code: string;
  message: string;
  currentCatalogRevision?: number;
} {
  if (error instanceof AiRuntimeInputError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof AgentDefaultPolicyError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.currentCatalogRevision === undefined
        ? {}
        : { currentCatalogRevision: error.currentCatalogRevision }),
    };
  }
  return {
    status: 500,
    code: 'AGENT_DEFAULT_UPDATE_FAILED',
    message: 'Failed to update the agent model default.',
  };
}
