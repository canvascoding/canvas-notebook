import 'server-only';

import { createHash } from 'node:crypto';

import { requestTeamControlPlane, redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { PENDING_TEAM_MEMBERSHIP_BAN_REASON } from '@/app/lib/auth';
import { getDeploymentMode } from '@/app/lib/organization/config';
import { ensureOrganizationPermissionRow, organizationPermissionDefaults } from '@/app/lib/organization/permission-provisioning';
import { TEAM_MEMBERSHIP_SUSPENSION_BAN_PREFIX } from '@/app/lib/organization/membership-ban-reasons';
import { activateLicenseCert, getLicenseControlPlaneUrl } from './index';
import { getLicenseInstanceId } from './instance';
import { decodeLicenseJwt } from './jwt';
import { loadStoredLicenseCert } from './storage';

const SYNC_PATH = '/v1/managed/team/sync';
const ADOPTION_PATH = '/v1/managed/team/adoption-report';
const IDENTITY_PATH = '/v1/managed/team/identity-report';
const ACK_PATH = '/v1/managed/team/sync/ack';
const SYNC_INTERVAL_MS = 60_000;

type ManagedMember = {
  externalUserId: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'external';
  status: 'active' | 'suspended' | 'removed';
  localIdentityKey?: string | null;
  localUserId?: string | null;
};

type ManagedSync = {
  status: 'adoption_required' | 'ready';
  instanceId: string;
  organizationId: string;
  membershipRevision: number;
  memberHash: string | null;
  members: ManagedMember[];
  license: null | {
    certificate: string;
    entitlementsVersion: number;
    fingerprint: string;
    seatLimit: number;
  };
};

type LocalMember = {
  localIdentityKey: string;
  localUserId: string | null;
  email: string;
  role: string;
  status: string;
};

type ManagedRuntime = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  stopped: boolean;
};

type ManagedRuntimeGlobal = typeof globalThis & {
  __canvasManagedTeamSyncRuntime?: ManagedRuntime;
};

function instanceToken(): string | null {
  return process.env.CANVAS_INSTANCE_TOKEN?.trim() || null;
}

function memberHash(members: ManagedMember[]): string {
  const canonical = [...members]
    .sort((left, right) => left.externalUserId.localeCompare(right.externalUserId))
    .map((member) => ({
      externalUserId: member.externalUserId,
      email: member.email.trim().toLowerCase(),
      role: member.role,
      status: member.status,
      localIdentityKey: member.localIdentityKey ?? null,
      localUserId: member.localUserId ?? null,
    }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function parseSync(value: Record<string, unknown>, instanceId: string): ManagedSync {
  if (
    (value.status !== 'ready' && value.status !== 'adoption_required')
    || value.instanceId !== instanceId
    || typeof value.organizationId !== 'string'
    || !Number.isSafeInteger(value.membershipRevision)
    || (value.membershipRevision as number) < 0
    || !Array.isArray(value.members)
  ) {
    throw new Error('MANAGED_TEAM_SYNC_RESPONSE_INVALID');
  }
  const members = value.members as ManagedMember[];
  if (members.some((member) =>
    !member || typeof member.externalUserId !== 'string' || !member.externalUserId
    || typeof member.email !== 'string' || !member.email.includes('@')
    || !['owner', 'admin', 'member', 'external'].includes(member.role)
    || !['active', 'suspended', 'removed'].includes(member.status)
    || (member.localIdentityKey != null && typeof member.localIdentityKey !== 'string')
    || (member.localUserId != null && typeof member.localUserId !== 'string')
  )) {
    throw new Error('MANAGED_TEAM_SYNC_MEMBERS_INVALID');
  }
  const license = value.license as ManagedSync['license'];
  if (value.status === 'ready' && (
    typeof value.memberHash !== 'string'
    || value.memberHash !== memberHash(members)
    || !license
    || typeof license.certificate !== 'string'
    || typeof license.fingerprint !== 'string'
    || !Number.isSafeInteger(license.entitlementsVersion)
    || !Number.isSafeInteger(license.seatLimit)
    || license.seatLimit < 1
  )) {
    throw new Error('MANAGED_TEAM_SYNC_CONTRACT_INVALID');
  }
  return value as ManagedSync;
}

async function localMembers(database: Pick<SqlConnection, 'all'>): Promise<{
  organizationId: string;
  members: LocalMember[];
}> {
  const organizations = await database.all(`
    SELECT organization_id FROM canvas_organization_settings ORDER BY organization_id
  `) as Array<{ organization_id: string }>;
  if (organizations.length !== 1) throw new Error('MANAGED_TEAM_LOCAL_ORGANIZATION_SCOPE_INVALID');
  const organizationId = organizations[0].organization_id;
  const rows = await database.all(`
    SELECT membership.id, COALESCE(membership.user_id, pending.pending_user_id) AS user_id,
      membership.candidate_email, membership.role, membership.status
    FROM team_memberships membership
    LEFT JOIN managed_team_pending_identities pending
      ON pending.local_identity_key = membership.id
      AND pending.organization_id = membership.organization_id
    WHERE membership.organization_id = $1
    ORDER BY membership.id
  `, [organizationId]) as Array<{
    id: string;
    user_id: string | null;
    candidate_email: string;
    role: string;
    status: string;
  }>;
  return {
    organizationId,
    members: rows.map((row) => ({
      localIdentityKey: row.id,
      localUserId: row.user_id,
      email: row.candidate_email.toLowerCase(),
      role: row.role,
      status: row.status,
    })),
  };
}

async function managedRequest(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  const token = instanceToken();
  if (!token) throw new Error('MANAGED_TEAM_INSTANCE_TOKEN_MISSING');
  const { response, payload } = await requestTeamControlPlane({
    baseUrl: getLicenseControlPlaneUrl(),
    path,
    method,
    body,
    instanceToken: token,
    fetchImpl,
    maxAttempts: 2,
  });
  if (!response.ok) {
    const code = typeof payload.code === 'string' ? payload.code : 'MANAGED_TEAM_CONTROL_PLANE_ERROR';
    throw new Error(code);
  }
  return payload;
}

async function sendAdoptionReport(
  instanceId: string,
  members: LocalMember[],
  fetchImpl?: typeof fetch,
  loadCertificate: typeof loadStoredLicenseCert = loadStoredLicenseCert,
): Promise<void> {
  const legacyCertificate = process.env.CANVAS_LICENSE_CERT?.trim()
    || await loadCertificate(instanceId);
  await managedRequest(ADOPTION_PATH, 'POST', {
    instanceId,
    ...(legacyCertificate ? { legacyCertificate } : {}),
    members: members.map(({ localIdentityKey, localUserId, email, role, status }) => ({
      localIdentityKey, localUserId, email, role, status,
    })),
  }, fetchImpl);
}

async function sendIdentityReport(
  instanceId: string,
  members: LocalMember[],
  fetchImpl?: typeof fetch,
): Promise<void> {
  await managedRequest(IDENTITY_PATH, 'POST', {
    instanceId,
    members: members.map(({ localIdentityKey, localUserId, email, role, status }) => ({
      localIdentityKey, localUserId, email, role, status,
    })),
  }, fetchImpl);
}

function assertManagedMappings(local: LocalMember[], managed: ManagedMember[]): number {
  const active = managed.filter((member) => member.status === 'active');
  const byIdentityKey = new Map(local.map((member) => [member.localIdentityKey, member]));
  if (new Set(managed.map((member) => member.externalUserId)).size !== managed.length) {
    throw new Error('MANAGED_TEAM_DUPLICATE_EXTERNAL_USER');
  }
  for (const member of managed) {
    if (!member.localIdentityKey) throw new Error('LOCAL_IDENTITY_MAPPING_REQUIRED');
    const existing = byIdentityKey.get(member.localIdentityKey);
    if (!existing || existing.email !== member.email.toLowerCase()
      || (member.localUserId && existing.localUserId !== member.localUserId)) {
      throw new Error('MANAGED_TEAM_IDENTITY_MISMATCH');
    }
    if (member.status === 'active' && !existing.localUserId) {
      throw new Error('MANAGED_TEAM_PENDING_LOCAL_IDENTITY');
    }
  }
  const mapped = new Set(managed.map((member) => member.localIdentityKey));
  if (local.some((member) => member.status === 'active' && !mapped.has(member.localIdentityKey))) {
    throw new Error('MANAGED_TEAM_UNMAPPED_ACTIVE_USER');
  }
  return active.length;
}

function requireChanged(result: unknown, code: string): void {
  if (!result || typeof result !== 'object' || !('changes' in result)
    || Number(result.changes) !== 1) throw new Error(code);
}

async function applyManagedMembership(
  database: Pick<SqlConnection, 'all' | 'get' | 'run'>,
  local: { organizationId: string; members: LocalMember[] },
  managed: ManagedMember[],
  phase: 'revoke' | 'active',
): Promise<void> {
  const byIdentityKey = new Map(local.members.map((member) => [member.localIdentityKey, member]));
  const now = Date.now();
  await database.run('BEGIN');
  try {
    for (const member of managed) {
      if ((member.status === 'active') !== (phase === 'active')) continue;
      const existing = byIdentityKey.get(member.localIdentityKey!);
      if (!existing || (existing.status === member.status && existing.role === member.role)) continue;
      const pendingActivation = member.status === 'active'
        && ['approval_required', 'billing_pending'].includes(existing.status)
        && existing.localUserId !== null;
      const reactivation = member.status === 'active'
        && ['suspended', 'removed'].includes(existing.status)
        && existing.localUserId !== null;
      if (existing.status !== 'active' && member.status === 'active' && !pendingActivation && !reactivation) {
        throw new Error('MANAGED_TEAM_REACTIVATION_REQUIRES_LOCAL_IDENTITY_FLOW');
      }
      if ((existing.role === 'owner' || member.role === 'owner')
        && (member.status !== 'active' || existing.role !== member.role)) {
        throw new Error('MANAGED_TEAM_OWNER_CHANGE_REQUIRES_REVIEW');
      }
      if (member.status === 'active') {
        if (reactivation) {
          const users = await database.all(`
            SELECT email, banned, ban_reason FROM "user" WHERE id = $1
          `, [existing.localUserId]) as Array<{
            email: string; banned: boolean | number; ban_reason: string | null;
          }>;
          if (users.length !== 1 || users[0].email.toLowerCase() !== member.email.toLowerCase()
            || !users[0].banned
            || !users[0].ban_reason?.startsWith(TEAM_MEMBERSHIP_SUSPENSION_BAN_PREFIX)) {
            throw new Error('MANAGED_TEAM_REACTIVATION_IDENTITY_INVALID');
          }
          await ensureOrganizationPermissionRow(database, {
            organizationId: local.organizationId,
            userId: existing.localUserId!,
            role: member.role,
            activateExisting: true,
            now,
          });
          requireChanged(await database.run(`
            UPDATE team_memberships SET role = $1, status = 'active', activated_at = $2,
              suspended_at = NULL, removed_at = NULL, updated_at = $2
            WHERE id = $3 AND organization_id = $4 AND user_id = $5 AND status IN ('suspended', 'removed')
          `, [member.role, now, existing.localIdentityKey, local.organizationId, existing.localUserId]),
          'MANAGED_TEAM_MEMBERSHIP_CHANGED_CONCURRENTLY');
          requireChanged(await database.run(`
            UPDATE "user" SET banned = 0, ban_reason = NULL, ban_expires = NULL, updated_at = $1
            WHERE id = $2 AND banned = 1 AND ban_reason = $3
          `, [now, existing.localUserId, users[0].ban_reason]),
          'MANAGED_TEAM_REACTIVATION_IDENTITY_CHANGED');
          await database.run('DELETE FROM "session" WHERE user_id = $1', [existing.localUserId]);
          continue;
        }
        if (pendingActivation) {
          const pendingUser = await database.all(`
            SELECT id, email, banned, ban_reason FROM "user" WHERE id = $1
          `, [existing.localUserId]) as Array<{
            id: string; email: string; banned: boolean | number; ban_reason: string | null;
          }>;
          if (pendingUser.length !== 1
            || pendingUser[0].email.toLowerCase() !== member.email.toLowerCase()
            || !pendingUser[0].banned
            || pendingUser[0].ban_reason !== PENDING_TEAM_MEMBERSHIP_BAN_REASON) {
            throw new Error('MANAGED_TEAM_PENDING_IDENTITY_INVALID');
          }
          await ensureOrganizationPermissionRow(database, {
            organizationId: local.organizationId,
            userId: existing.localUserId!,
            role: member.role,
            activateExisting: true,
            now,
          });
          requireChanged(await database.run(`
            UPDATE team_memberships SET user_id = $1, role = $2, status = 'active',
              accepted_at = COALESCE(accepted_at, $3), activated_at = $3, updated_at = $3
            WHERE id = $4 AND organization_id = $5
              AND user_id IS NULL AND status IN ('approval_required', 'billing_pending')
          `, [existing.localUserId, member.role, now, existing.localIdentityKey, local.organizationId]),
          'MANAGED_TEAM_MEMBERSHIP_CHANGED_CONCURRENTLY');
          requireChanged(await database.run(`
            UPDATE "user" SET banned = 0, ban_reason = NULL, ban_expires = NULL, updated_at = $1
            WHERE id = $2 AND banned = 1 AND ban_reason = $3
          `, [now, existing.localUserId, PENDING_TEAM_MEMBERSHIP_BAN_REASON]),
          'MANAGED_TEAM_PENDING_IDENTITY_CHANGED');
          continue;
        }
        const defaults = organizationPermissionDefaults(member.role);
        requireChanged(await database.run(`
          UPDATE team_memberships SET role = $1, updated_at = $2
          WHERE id = $3 AND organization_id = $4 AND user_id = $5 AND status = 'active'
        `, [member.role, now, existing.localIdentityKey, local.organizationId, existing.localUserId]),
        'MANAGED_TEAM_MEMBERSHIP_CHANGED_CONCURRENTLY');
        requireChanged(await database.run(`
          UPDATE organization_user_permissions SET
            role = $1, can_write_team_workspace = $2, can_create_public_links = $3,
            can_create_team_automations = $4, can_share_plugins_and_skills = $5,
            can_export = $6, can_delete_team_files = $7, can_delete_studio_assets = $8,
            can_manage_backups = $9, can_manage_organization_memory = $10,
            can_migrate_database = $11, can_enable_knowledge = $12,
            can_recover_workspaces = $13, updated_at = $14
          WHERE organization_id = $15 AND user_id = $16 AND status = 'active'
        `, [
          member.role,
          Number(defaults.canWriteTeamWorkspace), Number(defaults.canCreatePublicLinks),
          Number(defaults.canCreateTeamAutomations), Number(defaults.canSharePluginsAndSkills),
          Number(defaults.canExport), Number(defaults.canDeleteTeamFiles),
          Number(defaults.canDeleteStudioAssets), Number(defaults.canManageBackups),
          Number(defaults.canManageOrganizationMemory), Number(defaults.canMigrateDatabase),
          Number(defaults.canEnableKnowledge), Number(defaults.canRecoverWorkspaces), now,
          local.organizationId, existing.localUserId,
        ]), 'MANAGED_TEAM_PERMISSION_ROW_MISSING');
        await database.run('DELETE FROM "session" WHERE user_id = $1', [existing.localUserId]);
        continue;
      }
      requireChanged(await database.run(`
        UPDATE team_memberships SET status = $1, role = $2,
          suspended_at = CASE WHEN $1 = 'suspended' THEN $3 ELSE suspended_at END,
          removed_at = CASE WHEN $1 = 'removed' THEN $3 ELSE removed_at END,
          updated_at = $3
        WHERE id = $4 AND organization_id = $5 AND user_id = $6 AND status = 'active'
      `, [member.status, member.role, now, existing.localIdentityKey, local.organizationId, existing.localUserId]),
      'MANAGED_TEAM_MEMBERSHIP_CHANGED_CONCURRENTLY');
      await database.run(`
        UPDATE organization_user_permissions SET status = 'disabled', updated_at = $1
        WHERE organization_id = $2 AND user_id = $3
      `, [now, local.organizationId, existing.localUserId]);
      await database.run(`
        UPDATE "user" SET banned = 1, ban_reason = $1, ban_expires = NULL, updated_at = $2
        WHERE id = $3
      `, [`${TEAM_MEMBERSHIP_SUSPENSION_BAN_PREFIX}managed_${member.status}`, now, existing.localUserId]);
      await database.run('DELETE FROM "session" WHERE user_id = $1', [existing.localUserId]);
    }
    await database.run('COMMIT');
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {}
    throw error;
  }
}

export async function runManagedTeamSyncCycle(options: {
  database?: Pick<SqlConnection, 'all' | 'get' | 'run' | 'close'>;
  fetchImpl?: typeof fetch;
  activateCertificate?: typeof activateLicenseCert;
  loadLegacyCertificate?: typeof loadStoredLicenseCert;
} = {}): Promise<'unconfigured' | 'adoption_required' | 'applied' | 'pending'> {
  if (!instanceToken() || getDeploymentMode() !== 'managed-team'
    || process.env.NEXT_PHASE === 'phase-production-build') return 'unconfigured';
  const instanceId = getLicenseInstanceId();
  const database = options.database ?? await openDb();
  try {
    const local = await localMembers(database);
    const payload = await managedRequest(SYNC_PATH, 'GET', undefined, options.fetchImpl);
    const sync = parseSync(payload, instanceId);
    if (sync.status === 'adoption_required') {
      await sendAdoptionReport(instanceId, local.members, options.fetchImpl, options.loadLegacyCertificate);
      return 'adoption_required';
    }
    const license = sync.license!;
    let error: string | undefined;
    let appliedMemberCount = 0;
    try {
      appliedMemberCount = assertManagedMappings(local.members, sync.members);
      if (license.seatLimit < appliedMemberCount) throw new Error('MANAGED_TEAM_SEAT_LIMIT_BELOW_ACTIVE');
      const fingerprint = createHash('sha256').update(license.certificate).digest('hex');
      if (fingerprint !== license.fingerprint) throw new Error('MANAGED_TEAM_CERTIFICATE_FINGERPRINT_MISMATCH');
      const decoded = decodeLicenseJwt(license.certificate);
      if (!decoded || decoded.organizationId !== sync.organizationId
        || decoded.entitlementsVersion !== license.entitlementsVersion
        || decoded.seatLimit !== license.seatLimit) {
        throw new Error('MANAGED_TEAM_CERTIFICATE_CLAIMS_MISMATCH');
      }
      await applyManagedMembership(database, local, sync.members, 'revoke');
      const afterRevocation = await localMembers(database);
      const currentActive = afterRevocation.members.filter((member) => member.status === 'active').length;
      if (license.seatLimit < currentActive) throw new Error('MANAGED_TEAM_SEAT_LIMIT_BELOW_ACTIVE');
      const status = await (options.activateCertificate ?? activateLicenseCert)(license.certificate);
      if (!status.licensed || status.hostingMode !== 'cloud'
        || status.edition !== 'team' || status.seatLimit !== license.seatLimit) {
        throw new Error('MANAGED_TEAM_CERTIFICATE_APPLY_FAILED');
      }
      await applyManagedMembership(database, afterRevocation, sync.members, 'active');
      const applied = await localMembers(database);
      appliedMemberCount = assertManagedMappings(applied.members, sync.members);
      if (sync.members.some((member) => {
        const current = applied.members.find((localMember) => localMember.localIdentityKey === member.localIdentityKey);
        return current?.role !== member.role || current.status !== member.status;
      })) throw new Error('MANAGED_TEAM_MEMBERSHIP_APPLY_FAILED');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'MANAGED_TEAM_APPLY_FAILED';
    }
    if (error === 'LOCAL_IDENTITY_MAPPING_REQUIRED'
      || error === 'MANAGED_TEAM_UNMAPPED_ACTIVE_USER'
      || error === 'MANAGED_TEAM_PENDING_LOCAL_IDENTITY') {
      await sendIdentityReport(instanceId, local.members, options.fetchImpl);
    }
    await managedRequest(ACK_PATH, 'POST', {
      membershipRevision: sync.membershipRevision,
      memberHash: sync.memberHash,
      entitlementsVersion: license.entitlementsVersion,
      certificateFingerprint: license.fingerprint,
      effectiveSeatLimit: license.seatLimit,
      appliedMemberCount,
      ...(error ? { error } : {}),
    }, options.fetchImpl);
    return error ? 'pending' : 'applied';
  } finally {
    if (!options.database) await database.close();
  }
}

export function initializeManagedTeamSyncRuntime(): { started: boolean; stop: () => void } {
  if (!instanceToken() || getDeploymentMode() !== 'managed-team'
    || process.env.NEXT_PHASE === 'phase-production-build') {
    return { started: false, stop: () => {} };
  }
  const globalRuntime = globalThis as ManagedRuntimeGlobal;
  const existing = globalRuntime.__canvasManagedTeamSyncRuntime;
  if (existing && !existing.stopped) {
    return { started: false, stop: () => {
      existing.stopped = true;
      if (existing.timer) clearTimeout(existing.timer);
    } };
  }
  const runtime: ManagedRuntime = { timer: null, running: false, stopped: false };
  globalRuntime.__canvasManagedTeamSyncRuntime = runtime;
  const schedule = (delayMs: number) => {
    if (runtime.stopped) return;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      if (runtime.running || runtime.stopped) return;
      runtime.running = true;
      void runManagedTeamSyncCycle()
        .catch((error) => console.warn('[license/managed-sync] cycle failed', {
          error: redactTeamControlPlaneLogText(error instanceof Error ? error.message : String(error)),
        }))
        .finally(() => {
          runtime.running = false;
          schedule(SYNC_INTERVAL_MS);
        });
    }, delayMs);
    runtime.timer.unref?.();
  };
  schedule(5_000);
  return { started: true, stop: () => {
    runtime.stopped = true;
    if (runtime.timer) clearTimeout(runtime.timer);
  } };
}
