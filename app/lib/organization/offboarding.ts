import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  resolveUserAgentsDir,
  resolveUserMailDir,
  resolveUserMcpDir,
  resolveUserPluginsDir,
  resolveUserSecretsDir,
  resolveUserSettingsDir,
  resolveUserSkillsDir,
} from '@/app/lib/runtime-data-paths';

import { openOrganizationBootstrapDatabase } from './bootstrap';

type Sqlite = Database.Database;

export type OffboardingFindingSeverity = 'blocker' | 'warning' | 'info';
export type OffboardingFindingCategory =
  | 'user'
  | 'permissions'
  | 'sessions'
  | 'automations'
  | 'todos'
  | 'credentials'
  | 'channels'
  | 'workspace'
  | 'public_links'
  | 'studio_assets';

export type OffboardingFinding = {
  severity: OffboardingFindingSeverity;
  category: OffboardingFindingCategory;
  message: string;
  count?: number;
  action?: string;
};

export type OffboardingPreflight = {
  targetUser: {
    id: string;
    name: string | null;
    email: string | null;
    role: string | null;
    banned: boolean;
    organizationRole: string | null;
    organizationStatus: string | null;
  };
  requestedByUserId: string;
  organizationId: string;
  generatedAt: string;
  canApply: boolean;
  blockers: OffboardingFinding[];
  warnings: OffboardingFinding[];
  info: OffboardingFinding[];
  counts: {
    activeRecoveryAdminsRemaining: number;
    activeSessions: number;
    authAccounts: number;
    activeEmailAccounts: number;
    activeChannelBindings: number;
    personalAutomations: number;
    organizationResponsibleAutomations: number;
    organizationReviewAutomations: number;
    affectedAutomations: number;
    inFlightAutomationRuns: number;
    openAssignedTodos: number;
    openCreatedTodos: number;
    activePublicShares: number;
    studioGenerations: number;
  };
  personalWorkspace: {
    id: string;
    status: string;
    rootRelativePath: string;
  } | null;
  scopedStorage: {
    userSettings: boolean;
    userSecrets: boolean;
    userMcp: boolean;
    userMail: boolean;
    userAgents: boolean;
    userSkills: boolean;
    userPlugins: boolean;
  };
};

export type OffboardingApplyResult = {
  preflight: OffboardingPreflight;
  appliedAt: string;
  actions: Record<string, number>;
  manifestPath: string;
};

type TargetUserRow = {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  banned: number | null;
  organization_role: string | null;
  organization_status: string | null;
};

type OrganizationRow = {
  organization_id: string;
  owner_user_id: string;
};

type PersonalWorkspaceRow = {
  id: string;
  status: string;
  root_relative_path: string;
};

export class OffboardingError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'BLOCKED' | 'ACKNOWLEDGEMENT_REQUIRED' | 'DATABASE_ERROR',
    message: string,
    public readonly status = 400,
    public readonly preflight?: OffboardingPreflight,
  ) {
    super(message);
    this.name = 'OffboardingError';
  }
}

function count(sqlite: Sqlite, sql: string, params: unknown[] = []): number {
  const row = sqlite.prepare(sql).get(...params) as { count: number } | undefined;
  return Number(row?.count || 0);
}

async function directoryExists(targetPath: string): Promise<boolean> {
  return fs.stat(targetPath).then((stat) => stat.isDirectory()).catch(() => false);
}

function addFinding(findings: OffboardingFinding[], finding: OffboardingFinding): void {
  findings.push(finding);
}

function getOrganization(sqlite: Sqlite): OrganizationRow {
  const organization = sqlite.prepare(`
    SELECT organization_id, owner_user_id
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as OrganizationRow | undefined;

  if (!organization) {
    throw new OffboardingError('NOT_FOUND', 'Organization is not configured.', 409);
  }

  return organization;
}

function getTargetUser(sqlite: Sqlite, organizationId: string, targetUserId: string): TargetUserRow {
  const target = sqlite.prepare(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.role,
      u.banned,
      p.role AS organization_role,
      COALESCE(p.status, 'active') AS organization_status
    FROM user u
    LEFT JOIN organization_user_permissions p
      ON p.user_id = u.id
      AND p.organization_id = ?
    WHERE u.id = ?
    LIMIT 1
  `).get(organizationId, targetUserId) as TargetUserRow | undefined;

  if (!target) {
    throw new OffboardingError('NOT_FOUND', 'User not found.', 404);
  }

  return target;
}

function getPersonalWorkspace(sqlite: Sqlite, targetUserId: string): PersonalWorkspaceRow | null {
  return sqlite.prepare(`
    SELECT id, status, root_relative_path
    FROM canvas_workspaces
    WHERE owner_user_id = ?
      AND type = 'personal'
    LIMIT 1
  `).get(targetUserId) as PersonalWorkspaceRow | undefined || null;
}

async function getScopedStorageState(targetUserId: string): Promise<OffboardingPreflight['scopedStorage']> {
  const [
    userSettings,
    userSecrets,
    userMcp,
    userMail,
    userAgents,
    userSkills,
    userPlugins,
  ] = await Promise.all([
    directoryExists(resolveUserSettingsDir(targetUserId)),
    directoryExists(resolveUserSecretsDir(targetUserId)),
    directoryExists(resolveUserMcpDir(targetUserId)),
    directoryExists(resolveUserMailDir(targetUserId)),
    directoryExists(resolveUserAgentsDir(targetUserId)),
    directoryExists(resolveUserSkillsDir(targetUserId)),
    directoryExists(resolveUserPluginsDir(targetUserId)),
  ]);

  return {
    userSettings,
    userSecrets,
    userMcp,
    userMail,
    userAgents,
    userSkills,
    userPlugins,
  };
}

function buildAutomationAffectedWhere(): string {
  return `
    status = 'active'
    AND (
      (
        COALESCE(scope, 'personal') != 'organization'
        AND (
          owner_user_id = @targetUserId
          OR (owner_user_id IS NULL AND created_by_user_id = @targetUserId)
        )
      )
      OR (
        scope = 'organization'
        AND (
          responsible_user_id = @targetUserId
          OR created_by_user_id = @targetUserId
          OR approved_by_user_id = @targetUserId
          OR last_edited_by_user_id = @targetUserId
        )
      )
    )
  `;
}

function buildPreflightFromScopedStorage(
  sqlite: Sqlite,
  targetUserId: string,
  requestedByUserId: string,
  scopedStorage: OffboardingPreflight['scopedStorage'],
): OffboardingPreflight {
  const organization = getOrganization(sqlite);
  const target = getTargetUser(sqlite, organization.organization_id, targetUserId);
  const personalWorkspace = getPersonalWorkspace(sqlite, targetUserId);
  const blockers: OffboardingFinding[] = [];
  const warnings: OffboardingFinding[] = [];
  const info: OffboardingFinding[] = [];
  const activeRecoveryAdminsRemaining = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM organization_user_permissions p
    INNER JOIN user u ON u.id = p.user_id
    WHERE p.organization_id = ?
      AND p.user_id != ?
      AND COALESCE(p.status, 'active') = 'active'
      AND p.role IN ('owner', 'admin')
      AND p.can_recover_workspaces = 1
      AND COALESCE(u.banned, 0) != 1
  `, [organization.organization_id, targetUserId]);

  if (targetUserId === requestedByUserId) {
    addFinding(blockers, {
      severity: 'blocker',
      category: 'user',
      message: 'Users cannot offboard their own account.',
    });
  }

  if (!target.organization_role) {
    addFinding(blockers, {
      severity: 'blocker',
      category: 'permissions',
      message: 'User is not a member of this organization.',
    });
  }

  if (target.organization_status && target.organization_status !== 'active') {
    addFinding(blockers, {
      severity: 'blocker',
      category: 'permissions',
      message: `User is already ${target.organization_status}.`,
    });
  }

  if (organization.owner_user_id === targetUserId || target.organization_role === 'owner') {
    addFinding(blockers, {
      severity: 'blocker',
      category: 'permissions',
      message: 'The organization owner must be transferred before offboarding.',
    });
  } else if (target.organization_role === 'admin' && activeRecoveryAdminsRemaining < 1) {
    addFinding(blockers, {
      severity: 'blocker',
      category: 'permissions',
      message: 'At least one active owner/admin with recovery permission must remain.',
    });
  }

  const activeSessions = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM session
    WHERE user_id = ?
      AND expires_at > ?
  `, [targetUserId, Date.now()]);
  const authAccounts = count(sqlite, 'SELECT COUNT(*) AS count FROM account WHERE user_id = ?', [targetUserId]);
  const activeEmailAccounts = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM email_accounts
    WHERE user_id = ?
      AND status = 'active'
  `, [targetUserId]);
  const activeChannelBindings = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM channel_user_bindings
    WHERE user_id = ?
      AND enabled = 1
  `, [targetUserId]);
  const personalAutomations = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM automation_jobs
    WHERE status = 'active'
      AND COALESCE(scope, 'personal') != 'organization'
      AND (
        owner_user_id = ?
        OR (owner_user_id IS NULL AND created_by_user_id = ?)
      )
  `, [targetUserId, targetUserId]);
  const organizationResponsibleAutomations = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM automation_jobs
    WHERE status = 'active'
      AND scope = 'organization'
      AND responsible_user_id = ?
  `, [targetUserId]);
  const organizationReviewAutomations = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM automation_jobs
    WHERE status = 'active'
      AND scope = 'organization'
      AND (
        created_by_user_id = ?
        OR approved_by_user_id = ?
        OR last_edited_by_user_id = ?
      )
  `, [targetUserId, targetUserId, targetUserId]);
  const affectedAutomations = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM automation_jobs
    WHERE status = 'active'
      AND ${buildAutomationAffectedWhere()}
  `, [{ targetUserId }]);
  const inFlightAutomationRuns = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM automation_runs r
    LEFT JOIN automation_jobs j ON j.id = r.job_id
    WHERE r.status IN ('pending', 'running', 'retry_scheduled')
      AND (
        r.actor_user_id = ?
        OR j.owner_user_id = ?
        OR j.responsible_user_id = ?
        OR j.created_by_user_id = ?
      )
  `, [targetUserId, targetUserId, targetUserId, targetUserId]);
  const openAssignedTodos = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM todo_items
    WHERE assignee_user_id = ?
      AND status = 'open'
      AND archived_at IS NULL
  `, [targetUserId]);
  const openCreatedTodos = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM todo_items
    WHERE created_by_user_id = ?
      AND status = 'open'
      AND archived_at IS NULL
  `, [targetUserId]);
  const activePublicShares = count(sqlite, `
    SELECT COUNT(*) AS count
    FROM public_file_shares
    WHERE created_by_user_id = ?
      AND status = 'active'
  `, [targetUserId]);
  const studioGenerations = count(sqlite, 'SELECT COUNT(*) AS count FROM studio_generations WHERE user_id = ?', [targetUserId]);

  if (activeSessions > 0) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'sessions',
      message: 'Active sessions will be revoked.',
      count: activeSessions,
      action: 'delete_sessions',
    });
  }

  if (authAccounts > 0 || activeEmailAccounts > 0 || scopedStorage.userSecrets || scopedStorage.userMcp) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'credentials',
      message: 'User login accounts, email accounts, MCP state, and user-scoped secrets will be disabled or marked for reconnect.',
      count: authAccounts + activeEmailAccounts,
      action: 'revoke_user_credentials',
    });
  }

  const automationCount = affectedAutomations;
  if (automationCount > 0) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'automations',
      message: 'Affected automations will be paused and require admin review before reactivation.',
      count: automationCount,
      action: 'pause_automations',
    });
  }

  if (inFlightAutomationRuns > 0) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'automations',
      message: 'Pending or running automation runs will be marked failed.',
      count: inFlightAutomationRuns,
      action: 'stop_automation_runs',
    });
  }

  if (openAssignedTodos > 0) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'todos',
      message: 'Open to-dos assigned to this user will become unassigned; they will not be silently assigned to the admin.',
      count: openAssignedTodos,
      action: 'unassign_todos',
    });
  }

  if (openCreatedTodos > 0) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'todos',
      message: 'Open to-dos created by this user keep their creator reference for history.',
      count: openCreatedTodos,
      action: 'preserve_creator_references',
    });
  }

  if (activeChannelBindings > 0) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'channels',
      message: 'User channel bindings will be disabled.',
      count: activeChannelBindings,
      action: 'disable_channels',
    });
  }

  if (personalWorkspace) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'workspace',
      message: 'The personal workspace will be locked for recovery-only access.',
      count: 1,
      action: 'lock_personal_workspace',
    });
  }

  if (activePublicShares > 0) {
    addFinding(warnings, {
      severity: 'warning',
      category: 'public_links',
      message: 'Active public links created by this user remain visible and must be reviewed separately.',
      count: activePublicShares,
      action: 'manual_public_link_review',
    });
  }

  if (studioGenerations > 0) {
    addFinding(info, {
      severity: 'info',
      category: 'studio_assets',
      message: 'Studio generations remain visible with the archived creator reference.',
      count: studioGenerations,
      action: 'preserve_studio_assets',
    });
  }

  if (warnings.length === 0 && blockers.length === 0) {
    addFinding(info, {
      severity: 'info',
      category: 'user',
      message: 'No dependent resources require manual review.',
    });
  }

  return {
    targetUser: {
      id: target.id,
      name: target.name,
      email: target.email,
      role: target.role,
      banned: target.banned === 1,
      organizationRole: target.organization_role,
      organizationStatus: target.organization_status || 'active',
    },
    requestedByUserId,
    organizationId: organization.organization_id,
    generatedAt: new Date().toISOString(),
    canApply: blockers.length === 0,
    blockers,
    warnings,
    info,
    counts: {
      activeRecoveryAdminsRemaining,
      activeSessions,
      authAccounts,
      activeEmailAccounts,
      activeChannelBindings,
      personalAutomations,
      organizationResponsibleAutomations,
      organizationReviewAutomations,
      affectedAutomations,
      inFlightAutomationRuns,
      openAssignedTodos,
      openCreatedTodos,
      activePublicShares,
      studioGenerations,
    },
    personalWorkspace: personalWorkspace ? {
      id: personalWorkspace.id,
      status: personalWorkspace.status,
      rootRelativePath: personalWorkspace.root_relative_path,
    } : null,
    scopedStorage,
  };
}

async function buildPreflight(
  sqlite: Sqlite,
  targetUserId: string,
  requestedByUserId: string,
): Promise<OffboardingPreflight> {
  const scopedStorage = await getScopedStorageState(targetUserId);
  return buildPreflightFromScopedStorage(sqlite, targetUserId, requestedByUserId, scopedStorage);
}

function run(sqlite: Sqlite, sql: string, params: unknown[] = []): number {
  return sqlite.prepare(sql).run(...params).changes;
}

function affectedAutomationJobIds(sqlite: Sqlite, targetUserId: string): string[] {
  return (sqlite.prepare(`
    SELECT id
    FROM automation_jobs
    WHERE ${buildAutomationAffectedWhere()}
  `).all({ targetUserId }) as Array<{ id: string }>).map((row) => row.id);
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

async function writeOffboardingManifest(result: Omit<OffboardingApplyResult, 'manifestPath'>): Promise<string> {
  const settingsDir = resolveUserSettingsDir(result.preflight.targetUser.id);
  await fs.mkdir(settingsDir, { recursive: true });
  const manifestPath = path.join(settingsDir, 'offboarding.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      ...result,
    }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  return manifestPath;
}

export async function createOffboardingPreflight(
  targetUserId: string,
  requestedByUserId: string,
): Promise<OffboardingPreflight> {
  const sqlite = openOrganizationBootstrapDatabase();
  try {
    return await buildPreflight(sqlite, targetUserId, requestedByUserId);
  } finally {
    sqlite.close();
  }
}

export async function offboardUser(options: {
  targetUserId: string;
  requestedByUserId: string;
  reason?: string | null;
  acknowledgeWarnings?: boolean;
}): Promise<OffboardingApplyResult> {
  const sqlite = openOrganizationBootstrapDatabase();
  let resultWithoutManifest: Omit<OffboardingApplyResult, 'manifestPath'> | null = null;

  try {
    const scopedStorage = await getScopedStorageState(options.targetUserId);
    sqlite.exec('BEGIN IMMEDIATE');
    const preflight = buildPreflightFromScopedStorage(
      sqlite,
      options.targetUserId,
      options.requestedByUserId,
      scopedStorage,
    );
    if (preflight.blockers.length > 0) {
      throw new OffboardingError('BLOCKED', 'Offboarding is blocked by preflight findings.', 409, preflight);
    }
    if (preflight.warnings.length > 0 && !options.acknowledgeWarnings) {
      throw new OffboardingError('ACKNOWLEDGEMENT_REQUIRED', 'Offboarding warnings must be acknowledged.', 428, preflight);
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const reason = (options.reason || '').trim() || 'Offboarded by administrator';
    const affectedJobs = affectedAutomationJobIds(sqlite, options.targetUserId);
    const actions: Record<string, number> = {};

    actions.userBanned = run(sqlite, `
      UPDATE user
      SET banned = 1, ban_reason = ?, ban_expires = NULL, updated_at = ?
      WHERE id = ?
    `, [`Offboarded: ${reason}`, now, options.targetUserId]);
    actions.sessionsRevoked = run(sqlite, 'DELETE FROM session WHERE user_id = ?', [options.targetUserId]);
    actions.authAccountsRevoked = run(sqlite, `
      UPDATE account
      SET access_token = NULL,
          refresh_token = NULL,
          id_token = NULL,
          password = NULL,
          updated_at = ?
      WHERE user_id = ?
    `, [now, options.targetUserId]);
    actions.emailAccountsRevoked = run(sqlite, `
      UPDATE email_accounts
      SET status = 'revoked',
          is_primary = 0,
          updated_at = ?
      WHERE user_id = ?
        AND status != 'revoked'
    `, [now, options.targetUserId]);
    actions.todoEmailWatchersDisabled = run(sqlite, `
      UPDATE todo_email_reply_watchers
      SET status = 'disabled',
          error = ?,
          updated_at = ?
      WHERE user_id = ?
        AND status = 'active'
    `, ['User was offboarded.', now, options.targetUserId]);
    actions.channelBindingsDisabled = run(sqlite, `
      UPDATE channel_user_bindings
      SET enabled = 0
      WHERE user_id = ?
        AND enabled = 1
    `, [options.targetUserId]);
    actions.channelActiveSessionsDeleted = run(sqlite, 'DELETE FROM channel_active_sessions WHERE user_id = ?', [options.targetUserId]);
    actions.telegramActiveSessionsDeleted = run(sqlite, 'DELETE FROM telegram_active_session WHERE user_id = ?', [options.targetUserId]);
    actions.channelLinkTokensDeleted = run(sqlite, 'DELETE FROM channel_link_tokens WHERE user_id = ?', [options.targetUserId]);

    actions.automationsPaused = run(sqlite, `
      UPDATE automation_jobs
      SET status = 'paused',
          next_run_at = NULL,
          last_edited_by_user_id = ?,
          updated_at = ?
      WHERE status = 'active'
        AND (
          (
            COALESCE(scope, 'personal') != 'organization'
            AND (
              owner_user_id = ?
              OR (owner_user_id IS NULL AND created_by_user_id = ?)
            )
          )
          OR (
            scope = 'organization'
            AND (
              responsible_user_id = ?
              OR created_by_user_id = ?
              OR approved_by_user_id = ?
              OR last_edited_by_user_id = ?
            )
          )
        )
    `, [
      options.requestedByUserId,
      now,
      options.targetUserId,
      options.targetUserId,
      options.targetUserId,
      options.targetUserId,
      options.targetUserId,
      options.targetUserId,
    ]);
    if (affectedJobs.length > 0) {
      actions.webhookTriggersPaused = run(sqlite, `
        UPDATE automation_webhook_triggers
        SET status = 'paused',
            updated_at = ?
        WHERE job_id IN (${placeholders(affectedJobs)})
      `, [now, ...affectedJobs]);
      actions.automationRunsStopped = run(sqlite, `
        UPDATE automation_runs
        SET status = 'failed',
            finished_at = COALESCE(finished_at, ?),
            error_message = COALESCE(error_message, ?)
        WHERE status IN ('pending', 'running', 'retry_scheduled')
          AND (
            actor_user_id = ?
            OR job_id IN (${placeholders(affectedJobs)})
          )
      `, [now, 'User was offboarded before the run completed.', options.targetUserId, ...affectedJobs]);
    } else {
      actions.webhookTriggersPaused = 0;
      actions.automationRunsStopped = run(sqlite, `
        UPDATE automation_runs
        SET status = 'failed',
            finished_at = COALESCE(finished_at, ?),
            error_message = COALESCE(error_message, ?)
        WHERE status IN ('pending', 'running', 'retry_scheduled')
          AND actor_user_id = ?
      `, [now, 'User was offboarded before the run completed.', options.targetUserId]);
    }

    actions.todosUnassigned = run(sqlite, `
      UPDATE todo_items
      SET assignee_user_id = NULL,
          updated_at = ?
      WHERE assignee_user_id = ?
        AND status = 'open'
        AND archived_at IS NULL
    `, [now, options.targetUserId]);
    actions.personalWorkspacesLocked = run(sqlite, `
      UPDATE canvas_workspaces
      SET status = 'recovery_locked',
          updated_at = ?
      WHERE owner_user_id = ?
        AND type = 'personal'
        AND status != 'recovery_locked'
    `, [now, options.targetUserId]);

    const reportJson = JSON.stringify({
      generatedAt: nowIso,
      requestedByUserId: options.requestedByUserId,
      reason,
      preflight,
      actions,
    });
    actions.permissionArchived = run(sqlite, `
      UPDATE organization_user_permissions
      SET status = 'archived',
          disabled_at = COALESCE(disabled_at, ?),
          archived_at = ?,
          offboarded_by_user_id = ?,
          offboarding_reason = ?,
          offboarding_report_json = ?,
          can_write_team_workspace = 0,
          can_create_public_links = 0,
          can_create_team_automations = 0,
          can_share_plugins_and_skills = 0,
          can_export = 0,
          can_delete_team_files = 0,
          can_delete_studio_assets = 0,
          can_manage_backups = 0,
          can_migrate_database = 0,
          can_enable_knowledge = 0,
          can_recover_workspaces = 0,
          updated_at = ?
      WHERE organization_id = ?
        AND user_id = ?
    `, [
      now,
      now,
      options.requestedByUserId,
      reason,
      reportJson,
      now,
      preflight.organizationId,
      options.targetUserId,
    ]);

    resultWithoutManifest = {
      preflight,
      appliedAt: nowIso,
      actions,
    };
    sqlite.exec('COMMIT');
  } catch (error) {
    if (sqlite.inTransaction) {
      sqlite.exec('ROLLBACK');
    }
    if (error instanceof OffboardingError) {
      throw error;
    }
    console.error('[OrganizationOffboarding] Unexpected error during offboarding:', error);
    throw new OffboardingError('DATABASE_ERROR', 'Could not offboard user.', 500);
  } finally {
    sqlite.close();
  }

  if (!resultWithoutManifest) {
    throw new OffboardingError('DATABASE_ERROR', 'Could not offboard user.', 500);
  }

  const manifestPath = await writeOffboardingManifest(resultWithoutManifest);
  console.warn('[OrganizationOffboarding] User offboarded.', {
    targetUserId: options.targetUserId,
    requestedByUserId: options.requestedByUserId,
    actions: resultWithoutManifest.actions,
  });

  return {
    ...resultWithoutManifest,
    manifestPath,
  };
}
