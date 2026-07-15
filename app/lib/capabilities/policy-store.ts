import 'server-only';

import { randomUUID } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import type {
  CapabilityPolicy,
  CapabilityPolicyEffect,
  CapabilityPolicyTargetType,
  CapabilityResourceType,
} from './types';

type CapabilityPolicyRow = {
  id: string;
  organization_id: string;
  resource_type: string;
  resource_id: string;
  target_type: string;
  target_id: string;
  effect: string;
  revision: number;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: number;
  updated_at: number;
};

export class CapabilityPolicyConflictError extends Error {
  readonly code = 'CAPABILITY_POLICY_REVISION_CONFLICT';
  readonly status = 409;

  constructor(message = 'Capability policy changed since it was inspected.') {
    super(message);
    this.name = 'CapabilityPolicyConflictError';
  }
}

function mapPolicy(row: CapabilityPolicyRow): CapabilityPolicy {
  return {
    id: row.id,
    organizationId: row.organization_id,
    resourceType: row.resource_type as CapabilityResourceType,
    resourceId: row.resource_id,
    targetType: row.target_type as CapabilityPolicyTargetType,
    targetId: row.target_id,
    effect: row.effect as CapabilityPolicyEffect,
    revision: Number(row.revision),
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function changedRowCount(result: unknown): number | null {
  if (!result || typeof result !== 'object' || !('changes' in result)) return null;
  const changes = Number((result as { changes?: unknown }).changes);
  return Number.isFinite(changes) ? changes : null;
}

export class CapabilityPolicyStore {
  constructor(private readonly connection: SqlConnection) {}

  async listOrganizationPolicies(organizationId: string): Promise<CapabilityPolicy[]> {
    const rows = await this.connection.all(
      `SELECT * FROM capability_policies WHERE organization_id = ? ORDER BY resource_type, resource_id, target_type, target_id`,
      [organizationId],
    ) as CapabilityPolicyRow[];
    return rows.map(mapPolicy);
  }

  async getPolicy(id: string): Promise<CapabilityPolicy | null> {
    const row = await this.connection.get(
      `SELECT * FROM capability_policies WHERE id = ?`,
      [id],
    ) as CapabilityPolicyRow | undefined;
    return row ? mapPolicy(row) : null;
  }

  async upsertPolicy(input: {
    organizationId: string;
    resourceType: CapabilityResourceType;
    resourceId: string;
    targetType: CapabilityPolicyTargetType;
    targetId: string;
    effect: CapabilityPolicyEffect;
    actorUserId: string;
    expectedRevision?: number | null;
  }): Promise<CapabilityPolicy> {
    const existing = await this.connection.get(
      `SELECT * FROM capability_policies
       WHERE organization_id = ? AND resource_type = ? AND resource_id = ? AND target_type = ? AND target_id = ?`,
      [input.organizationId, input.resourceType, input.resourceId, input.targetType, input.targetId],
    ) as CapabilityPolicyRow | undefined;

    if (existing) {
      if (input.expectedRevision != null && Number(existing.revision) !== input.expectedRevision) {
        throw new CapabilityPolicyConflictError();
      }
      const nextRevision = Number(existing.revision) + 1;
      const updatedAt = Date.now();
      const updateResult = await this.connection.run(
        `UPDATE capability_policies
         SET effect = ?, revision = ?, updated_by_user_id = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [input.effect, nextRevision, input.actorUserId, updatedAt, existing.id, existing.revision],
      );
      if (changedRowCount(updateResult) === 0) {
        throw new CapabilityPolicyConflictError();
      }
      const updated = await this.getPolicy(existing.id);
      if (!updated || updated.revision !== nextRevision) {
        throw new CapabilityPolicyConflictError();
      }
      return updated;
    }

    if (input.expectedRevision != null && input.expectedRevision !== 0) {
      throw new CapabilityPolicyConflictError('Capability policy no longer exists at the expected revision.');
    }
    const now = Date.now();
    const id = `cap-policy-${randomUUID()}`;
    try {
      await this.connection.run(
        `INSERT INTO capability_policies (
          id, organization_id, resource_type, resource_id, target_type, target_id,
          effect, revision, created_by_user_id, updated_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [
          id,
          input.organizationId,
          input.resourceType,
          input.resourceId,
          input.targetType,
          input.targetId,
          input.effect,
          input.actorUserId,
          input.actorUserId,
          now,
          now,
        ],
      );
    } catch (error) {
      const racedPolicy = await this.connection.get(
        `SELECT id FROM capability_policies
         WHERE organization_id = ? AND resource_type = ? AND resource_id = ? AND target_type = ? AND target_id = ?`,
        [input.organizationId, input.resourceType, input.resourceId, input.targetType, input.targetId],
      );
      if (racedPolicy) {
        throw new CapabilityPolicyConflictError();
      }
      throw error;
    }
    const created = await this.getPolicy(id);
    if (!created) throw new Error('Failed to persist capability policy.');
    return created;
  }

  async deletePolicy(input: {
    id: string;
    organizationId: string;
    expectedRevision: number;
  }): Promise<CapabilityPolicy> {
    const existing = await this.getPolicy(input.id);
    if (!existing || existing.organizationId !== input.organizationId) {
      throw new CapabilityPolicyConflictError('Capability policy does not exist.');
    }
    if (existing.revision !== input.expectedRevision) {
      throw new CapabilityPolicyConflictError();
    }
    const deleteResult = await this.connection.run(
      `DELETE FROM capability_policies WHERE id = ? AND organization_id = ? AND revision = ?`,
      [input.id, input.organizationId, input.expectedRevision],
    );
    if (changedRowCount(deleteResult) === 0) {
      throw new CapabilityPolicyConflictError();
    }
    const persisted = await this.getPolicy(input.id);
    if (persisted) throw new CapabilityPolicyConflictError();
    return existing;
  }
}

export async function withCapabilityPolicyStore<T>(
  operation: (store: CapabilityPolicyStore) => Promise<T>,
): Promise<T> {
  const connection = await openDb();
  try {
    return await operation(new CapabilityPolicyStore(connection));
  } finally {
    await connection.close();
  }
}
