import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { openDb } from '@/app/lib/db';
import { getLicenseStatus, getLicenseStatusOnConnection } from './index';
import type { LicenseStatus } from './types';

type SeatLimitDatabase = Pick<SqlConnection, 'get' | 'all' | 'close'>;

export type EffectiveSeatPolicy = {
  mode: 'solo' | 'team';
  seatLimit: number;
  reason:
    | 'team_license_active'
    | 'team_license_offline_grace'
    | 'team_reconciliation_restriction'
    | 'team_license_grace_expired'
    | 'team_license_downgraded'
    | 'team_license_inactive';
};

export type UserSeatAccess = {
  userId: string;
  organizationId: string | null;
  mode: EffectiveSeatPolicy['mode'];
  seatLimit: number;
  observedQuantity: number;
  overallocated: boolean;
};

export class SeatLimitGuardError extends Error {
  constructor(
    public readonly code:
      | 'SEAT_ACCESS_INACTIVE'
      | 'SEAT_MEMBERSHIP_REQUIRED'
      | 'SEAT_LIMIT_EXCEEDED'
      | 'SEAT_ACTIVATION_STALE',
    message: string,
    public readonly status = 403,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SeatLimitGuardError';
  }
}

function booleanFromDatabase(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function resolveEffectiveSeatPolicy(status: LicenseStatus): EffectiveSeatPolicy {
  const teamActive = status.licensed
    && (status.licenseState === 'active' || status.licenseState === 'grace')
    && status.edition === 'team'
    && typeof status.seatLimit === 'number'
    && Number.isSafeInteger(status.seatLimit)
    && status.seatLimit >= 1;
  if (teamActive) {
    return {
      mode: 'team',
      seatLimit: status.seatLimit!,
      reason: status.licenseState === 'grace'
        ? 'team_license_offline_grace'
        : 'team_license_active',
    };
  }
  if (status.licenseState === 'expired') {
    return {
      mode: 'solo',
      seatLimit: 1,
      reason: 'team_license_grace_expired',
    };
  }
  if (status.edition === 'solo' && status.licensed) {
    return {
      mode: 'solo',
      seatLimit: 1,
      reason: 'team_license_downgraded',
    };
  }
  return {
    mode: 'solo',
    seatLimit: 1,
    reason: 'team_license_inactive',
  };
}

type SeatOrganizationRow = { organization_id: string; owner_user_id: string };
type SeatAccountRow = { id: string; banned: number | boolean | string | null };

function reconciliationSeatLimitValue(row: { reconciliation_seat_limit?: number | string | null } | undefined): number | null {
  const value = Number(row?.reconciliation_seat_limit);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}
function restrictSeatPolicy(policy: EffectiveSeatPolicy, reconciliationLimit: number | null): EffectiveSeatPolicy {
  if (
    reconciliationLimit === null
    || reconciliationLimit >= policy.seatLimit
  ) {
    return policy;
  }
  return {
    mode: 'team',
    seatLimit: reconciliationLimit,
    reason: 'team_reconciliation_restriction',
  };
}
function assertActiveSeatAccount(row: SeatAccountRow | undefined): void {
  if (!row || booleanFromDatabase(row.banned)) {
    throw new SeatLimitGuardError(
      'SEAT_ACCESS_INACTIVE',
      'This account is not active.',
    );
  }
}
function requireTeamSeatOrganization(organization: SeatOrganizationRow | undefined): asserts organization is SeatOrganizationRow {
  if (!organization) {
    throw new SeatLimitGuardError(
      'SEAT_MEMBERSHIP_REQUIRED',
      'An active Team membership is required.',
    );
  }
}
function decideSoloSeatAccess(userId: string, policy: EffectiveSeatPolicy, organization: SeatOrganizationRow | undefined,
  allowedUserId: string | null, observedQuantity: number): UserSeatAccess {
  if (!allowedUserId || allowedUserId !== userId) {
    throw new SeatLimitGuardError(
      'SEAT_LIMIT_EXCEEDED',
      'Community Solo permits exactly one active user.',
      403,
      {
        mode: policy.mode,
        seatLimit: policy.seatLimit,
        observedQuantity,
        overallocated: observedQuantity > policy.seatLimit,
      },
    );
  }
  return {
    userId,
    organizationId: organization?.organization_id ?? null,
    mode: policy.mode,
    seatLimit: policy.seatLimit,
    observedQuantity,
    overallocated: observedQuantity > policy.seatLimit,
  };
}
function decideTeamSeatAccess(userId: string, policy: EffectiveSeatPolicy, organization: SeatOrganizationRow,
  observedQuantity: number, eligibleRows: Array<{ user_id: string }>): UserSeatAccess {
  const allowedUserIds = new Set(
    eligibleRows.slice(0, policy.seatLimit).map((row) => row.user_id),
  );
  if (!allowedUserIds.has(userId)) {
    throw new SeatLimitGuardError(
      observedQuantity > policy.seatLimit
        ? 'SEAT_LIMIT_EXCEEDED'
        : 'SEAT_MEMBERSHIP_REQUIRED',
      observedQuantity > policy.seatLimit
        ? 'The active Team membership count exceeds the signed Seat limit.'
        : 'An active Team membership is required.',
      403,
      {
        mode: policy.mode,
        seatLimit: policy.seatLimit,
        observedQuantity,
        overallocated: observedQuantity > policy.seatLimit,
      },
    );
  }
  return {
    userId,
    organizationId: organization.organization_id,
    mode: policy.mode,
    seatLimit: policy.seatLimit,
    observedQuantity,
    overallocated: observedQuantity > policy.seatLimit,
  };
}

export async function getTeamSeatReconciliationSeatLimit(
  database: Pick<SqlConnection, 'get'>,
  organizationId?: string,
): Promise<number | null> {
  const row = await database.get(
    organizationId
      ? `
          SELECT reconciliation_seat_limit
          FROM team_membership_sync_state
          WHERE organization_id = $1
          LIMIT 1
        `
      : `
          SELECT sync.reconciliation_seat_limit
          FROM team_membership_sync_state sync
          INNER JOIN canvas_organization_settings organization
            ON organization.organization_id = sync.organization_id
          ORDER BY organization.created_at ASC
          LIMIT 1
        `,
    organizationId ? [organizationId] : [],
  ) as { reconciliation_seat_limit?: number | string | null } | undefined;
  return reconciliationSeatLimitValue(row);
}

export async function applyTeamSeatReconciliationRestriction(
  database: Pick<SqlConnection, 'get'>,
  policy: EffectiveSeatPolicy,
  organizationId?: string,
): Promise<EffectiveSeatPolicy> {
  if (policy.mode !== 'team') return policy;
  const reconciliationLimit = await getTeamSeatReconciliationSeatLimit(
    database,
    organizationId,
  );
  return restrictSeatPolicy(policy, reconciliationLimit);
}

async function activeMembershipQuantity(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
): Promise<number> {
  const row = await database.get(`
    SELECT COUNT(*) AS count
    FROM team_memberships
    WHERE organization_id = $1
      AND status = 'active'
      AND user_id IS NOT NULL
      AND accepted_at IS NOT NULL
  `, [organizationId]) as { count?: number | string } | undefined;
  return Number(row?.count || 0);
}

async function requireUserAccount(
  database: Pick<SqlConnection, 'get'>,
  userId: string,
): Promise<void> {
  const row = await database.get(`
    SELECT id, banned
    FROM "user"
    WHERE id = $1
    LIMIT 1
  `, [userId]) as { id: string; banned: number | boolean | string | null } | undefined;
  assertActiveSeatAccount(row);
}

async function assertSoloUserAccess(
  database: Pick<SqlConnection, 'get'>,
  userId: string,
  policy: EffectiveSeatPolicy,
): Promise<UserSeatAccess> {
  const organization = await database.get(`
    SELECT organization_id, owner_user_id
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `) as { organization_id: string; owner_user_id: string } | undefined;
  const fallbackOwner = organization
    ? null
    : await database.get(`
        SELECT id
        FROM "user"
        WHERE COALESCE(banned, 0) = 0
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `) as { id: string } | undefined;
  const allowedUserId = organization?.owner_user_id ?? fallbackOwner?.id ?? null;
  const activeUsers = await database.get(`
    SELECT COUNT(*) AS count
    FROM "user"
    WHERE COALESCE(banned, 0) = 0
  `) as { count?: number | string } | undefined;
  const observedQuantity = Number(activeUsers?.count || 0);
  return decideSoloSeatAccess(userId, policy, organization, allowedUserId, observedQuantity);
}

async function assertTeamUserAccess(
  database: Pick<SqlConnection, 'get' | 'all'>,
  userId: string,
  policy: EffectiveSeatPolicy,
): Promise<UserSeatAccess> {
  const organization = await database.get(`
    SELECT organization_id, owner_user_id
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `) as { organization_id: string; owner_user_id: string } | undefined;
  requireTeamSeatOrganization(organization);
  const observedQuantity = await activeMembershipQuantity(
    database,
    organization.organization_id,
  );
  const eligibleRows = await database.all(`
    SELECT membership.user_id
    FROM team_memberships membership
    INNER JOIN "user" user_account
      ON user_account.id = membership.user_id
    INNER JOIN organization_user_permissions permission
      ON permission.organization_id = membership.organization_id
      AND permission.user_id = membership.user_id
    WHERE membership.organization_id = $1
      AND membership.status = 'active'
      AND membership.user_id IS NOT NULL
      AND membership.accepted_at IS NOT NULL
      AND COALESCE(user_account.banned, 0) = 0
      AND permission.status = 'active'
    ORDER BY
      CASE WHEN membership.user_id = $2 THEN 0 ELSE 1 END,
      CASE membership.role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        WHEN 'member' THEN 2
        WHEN 'external' THEN 3
        ELSE 4
      END,
      membership.activated_at ASC,
      membership.candidate_email ASC,
      membership.id ASC
  `, [
    organization.organization_id,
    organization.owner_user_id,
  ]) as Array<{ user_id: string }>;
  return decideTeamSeatAccess(userId, policy, organization, observedQuantity, eligibleRows);
}

type CurrentSeatSnapshotRow = {
  account_present: boolean; account_id: string; account_banned: SeatAccountRow['banned'];
  organization_present: boolean; organization_id: string; owner_user_id: string;
  reconciliation_seat_limit: number | string | null; fallback_owner_id: string | null;
  team_quantity: number | string; solo_quantity: number | string; eligible_user_ids: string[];
};

/** Internal actual-B read for an already captured signed license. This owns no
 * transaction, pool, authority or cache; every call reads all current seat facts
 * anew and returns only the ordinary seat decision. Other callers keep their
 * existing read path and share the exact same decision bodies above. */
export async function assertUserSeatAccessInSingleSnapshotOnConnection(
  database: Pick<SqlConnection, 'get'>,
  userId: string,
  licenseStatus: LicenseStatus,
): Promise<UserSeatAccess> {
  const basePolicy = resolveEffectiveSeatPolicy(licenseStatus);
  const row = await database.get(`WITH seat_account AS MATERIALIZED (
    SELECT id, banned FROM "user" WHERE id=$1 LIMIT 1
  ), primary_organization AS MATERIALIZED (
    SELECT organization_id, owner_user_id FROM canvas_organization_settings
    ORDER BY created_at ASC LIMIT 1
  ), reconciliation AS MATERIALIZED (
    SELECT sync.reconciliation_seat_limit
    FROM team_membership_sync_state sync
    INNER JOIN canvas_organization_settings organization
      ON organization.organization_id=sync.organization_id
    WHERE $2='team' ORDER BY organization.created_at ASC LIMIT 1
  ), team_quantity AS MATERIALIZED (
    SELECT COUNT(*) AS count FROM team_memberships
    WHERE $2='team' AND organization_id=(SELECT organization_id FROM primary_organization)
      AND status='active' AND user_id IS NOT NULL AND accepted_at IS NOT NULL
  ), solo_quantity AS MATERIALIZED (
    SELECT COUNT(*) AS count FROM "user" WHERE $2='solo' AND COALESCE(banned, 0)=0
  ) SELECT
    EXISTS(SELECT 1 FROM seat_account) AS account_present,
    (SELECT id FROM seat_account) AS account_id,
    (SELECT banned FROM seat_account) AS account_banned,
    EXISTS(SELECT 1 FROM primary_organization) AS organization_present,
    (SELECT organization_id FROM primary_organization) AS organization_id,
    (SELECT owner_user_id FROM primary_organization) AS owner_user_id,
    (SELECT reconciliation_seat_limit FROM reconciliation) AS reconciliation_seat_limit,
    (SELECT id FROM "user" WHERE $2='solo' AND NOT EXISTS(SELECT 1 FROM primary_organization)
      AND COALESCE(banned, 0)=0 ORDER BY created_at ASC, id ASC LIMIT 1) AS fallback_owner_id,
    (SELECT count FROM team_quantity) AS team_quantity,
    (SELECT count FROM solo_quantity) AS solo_quantity,
    ARRAY(SELECT membership.user_id FROM team_memberships membership
      INNER JOIN "user" user_account ON user_account.id=membership.user_id
      INNER JOIN organization_user_permissions permission
        ON permission.organization_id=membership.organization_id AND permission.user_id=membership.user_id
      WHERE $2='team' AND membership.organization_id=(SELECT organization_id FROM primary_organization)
        AND membership.status='active' AND membership.user_id IS NOT NULL
        AND membership.accepted_at IS NOT NULL AND COALESCE(user_account.banned, 0)=0 AND permission.status='active'
      ORDER BY CASE WHEN membership.user_id=(SELECT owner_user_id FROM primary_organization) THEN 0 ELSE 1 END,
        CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 WHEN 'external' THEN 3 ELSE 4 END,
        membership.activated_at ASC, membership.candidate_email ASC, membership.id ASC) AS eligible_user_ids`,
  [userId, basePolicy.mode]) as CurrentSeatSnapshotRow | undefined;
  assertActiveSeatAccount(row?.account_present === true ? { id: row.account_id, banned: row.account_banned } : undefined);
  const organization = row?.organization_present === true
    ? { organization_id: row.organization_id, owner_user_id: row.owner_user_id } : undefined;
  const policy = basePolicy.mode === 'team' ? restrictSeatPolicy(basePolicy, reconciliationSeatLimitValue(row)) : basePolicy;
  if (policy.mode === 'team') {
    requireTeamSeatOrganization(organization);
    return decideTeamSeatAccess(userId, policy, organization, Number(row?.team_quantity || 0),
      (row?.eligible_user_ids ?? []).map(user_id => ({ user_id })));
  }
  const fallbackOwner = row?.fallback_owner_id == null ? undefined : { id: row.fallback_owner_id };
  const allowedUserId = organization?.owner_user_id ?? fallbackOwner?.id ?? null;
  return decideSoloSeatAccess(userId, policy, organization, allowedUserId, Number(row?.solo_quantity || 0));
}

export async function assertUserSeatAccess(input: {
  userId: string;
  database?: SeatLimitDatabase;
  licenseStatus?: LicenseStatus;
  /** Internal held-transaction read: verify current signed storage without refresh or a global checkout. */
  readOnlyLicense?: boolean;
}): Promise<UserSeatAccess> {
  const licenseStatus = input.licenseStatus ?? await (input.readOnlyLicense && input.database
    ? getLicenseStatusOnConnection(input.database) : getLicenseStatus());
  const database = input.database ?? await openDb();
  const ownsDatabase = !input.database;
  try {
    await requireUserAccount(database, input.userId);
    const policy = await applyTeamSeatReconciliationRestriction(
      database,
      resolveEffectiveSeatPolicy(licenseStatus),
    );
    return await (policy.mode === 'team'
      ? assertTeamUserAccess(database, input.userId, policy)
      : assertSoloUserAccess(database, input.userId, policy));
  } finally {
    if (ownsDatabase) await database.close();
  }
}

export async function assertOrganizationSeatProjectionNotOverLimit(input: {
  organizationId: string;
  database?: SeatLimitDatabase;
  licenseStatus?: LicenseStatus;
}): Promise<{
  seatLimit: number;
  observedQuantity: number;
}> {
  const licenseStatus = input.licenseStatus ?? await getLicenseStatus();
  const database = input.database ?? await openDb();
  const ownsDatabase = !input.database;
  try {
    const policy = await applyTeamSeatReconciliationRestriction(
      database,
      resolveEffectiveSeatPolicy(licenseStatus),
      input.organizationId,
    );
    const observedQuantity = await activeMembershipQuantity(
      database,
      input.organizationId,
    );
    if (policy.mode !== 'team' || observedQuantity > policy.seatLimit) {
      throw new SeatLimitGuardError(
        'SEAT_LIMIT_EXCEEDED',
        'The current active membership count must be reconciled before adding another Team Seat.',
        409,
        {
          mode: policy.mode,
          seatLimit: policy.seatLimit,
          observedQuantity,
          overallocated: observedQuantity > policy.seatLimit,
        },
      );
    }
    return {
      seatLimit: policy.seatLimit,
      observedQuantity,
    };
  } finally {
    if (ownsDatabase) await database.close();
  }
}

export async function assertSeatActivationCapacity(
  database: Pick<SqlConnection, 'get'>,
  input: {
    organizationId: string;
    desiredQuantity: number;
    signedSeatLimit: number;
  },
): Promise<{ observedQuantity: number }> {
  const observedQuantity = await activeMembershipQuantity(
    database,
    input.organizationId,
  );
  const reconciliationLimit = await getTeamSeatReconciliationSeatLimit(
    database,
    input.organizationId,
  );
  const effectiveSeatLimit = reconciliationLimit === null
    ? input.signedSeatLimit
    : Math.min(input.signedSeatLimit, reconciliationLimit);
  if (
    !Number.isSafeInteger(effectiveSeatLimit)
    || effectiveSeatLimit < input.desiredQuantity
    || observedQuantity >= effectiveSeatLimit
    || observedQuantity + 1 !== input.desiredQuantity
  ) {
    throw new SeatLimitGuardError(
      observedQuantity >= effectiveSeatLimit
        ? 'SEAT_LIMIT_EXCEEDED'
        : 'SEAT_ACTIVATION_STALE',
      observedQuantity >= effectiveSeatLimit
        ? 'The effective Seat limit has no capacity for another active user.'
        : 'The active membership projection changed after the Seat quote was prepared.',
      409,
      {
        signedSeatLimit: input.signedSeatLimit,
        reconciliationSeatLimit: reconciliationLimit,
        effectiveSeatLimit,
        desiredQuantity: input.desiredQuantity,
        observedQuantity,
      },
    );
  }
  return { observedQuantity };
}
