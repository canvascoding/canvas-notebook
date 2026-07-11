import 'server-only';

import { openDb } from '@/app/lib/db';
import type {
  AiAppRuntimeCatalog,
  AiCatalogModel,
  AiProviderInstallation,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

type CatalogDefaultsRow = {
  provider_installation_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  thinking_level: string | null;
  catalog_revision: number | string | null;
  migration_state: string | null;
  legacy_source_hash: string | null;
  updated_by_user_id: string | null;
  updated_at: number | string | null;
};

type ProviderRow = {
  id: string;
  provider_id: string;
  display_name: string;
  source: string;
  credential_scope: string;
  enabled: number | string | boolean;
  status: string;
  config_json: string | null;
  revision: number | string;
  verified_at: number | string | null;
  verified_by_user_id: string | null;
};

type ModelRow = {
  provider_installation_id: string;
  model_id: string;
  display_name: string;
  enabled: number | string | boolean;
  is_provider_default: number | string | boolean;
  reasoning: number | string | boolean;
  supports_vision: number | string | boolean;
  thinking_levels_json: string;
  metadata_json: string | null;
  revision: number | string;
};

export type CatalogStoreProviderInput = Omit<AiProviderInstallation, 'verifiedAt' | 'models'> & {
  verifiedAt: number | null;
  models: AiCatalogModel[];
};

export type ReplaceCatalogStoreInput = {
  organizationId: string;
  actorUserId: string;
  expectedRevision: number;
  migrationState: AiAppRuntimeCatalog['migrationState'];
  defaultSelection: AiRuntimeSelection | null;
  providers: CatalogStoreProviderInput[];
};

export class CatalogRevisionConflictError extends Error {
  readonly code = 'CATALOG_REVISION_CONFLICT';
  readonly status = 409;

  constructor(public readonly currentRevision: number) {
    super(`Catalog revision conflict. Current revision is ${currentRevision}.`);
    this.name = 'CatalogRevisionConflictError';
  }
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoTimestamp(value: unknown): string | null {
  const numeric = numberValue(value, 0);
  return numeric > 0 ? new Date(numeric).toISOString() : null;
}

function parseJsonObject<T extends object>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function parseStoredProviderConfig(value: string | null): AiProviderInstallation['config'] {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid provider config');
    return parsed as AiProviderInstallation['config'];
  } catch {
    throw new Error('Stored AI runtime provider configuration is invalid.');
  }
}

function parseThinkingLevels(value: string): PiThinkingLevel[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('invalid thinking levels');
    const levels = parsed.filter((entry): entry is PiThinkingLevel => (
      entry === 'off' || entry === 'minimal' || entry === 'low' || entry === 'medium' || entry === 'high' || entry === 'xhigh'
    ));
    if (levels.length !== parsed.length || levels.length === 0) throw new Error('invalid thinking levels');
    return Array.from(new Set(levels));
  } catch {
    throw new Error('Stored AI runtime catalog model capabilities are invalid.');
  }
}

function parseCredentialScope(value: string): AiProviderInstallation['credentialScope'] {
  if (value === 'managed' || value === 'system' || value === 'organization' || value === 'user') return value;
  throw new Error('Stored AI runtime provider credential scope is invalid.');
}

function parseStoredThinkingLevel(value: string | null): PiThinkingLevel {
  if (value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value;
  }
  throw new Error('Stored AI runtime default intelligence is invalid.');
}

function normalizeMigrationState(value: unknown): AiAppRuntimeCatalog['migrationState'] {
  if (value === 'review_required' || value === 'configured' || value === 'migrated') return value;
  return 'uninitialized';
}

export async function readAppRuntimeCatalog(organizationId: string): Promise<AiAppRuntimeCatalog> {
  const connection = await openDb();
  try {
    const defaults = await connection.get(
      `SELECT provider_installation_id, provider_id, model_id, thinking_level, catalog_revision, migration_state,
              legacy_source_hash, updated_by_user_id, updated_at
       FROM ai_runtime_defaults
       WHERE organization_id = ?
       LIMIT 1`,
      [organizationId],
    ) as CatalogDefaultsRow | undefined;
    const providerRows = await connection.all(
      `SELECT id, provider_id, display_name, source, credential_scope, enabled, status,
              config_json, revision, verified_at, verified_by_user_id
       FROM ai_provider_installations
       WHERE organization_id = ?
       ORDER BY provider_id ASC`,
      [organizationId],
    ) as ProviderRow[];
    const modelRows = await connection.all(
      `SELECT provider_installation_id, model_id, display_name, enabled, is_provider_default,
              reasoning, supports_vision, thinking_levels_json, metadata_json, revision
       FROM ai_provider_models
       WHERE organization_id = ?
       ORDER BY provider_installation_id ASC, display_name ASC, model_id ASC`,
      [organizationId],
    ) as ModelRow[];

    const modelsByProvider = new Map<string, AiCatalogModel[]>();
    for (const row of modelRows) {
      const models = modelsByProvider.get(row.provider_installation_id) ?? [];
      models.push({
        id: row.model_id,
        name: row.display_name,
        enabled: booleanValue(row.enabled),
        isProviderDefault: booleanValue(row.is_provider_default),
        reasoning: booleanValue(row.reasoning),
        supportsVision: booleanValue(row.supports_vision),
        thinkingLevels: parseThinkingLevels(row.thinking_levels_json),
        metadata: parseJsonObject(row.metadata_json, {}),
        revision: numberValue(row.revision, 1),
      });
      modelsByProvider.set(row.provider_installation_id, models);
    }

    const providers: AiProviderInstallation[] = providerRows.map((row) => ({
      installationId: row.id,
      providerId: row.provider_id,
      name: row.display_name,
      source: row.source === 'managed' || row.source === 'self-hosted' ? row.source : 'built-in',
      credentialScope: parseCredentialScope(row.credential_scope),
      enabled: booleanValue(row.enabled),
      status: row.status === 'ready' || row.status === 'degraded' || row.status === 'disabled'
        ? row.status
        : 'unverified',
      config: parseStoredProviderConfig(row.config_json),
      revision: numberValue(row.revision, 1),
      verifiedAt: isoTimestamp(row.verified_at),
      verifiedByUserId: row.verified_by_user_id,
      models: modelsByProvider.get(row.id) ?? [],
    }));
    const defaultSelection = defaults?.provider_installation_id && defaults.provider_id && defaults.model_id
      ? {
          providerInstallationId: defaults.provider_installation_id,
          providerId: defaults.provider_id,
          modelId: defaults.model_id,
          thinkingLevel: parseStoredThinkingLevel(defaults.thinking_level),
        }
      : null;

    return {
      organizationId,
      revision: numberValue(defaults?.catalog_revision, 0),
      migrationState: normalizeMigrationState(defaults?.migration_state),
      legacySourceHash: defaults?.legacy_source_hash ?? null,
      defaultSelection,
      providers,
      updatedAt: isoTimestamp(defaults?.updated_at),
      updatedByUserId: defaults?.updated_by_user_id ?? null,
    };
  } finally {
    await connection.close?.();
  }
}

export async function replaceAppRuntimeCatalogStore(input: ReplaceCatalogStoreInput): Promise<number> {
  const connection = await openDb();
  let transactionStarted = false;
  try {
    await connection.run('BEGIN');
    transactionStarted = true;
    const current = await connection.get(
      `SELECT catalog_revision, legacy_source_hash
       FROM ai_runtime_defaults
       WHERE organization_id = ?
       LIMIT 1`,
      [input.organizationId],
    ) as { catalog_revision?: number | string | null; legacy_source_hash?: string | null } | undefined;
    const currentRevision = numberValue(current?.catalog_revision, 0);
    if (currentRevision !== input.expectedRevision) {
      throw new CatalogRevisionConflictError(currentRevision);
    }

    const nextRevision = currentRevision + 1;
    const now = Date.now();
    await connection.run('DELETE FROM ai_provider_models WHERE organization_id = ?', [input.organizationId]);
    await connection.run('DELETE FROM ai_provider_installations WHERE organization_id = ?', [input.organizationId]);

    for (const provider of input.providers) {
      await connection.run(
        `INSERT INTO ai_provider_installations (
          id, organization_id, provider_id, display_name, source, credential_scope,
          enabled, status, config_json, revision, verified_at, verified_by_user_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          provider.installationId,
          input.organizationId,
          provider.providerId,
          provider.name,
          provider.source,
          provider.credentialScope,
          provider.enabled ? 1 : 0,
          provider.status,
          JSON.stringify(provider.config),
          nextRevision,
          provider.verifiedAt,
          provider.verifiedByUserId,
          now,
          now,
        ],
      );
      for (const model of provider.models) {
        await connection.run(
          `INSERT INTO ai_provider_models (
            organization_id, provider_installation_id, model_id, display_name, enabled,
            is_provider_default, reasoning, supports_vision, thinking_levels_json,
            metadata_json, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.organizationId,
            provider.installationId,
            model.id,
            model.name,
            model.enabled ? 1 : 0,
            model.isProviderDefault ? 1 : 0,
            model.reasoning ? 1 : 0,
            model.supportsVision ? 1 : 0,
            JSON.stringify(model.thinkingLevels),
            JSON.stringify(model.metadata),
            nextRevision,
            now,
            now,
          ],
        );
      }
    }

    await connection.run(
      `INSERT INTO ai_runtime_defaults (
        organization_id, provider_installation_id, provider_id, model_id, thinking_level, catalog_revision,
        migration_state, legacy_source_hash, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organization_id) DO UPDATE SET
        provider_installation_id = excluded.provider_installation_id,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        thinking_level = excluded.thinking_level,
        catalog_revision = excluded.catalog_revision,
        migration_state = excluded.migration_state,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = excluded.updated_at`,
      [
        input.organizationId,
        input.defaultSelection?.providerInstallationId ?? null,
        input.defaultSelection?.providerId ?? null,
        input.defaultSelection?.modelId ?? null,
        input.defaultSelection?.thinkingLevel ?? 'off',
        nextRevision,
        input.migrationState,
        current?.legacy_source_hash ?? null,
        input.actorUserId,
        now,
        now,
      ],
    );
    await connection.run('COMMIT');
    transactionStarted = false;
    return nextRevision;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.run('ROLLBACK');
      } catch {
        // Preserve the original catalog update error.
      }
    }
    throw error;
  } finally {
    await connection.close?.();
  }
}
