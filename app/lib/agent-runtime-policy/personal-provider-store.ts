import 'server-only';

import { createHash } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { getProviderConnectionId, isOAuthProvider } from '@/app/lib/pi/oauth';
import { providerUsesOAuth } from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import { ProviderVerificationStoreConflictError } from '@/app/lib/agent-runtime-policy/catalog-store';
import type { AiPersonalProviderVerification, AiProviderInstallation } from '@/app/lib/agent-runtime-policy/types';

export function isPersonalOAuthProvider(provider: AiProviderInstallation): boolean {
  return provider.credentialScope === 'user' && providerUsesOAuth(provider) && isOAuthProvider(provider.providerId);
}

/** Status-only admin checks do not change the executable target or invalidate another owner's test. */
export function personalProviderTargetFingerprint(provider: AiProviderInstallation): string {
  return createHash('sha256').update(JSON.stringify({
    providerId: provider.providerId, source: provider.source, config: provider.config,
    sourceRevision: provider.sourceRevision,
    models: provider.models.filter(model => model.enabled).map(model => ({
      id: model.id, default: model.isProviderDefault, reasoning: model.reasoning,
      supportsVision: model.supportsVision, thinkingLevels: [...model.thinkingLevels].sort(), metadata: model.metadata,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  })).digest('hex');
}

export function personalProviderConnectionId(provider: AiProviderInstallation, userId: string): string | null {
  return isOAuthProvider(provider.providerId) ? getProviderConnectionId(provider.providerId, { userId }) : null;
}

export type PersonalProviderRecord = {
  connection_id: string;
  target_fingerprint: string;
  model_id: string;
  status: AiPersonalProviderVerification['status'];
  failure_code: string | null;
  verified_at: number | string | null;
  checked_at: number | string;
  revision: number | string;
};

export async function readPersonalProviderRecord(input: {
  organizationId: string; userId: string; providerInstallationId: string;
}): Promise<PersonalProviderRecord | undefined> {
  const db = await openDb();
  try {
    return await db.get(
      `SELECT connection_id, target_fingerprint, model_id, status, failure_code, verified_at, checked_at, revision
       FROM ai_user_provider_verifications
       WHERE organization_id = $1 AND user_id = $2 AND provider_installation_id = $3`,
      [input.organizationId, input.userId, input.providerInstallationId],
    ) as PersonalProviderRecord | undefined;
  } finally { await db.close(); }
}

const UNVERIFIED: AiPersonalProviderVerification = { status: 'unverified', verifiedAt: null, checkedAt: null, failureCode: null };

function isoTimestamp(value: number | string | null): string | null {
  return value && Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : null;
}

export async function readPersonalProviderVerification(input: {
  organizationId: string; userId: string; provider: AiProviderInstallation;
}): Promise<AiPersonalProviderVerification> {
  const connectionId = personalProviderConnectionId(input.provider, input.userId);
  if (!connectionId) return { ...UNVERIFIED };
  const record = await readPersonalProviderRecord({ ...input, providerInstallationId: input.provider.installationId });
  if (!record || record.connection_id !== connectionId || record.target_fingerprint !== personalProviderTargetFingerprint(input.provider)) {
    return { ...UNVERIFIED };
  }
  return {
    status: record.status, verifiedAt: isoTimestamp(record.verified_at), checkedAt: isoTimestamp(record.checked_at),
    failureCode: record.failure_code,
  };
}

/** CAS prevents a slower concurrent test from replacing a newer owner result. No catalog status is changed. */
export async function writePersonalProviderVerification(input: {
  organizationId: string; userId: string; provider: AiProviderInstallation; modelId: string;
  catalogRevision: number; connectionId: string; expectedRevision: number;
  status: AiPersonalProviderVerification['status']; failureCode: string | null;
  verifiedAt: number | null; checkedAt: number;
}): Promise<void> {
  const db = await openDb();
  let transaction = false;
  try {
    await db.run('BEGIN'); transaction = true;
    const catalog = await db.get('SELECT catalog_revision FROM ai_runtime_defaults WHERE organization_id = $1 FOR UPDATE', [input.organizationId]) as { catalog_revision: number } | undefined;
    const provider = await db.get(
      'SELECT revision, enabled, status FROM ai_provider_installations WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      [input.organizationId, input.provider.installationId],
    ) as { revision: number; enabled: number | boolean; status: string } | undefined;
    if (!catalog || Number(catalog.catalog_revision) !== input.catalogRevision || !provider || Number(provider.enabled) !== 1
      || provider.status === 'disabled' || Number(provider.revision) !== input.provider.revision
      || personalProviderConnectionId(input.provider, input.userId) !== input.connectionId) {
      throw new ProviderVerificationStoreConflictError();
    }
    const current = await db.get(
      'SELECT revision FROM ai_user_provider_verifications WHERE organization_id = $1 AND user_id = $2 AND provider_installation_id = $3 FOR UPDATE',
      [input.organizationId, input.userId, input.provider.installationId],
    ) as { revision: number } | undefined;
    if (Number(current?.revision ?? 0) !== input.expectedRevision) throw new ProviderVerificationStoreConflictError();
    const result = await db.run(
      `INSERT INTO ai_user_provider_verifications
       (organization_id, user_id, provider_installation_id, connection_id, target_fingerprint, model_id, status, failure_code, verified_at, checked_at, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
       ON CONFLICT (organization_id, user_id, provider_installation_id) DO UPDATE SET
       connection_id = excluded.connection_id, target_fingerprint = excluded.target_fingerprint, model_id = excluded.model_id,
       status = excluded.status, failure_code = excluded.failure_code, verified_at = excluded.verified_at,
       checked_at = excluded.checked_at, revision = ai_user_provider_verifications.revision + 1
       WHERE ai_user_provider_verifications.revision = $11`,
      [input.organizationId, input.userId, input.provider.installationId, input.connectionId, personalProviderTargetFingerprint(input.provider),
        input.modelId, input.status, input.failureCode, input.verifiedAt, input.checkedAt, input.expectedRevision],
    ) as { changes?: number; rowCount?: number };
    if (Number(result.changes ?? result.rowCount) !== 1) throw new ProviderVerificationStoreConflictError();
    await db.run('COMMIT'); transaction = false;
  } catch (error) {
    if (transaction) { try { await db.run('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
    throw error;
  } finally { await db.close(); }
}
