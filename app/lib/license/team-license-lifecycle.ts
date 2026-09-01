import 'server-only';

import { randomUUID } from 'node:crypto';

import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';
import type { SqlConnection } from '@/app/lib/db';
import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';
import {
  getActiveTeamMembershipProjection,
} from '@/app/lib/organization/team-membership';
import {
  TEAM_LICENSE_FALLBACK_BAN_REASON,
} from '@/app/lib/organization/membership-ban-reasons';
import {
  recordTeamMembershipProjectionChange,
} from './team-seat-outbox';
import {
  applyTeamSeatReconciliationRestriction,
  resolveEffectiveSeatPolicy,
  type EffectiveSeatPolicy,
} from './seat-limit';
import type { LicenseStatus } from './types';

const LOG_PREFIX = '[license/team-lifecycle]';
const SOLO_FALLBACK_TRANSITION_REASON = 'team_license_solo_fallback';
const SEAT_REDUCTION_TRANSITION_REASON = 'team_license_seat_limit_reduction';
const TEAM_RESTORED_TRANSITION_REASON = 'team_license_reactivated';

type LifecycleDatabase = Pick<SqlConnection, 'get' | 'run' | 'all' | 'close'>;

type ActiveMembershipRow = {
  id: string;
  user_id: string;
  role: string;
  candidate_email: string;
  activated_at: number | null;
  user_banned: number | boolean | string | null;
  permission_status: string | null;
};

type SoloUserRow = {
  id: string;
};

type RestoreMembershipRow = {
  id: string;
  user_id: string;
  role: string;
  candidate_email: string;
  activated_at: number | null;
};

type OrganizationRow = {
  organization_id: string;
  owner_user_id: string;
};

export type TeamLicenseLifecycleMode = 'team' | 'solo';

export type TeamLicenseLifecycleResult = {
  mode: TeamLicenseLifecycleMode;
  reason: string;
  organizationId: string | null;
  ownerUserId: string | null;
  seatLimit: number;
  suspendedMemberships: number;
  restoredMemberships: number;
  disabledUsers: number;
  restoredUsers: number;
  revokedSessions: number;
  membershipRevision: number | null;
  remainingFallbackUsers: number;
  changed: boolean;
};

type TeamLicenseLifecycleOptions = {
  database?: LifecycleDatabase;
  databaseProvider?: DatabaseProvider;
  now?: Date;
};

type TeamLicensePolicy = EffectiveSeatPolicy;

type TeamLicenseLifecycleRuntime = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
  stopped: boolean;
  intervalMs: number;
};

type TeamLicenseLifecycleRuntimeGlobal = typeof globalThis & {
  __canvasTeamLicenseLifecycleRuntime?: TeamLicenseLifecycleRuntime;
};

function booleanFromDatabase(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function changesFromRunResult(result: unknown): number {
  if (result && typeof result === 'object' && 'changes' in result) {
    return Number((result as { changes?: unknown }).changes || 0);
  }
  return 0;
}

async function rollbackQuietly(database: LifecycleDatabase): Promise<void> {
  try {
    await database.run('ROLLBACK');
  } catch {
    // Preserve the original lifecycle error.
  }
}

async function appendLifecycleTransition(
  database: LifecycleDatabase,
  input: {
    membershipId: string;
    organizationId: string;
    fromStatus: 'active' | 'suspended';
    toStatus: 'active' | 'suspended';
    reason: string;
    licenseStatus: LicenseStatus;
    policy: TeamLicensePolicy;
    now: number;
  },
): Promise<void> {
  await database.run(`
    INSERT INTO team_membership_transitions (
      id,
      membership_id,
      organization_id,
      from_status,
      to_status,
      actor_user_id,
      source,
      reason,
      external_operation_id,
      membership_revision,
      metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'system', ?, NULL, NULL, ?, ?)
  `, [
    `team-membership-transition-${randomUUID()}`,
    input.membershipId,
    input.organizationId,
    input.fromStatus,
    input.toStatus,
    input.reason,
    JSON.stringify({
      lifecycle: 'license',
      mode: input.policy.mode,
      seatLimit: input.policy.seatLimit,
      licenseState: input.licenseStatus.licenseState,
      licenseClass: input.licenseStatus.licenseClass,
      entitlementsVersion: input.licenseStatus.entitlementsVersion,
    }),
    input.now,
  ]);
}

async function appendLifecycleAudit(
  database: LifecycleDatabase,
  input: {
    action: 'team.solo_fallback_applied' | 'team.seat_limit_enforced' | 'team.access_restored';
    organizationId: string;
    ownerUserId: string;
    policy: TeamLicensePolicy;
    status: LicenseStatus;
    result: Omit<TeamLicenseLifecycleResult, 'changed'>;
    now: number;
  },
): Promise<void> {
  await database.run(`
    INSERT INTO audit_events (
      id,
      organization_id,
      user_id,
      source,
      event_type,
      entity_type,
      entity_id,
      action,
      status,
      summary,
      metadata_json,
      created_at
    ) VALUES (?, ?, ?, 'license', 'license_lifecycle', 'organization', ?, ?, 'success', ?, ?, ?)
  `, [
    `audit-${randomUUID()}`,
    input.organizationId,
    input.ownerUserId,
    input.organizationId,
    input.action,
    input.action === 'team.access_restored'
      ? 'Team access was restored within the signed seat limit.'
      : 'Team access was reduced without deleting user or workspace data.',
    JSON.stringify({
      mode: input.policy.mode,
      reason: input.policy.reason,
      seatLimit: input.policy.seatLimit,
      licenseState: input.status.licenseState,
      licenseClass: input.status.licenseClass,
      entitlementsVersion: input.status.entitlementsVersion,
      suspendedMemberships: input.result.suspendedMemberships,
      restoredMemberships: input.result.restoredMemberships,
      disabledUsers: input.result.disabledUsers,
      restoredUsers: input.result.restoredUsers,
      revokedSessions: input.result.revokedSessions,
      membershipRevision: input.result.membershipRevision,
      remainingFallbackUsers: input.result.remainingFallbackUsers,
    }),
    input.now,
  ]);
}

async function disableUserForLicenseFallback(
  database: LifecycleDatabase,
  input: {
    organizationId: string;
    userId: string;
    now: number;
  },
): Promise<{ disabled: boolean; revokedSessions: number }> {
  const userResult = await database.run(`
    UPDATE "user"
    SET
      banned = 1,
      ban_reason = ?,
      ban_expires = NULL,
      updated_at = ?
    WHERE id = ?
      AND COALESCE(banned, 0) = 0
  `, [
    TEAM_LICENSE_FALLBACK_BAN_REASON,
    input.now,
    input.userId,
  ]);
  const disabled = changesFromRunResult(userResult) === 1;
  if (!disabled) return { disabled: false, revokedSessions: 0 };

  await database.run(`
    UPDATE organization_user_permissions
    SET status = 'disabled', updated_at = ?
    WHERE organization_id = ?
      AND user_id = ?
      AND status = 'active'
  `, [
    input.now,
    input.organizationId,
    input.userId,
  ]);
  const sessionResult = await database.run(
    'DELETE FROM session WHERE user_id = ?',
    [input.userId],
  );
  return {
    disabled: true,
    revokedSessions: changesFromRunResult(sessionResult),
  };
}

async function restoreUserFromLicenseFallback(
  database: LifecycleDatabase,
  input: {
    organizationId: string;
    userId: string;
    now: number;
  },
): Promise<boolean> {
  const permissionResult = await database.run(`
    UPDATE organization_user_permissions
    SET status = 'active', updated_at = ?
    WHERE organization_id = ?
      AND user_id = ?
      AND status = 'disabled'
  `, [
    input.now,
    input.organizationId,
    input.userId,
  ]);
  if (changesFromRunResult(permissionResult) !== 1) return false;

  const userResult = await database.run(`
    UPDATE "user"
    SET
      banned = 0,
      ban_reason = NULL,
      ban_expires = NULL,
      updated_at = ?
    WHERE id = ?
      AND COALESCE(banned, 0) != 0
      AND ban_reason = ?
  `, [
    input.now,
    input.userId,
    TEAM_LICENSE_FALLBACK_BAN_REASON,
  ]);
  if (changesFromRunResult(userResult) === 1) return true;

  await database.run(`
    UPDATE organization_user_permissions
    SET status = 'disabled', updated_at = ?
    WHERE organization_id = ?
      AND user_id = ?
      AND status = 'active'
  `, [
    input.now,
    input.organizationId,
    input.userId,
  ]);
  return false;
}

async function remainingFallbackUsers(
  database: LifecycleDatabase,
): Promise<number> {
  const row = await database.get(`
    SELECT COUNT(*) AS count
    FROM "user" user_account
    WHERE COALESCE(user_account.banned, 0) != 0
      AND user_account.ban_reason = ?
  `, [
    TEAM_LICENSE_FALLBACK_BAN_REASON,
  ]) as { count?: number | string } | undefined;
  return Number(row?.count || 0);
}

async function reconcileWithinTransaction(
  database: LifecycleDatabase,
  status: LicenseStatus,
  basePolicy: TeamLicensePolicy,
  now: number,
): Promise<TeamLicenseLifecycleResult> {
  const organization = await database.get(`
    SELECT organization_id, owner_user_id
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `) as OrganizationRow | undefined;
  if (!organization) {
    return {
      mode: basePolicy.mode,
      reason: basePolicy.reason,
      organizationId: null,
      ownerUserId: null,
      seatLimit: basePolicy.seatLimit,
      suspendedMemberships: 0,
      restoredMemberships: 0,
      disabledUsers: 0,
      restoredUsers: 0,
      revokedSessions: 0,
      membershipRevision: null,
      remainingFallbackUsers: 0,
      changed: false,
    };
  }
  const policy = await applyTeamSeatReconciliationRestriction(
    database,
    basePolicy,
    organization.organization_id,
  );

  const activeMemberships = await database.all(`
    SELECT
      membership.id,
      membership.user_id,
      membership.role,
      membership.candidate_email,
      membership.activated_at,
      user_account.banned AS user_banned,
      permission.status AS permission_status
    FROM team_memberships membership
    INNER JOIN "user" user_account
      ON user_account.id = membership.user_id
    LEFT JOIN organization_user_permissions permission
      ON permission.organization_id = membership.organization_id
      AND permission.user_id = membership.user_id
    WHERE membership.organization_id = ?
      AND membership.status = 'active'
      AND membership.user_id IS NOT NULL
      AND membership.accepted_at IS NOT NULL
      AND membership.user_id != ?
    ORDER BY
      CASE membership.role
        WHEN 'admin' THEN 0
        WHEN 'member' THEN 1
        WHEN 'external' THEN 2
        ELSE 3
      END,
      membership.activated_at ASC,
      membership.candidate_email ASC,
      membership.id ASC
  `, [
    organization.organization_id,
    organization.owner_user_id,
  ]) as ActiveMembershipRow[];

  const activeEligible = activeMemberships.filter((membership) => (
    !booleanFromDatabase(membership.user_banned)
    && membership.permission_status === 'active'
  ));
  const extraCapacity = Math.max(0, policy.seatLimit - 1);
  const keepMembershipIds = new Set(
    activeEligible.slice(0, extraCapacity).map((membership) => membership.id),
  );
  const membershipsToSuspend = activeMemberships.filter(
    (membership) => !keepMembershipIds.has(membership.id),
  );
  const fallbackReason = policy.mode === 'solo'
    ? SOLO_FALLBACK_TRANSITION_REASON
    : SEAT_REDUCTION_TRANSITION_REASON;
  const usersToDisable = new Set<string>();
  let suspendedMemberships = 0;
  let disabledUsers = 0;
  let revokedSessions = 0;

  for (const membership of membershipsToSuspend) {
    const updateResult = await database.run(`
      UPDATE team_memberships
      SET status = 'suspended', suspended_at = ?, updated_at = ?
      WHERE organization_id = ?
        AND id = ?
        AND status = 'active'
    `, [
      now,
      now,
      organization.organization_id,
      membership.id,
    ]);
    if (changesFromRunResult(updateResult) !== 1) continue;
    suspendedMemberships += 1;
    await appendLifecycleTransition(database, {
      membershipId: membership.id,
      organizationId: organization.organization_id,
      fromStatus: 'active',
      toStatus: 'suspended',
      reason: fallbackReason,
      licenseStatus: status,
      policy,
      now,
    });
    if (
      !booleanFromDatabase(membership.user_banned)
      && membership.permission_status === 'active'
    ) {
      usersToDisable.add(membership.user_id);
    } else {
      if (membership.permission_status === 'active') {
        await database.run(`
          UPDATE organization_user_permissions
          SET status = 'disabled', updated_at = ?
          WHERE organization_id = ?
            AND user_id = ?
            AND status = 'active'
        `, [
          now,
          organization.organization_id,
          membership.user_id,
        ]);
      }
      const sessionResult = await database.run(
        'DELETE FROM session WHERE user_id = ?',
        [membership.user_id],
      );
      revokedSessions += changesFromRunResult(sessionResult);
    }
  }

  if (policy.mode === 'solo') {
    const soloUsers = await database.all(`
      SELECT user_account.id
      FROM "user" user_account
      WHERE user_account.id != ?
        AND COALESCE(user_account.banned, 0) = 0
      ORDER BY user_account.created_at ASC, user_account.id ASC
    `, [
      organization.owner_user_id,
    ]) as SoloUserRow[];
    for (const user of soloUsers) usersToDisable.add(user.id);
  }

  for (const userId of usersToDisable) {
    const disabled = await disableUserForLicenseFallback(database, {
      organizationId: organization.organization_id,
      userId,
      now,
    });
    if (disabled.disabled) disabledUsers += 1;
    revokedSessions += disabled.revokedSessions;
  }

  let restoredMemberships = 0;
  let restoredUsers = 0;
  const eligibleKeptCount = activeEligible.filter(
    (membership) => keepMembershipIds.has(membership.id),
  ).length;
  const restoreCapacity = policy.mode === 'team'
    ? Math.max(0, extraCapacity - eligibleKeptCount)
    : 0;
  if (restoreCapacity > 0) {
    const restoreCandidates = await database.all(`
      SELECT
        membership.id,
        membership.user_id,
        membership.role,
        membership.candidate_email,
        membership.activated_at
      FROM team_memberships membership
      INNER JOIN "user" user_account
        ON user_account.id = membership.user_id
      INNER JOIN organization_user_permissions permission
        ON permission.organization_id = membership.organization_id
        AND permission.user_id = membership.user_id
      WHERE membership.organization_id = ?
        AND membership.status = 'suspended'
        AND membership.user_id IS NOT NULL
        AND membership.accepted_at IS NOT NULL
        AND COALESCE(user_account.banned, 0) != 0
        AND user_account.ban_reason = ?
        AND permission.status = 'disabled'
        AND (
          SELECT transition.reason
          FROM team_membership_transitions transition
          WHERE transition.membership_id = membership.id
          ORDER BY transition.created_at DESC, transition.id DESC
          LIMIT 1
        ) IN (?, ?)
      ORDER BY
        CASE membership.role
          WHEN 'admin' THEN 0
          WHEN 'member' THEN 1
          WHEN 'external' THEN 2
          ELSE 3
        END,
        membership.activated_at ASC,
        membership.candidate_email ASC,
        membership.id ASC
    `, [
      organization.organization_id,
      TEAM_LICENSE_FALLBACK_BAN_REASON,
      SOLO_FALLBACK_TRANSITION_REASON,
      SEAT_REDUCTION_TRANSITION_REASON,
    ]) as RestoreMembershipRow[];

    for (const membership of restoreCandidates.slice(0, restoreCapacity)) {
      const userRestored = await restoreUserFromLicenseFallback(database, {
        organizationId: organization.organization_id,
        userId: membership.user_id,
        now,
      });
      if (!userRestored) continue;
      const membershipResult = await database.run(`
        UPDATE team_memberships
        SET
          status = 'active',
          activated_at = ?,
          suspended_at = NULL,
          removed_at = NULL,
          updated_at = ?
        WHERE organization_id = ?
          AND id = ?
          AND status = 'suspended'
      `, [
        now,
        now,
        organization.organization_id,
        membership.id,
      ]);
      if (changesFromRunResult(membershipResult) !== 1) {
        await disableUserForLicenseFallback(database, {
          organizationId: organization.organization_id,
          userId: membership.user_id,
          now,
        });
        continue;
      }
      restoredUsers += 1;
      restoredMemberships += 1;
      await appendLifecycleTransition(database, {
        membershipId: membership.id,
        organizationId: organization.organization_id,
        fromStatus: 'suspended',
        toStatus: 'active',
        reason: TEAM_RESTORED_TRANSITION_REASON,
        licenseStatus: status,
        policy,
        now,
      });
    }
  }

  const changedMembershipId = membershipsToSuspend[0]?.id
    ?? (restoredMemberships > 0
      ? (await database.get(`
          SELECT id
          FROM team_memberships
          WHERE organization_id = ?
            AND status = 'active'
            AND user_id != ?
          ORDER BY updated_at DESC, id ASC
          LIMIT 1
        `, [
          organization.organization_id,
          organization.owner_user_id,
        ]) as { id?: string } | undefined)?.id
      : undefined);
  let membershipRevision: number | null = null;
  if ((suspendedMemberships > 0 || restoredMemberships > 0) && changedMembershipId) {
    const projectionChange = await recordTeamMembershipProjectionChange(database, {
      organizationId: organization.organization_id,
      membershipId: changedMembershipId,
      operationType: 'reconcile',
      projection: await getActiveTeamMembershipProjection(
        database,
        organization.organization_id,
      ),
      now,
    });
    membershipRevision = projectionChange.revision;
  }

  const fallbackUsers = await remainingFallbackUsers(database);
  const resultWithoutChanged = {
    mode: policy.mode,
    reason: policy.reason,
    organizationId: organization.organization_id,
    ownerUserId: organization.owner_user_id,
    seatLimit: policy.seatLimit,
    suspendedMemberships,
    restoredMemberships,
    disabledUsers,
    restoredUsers,
    revokedSessions,
    membershipRevision,
    remainingFallbackUsers: fallbackUsers,
  };
  const changed = suspendedMemberships > 0
    || restoredMemberships > 0
    || disabledUsers > 0
    || restoredUsers > 0
    || revokedSessions > 0;
  if (changed) {
    await appendLifecycleAudit(database, {
      action: restoredMemberships > 0
        ? 'team.access_restored'
        : policy.mode === 'solo'
          ? 'team.solo_fallback_applied'
          : 'team.seat_limit_enforced',
      organizationId: organization.organization_id,
      ownerUserId: organization.owner_user_id,
      policy,
      status,
      result: resultWithoutChanged,
      now,
    });
  }
  return { ...resultWithoutChanged, changed };
}

export async function reconcileTeamLicenseLifecycle(
  status: LicenseStatus,
  options: TeamLicenseLifecycleOptions = {},
): Promise<TeamLicenseLifecycleResult> {
  const policy = resolveEffectiveSeatPolicy(status);
  const databaseProvider = options.databaseProvider ?? getDatabaseProvider();
  const database = options.database ?? await (await import('@/app/lib/db')).openDb();
  const ownsDatabase = !options.database;
  await database.run(databaseProvider === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = await reconcileWithinTransaction(
      database,
      status,
      policy,
      (options.now ?? new Date()).getTime(),
    );
    await database.run('COMMIT');
    if (result.changed) {
      console.info(`${LOG_PREFIX} reconciled Team access`, {
        mode: result.mode,
        reason: result.reason,
        organizationId: result.organizationId,
        seatLimit: result.seatLimit,
        suspendedMemberships: result.suspendedMemberships,
        restoredMemberships: result.restoredMemberships,
        disabledUsers: result.disabledUsers,
        restoredUsers: result.restoredUsers,
        revokedSessions: result.revokedSessions,
        membershipRevision: result.membershipRevision,
        remainingFallbackUsers: result.remainingFallbackUsers,
      });
    }
    return result;
  } catch (error) {
    await rollbackQuietly(database);
    throw error;
  } finally {
    if (ownsDatabase) await database.close();
  }
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function nextLifecycleDelay(status: LicenseStatus, intervalMs: number): number {
  const graceExpiresAt = status.graceExpiresAt
    ? Date.parse(status.graceExpiresAt)
    : Number.NaN;
  if (status.licenseState === 'grace' && Number.isFinite(graceExpiresAt)) {
    return Math.max(1_000, Math.min(intervalMs, graceExpiresAt - Date.now()));
  }
  return intervalMs;
}

async function runTeamLicenseLifecycleCycle(): Promise<{
  status: LicenseStatus;
  result: TeamLicenseLifecycleResult;
}> {
  const { getLicenseStatus } = await import('./index');
  const status = await getLicenseStatus();
  const result = await reconcileTeamLicenseLifecycle(status);
  return { status, result };
}

function scheduleLifecycleRuntime(
  runtime: TeamLicenseLifecycleRuntime,
  delayMs: number,
): void {
  if (runtime.stopped) return;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    if (runtime.running || runtime.stopped) {
      runtime.pending = true;
      return;
    }
    runtime.running = true;
    void runTeamLicenseLifecycleCycle()
      .then(({ status }) => {
        scheduleLifecycleRuntime(
          runtime,
          runtime.pending ? 0 : nextLifecycleDelay(status, runtime.intervalMs),
        );
      })
      .catch((error) => {
        console.error(`${LOG_PREFIX} lifecycle cycle failed`, {
          error: redactTeamControlPlaneLogText(
            error instanceof Error ? error.message : String(error),
          ),
        });
        scheduleLifecycleRuntime(runtime, runtime.intervalMs);
      })
      .finally(() => {
        runtime.running = false;
        runtime.pending = false;
      });
  }, Math.max(0, delayMs));
  runtime.timer.unref?.();
}

export function triggerTeamLicenseLifecycleReconciliation(): boolean {
  const runtime = (globalThis as TeamLicenseLifecycleRuntimeGlobal)
    .__canvasTeamLicenseLifecycleRuntime;
  if (!runtime || runtime.stopped) return false;
  if (runtime.running) runtime.pending = true;
  else scheduleLifecycleRuntime(runtime, 0);
  return true;
}

export function initializeTeamLicenseLifecycleRuntime(): {
  started: boolean;
  trigger: () => void;
  stop: () => void;
} {
  if (
    process.env.NEXT_PHASE === 'phase-production-build'
    || process.env.CANVAS_TEAM_LICENSE_LIFECYCLE_ENABLED === 'false'
  ) {
    return { started: false, trigger: () => {}, stop: () => {} };
  }
  const globalRuntime = globalThis as TeamLicenseLifecycleRuntimeGlobal;
  const existing = globalRuntime.__canvasTeamLicenseLifecycleRuntime;
  if (existing && !existing.stopped) {
    return {
      started: false,
      trigger: () => { triggerTeamLicenseLifecycleReconciliation(); },
      stop: () => {
        existing.stopped = true;
        if (existing.timer) clearTimeout(existing.timer);
      },
    };
  }

  const initialDelayMs = integerEnvironment(
    'CANVAS_TEAM_LICENSE_LIFECYCLE_INITIAL_DELAY_SECONDS',
    8,
    1,
    300,
  ) * 1000;
  const runtime: TeamLicenseLifecycleRuntime = {
    timer: null,
    running: false,
    pending: false,
    stopped: false,
    intervalMs: integerEnvironment(
      'CANVAS_TEAM_LICENSE_LIFECYCLE_INTERVAL_SECONDS',
      60,
      10,
      3600,
    ) * 1000,
  };
  globalRuntime.__canvasTeamLicenseLifecycleRuntime = runtime;
  scheduleLifecycleRuntime(runtime, initialDelayMs);
  console.info(`${LOG_PREFIX} background runtime scheduled`, {
    initialDelaySeconds: initialDelayMs / 1000,
    intervalSeconds: runtime.intervalMs / 1000,
  });
  return {
    started: true,
    trigger: () => { triggerTeamLicenseLifecycleReconciliation(); },
    stop: () => {
      runtime.stopped = true;
      if (runtime.timer) clearTimeout(runtime.timer);
    },
  };
}
