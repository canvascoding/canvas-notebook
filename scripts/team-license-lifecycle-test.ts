import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { LicenseStatus } from '../app/lib/license/types';
import {
  isTeamMembershipReactivationBanReason,
  TEAM_LICENSE_FALLBACK_BAN_REASON,
} from '../app/lib/organization/membership-ban-reasons';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-team-license-lifecycle-'));
const previousEnvironment = {
  DATA: process.env.DATA,
  CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
  CANVAS_INSTANCE_ID: process.env.CANVAS_INSTANCE_ID,
};

process.env.DATA = dataRoot;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_INSTANCE_ID = 'self_team_license_lifecycle_test';

function restoreEnvironment() {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function licenseStatus(input: {
  edition: 'solo' | 'team';
  seatLimit: number;
}): LicenseStatus {
  return {
    plan: 'community',
    licensed: true,
    instanceId: 'self_team_license_lifecycle_test',
    licenseState: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    hostingMode: 'community',
    edition: input.edition,
    licenseClass: 'commercial',
    licenseEnvironment: 'production',
    seatLimit: input.seatLimit,
    deploymentMode: 'community',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: input.edition === 'team',
    capabilities: input.edition === 'team'
      ? {
          multiUser: true,
          teamWorkspace: true,
          vectorSearch: true,
          liveCollaboration: true,
        }
      : {},
    organizationId: 'organization-lifecycle',
    entitlementsVersion: input.edition === 'team' ? input.seatLimit + 10 : 10,
    expiresAt: '2030-01-01T00:00:00.000Z',
    features: input.edition === 'team'
      ? { multiUser: true, teamWorkspace: true }
      : {},
    quotas: { users: input.seatLimit },
    source: 'stored',
    refresh: null,
    graceStartedAt: null,
    graceExpiresAt: null,
  };
}

async function main() {
  assert.equal(
    isTeamMembershipReactivationBanReason(TEAM_LICENSE_FALLBACK_BAN_REASON),
    true,
  );
  assert.equal(
    isTeamMembershipReactivationBanReason('canvas_team_membership_suspended:Security review'),
    true,
  );
  assert.equal(isTeamMembershipReactivationBanReason('security_policy'), false);
  assert.equal(
    isTeamMembershipReactivationBanReason(`${TEAM_LICENSE_FALLBACK_BAN_REASON}:forged`),
    false,
  );

  const workspaceDirectory = path.join(dataRoot, 'organizations', 'organization-lifecycle', 'workspaces', 'team');
  const workspaceFile = path.join(workspaceDirectory, 'preserved.txt');
  mkdirSync(workspaceDirectory, { recursive: true });
  writeFileSync(workspaceFile, 'preserve team data\n', 'utf8');

  try {
    const { openDb } = await import('../app/lib/db');
    const {
      initializeTeamLicenseLifecycleRuntime,
      reconcileTeamLicenseLifecycle,
    } = await import('../app/lib/license/team-license-lifecycle');
    const database = await openDb();
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    const users = [
      { id: 'owner-user', name: 'Owner', email: 'owner@example.test', role: 'admin', createdAt: now },
      { id: 'admin-user', name: 'Admin', email: 'admin@example.test', role: 'admin', createdAt: now + 1 },
      { id: 'member-user', name: 'Member', email: 'member@example.test', role: 'user', createdAt: now + 2 },
      { id: 'security-user', name: 'Security', email: 'security@example.test', role: 'user', createdAt: now + 3 },
    ];
    for (const user of users) {
      await database.run(`
        INSERT INTO "user" (
          id, name, email, email_verified, role, banned, ban_reason, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      `, [
        user.id,
        user.name,
        user.email,
        user.role,
        user.id === 'security-user' ? 1 : 0,
        user.id === 'security-user' ? 'security_policy' : null,
        user.createdAt,
        user.createdAt,
      ]);
    }
    await database.run(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES (?, ?, 'community-team', 1, ?, ?)
    `, ['organization-lifecycle', 'owner-user', now, now]);

    const memberships = [
      { id: 'membership-owner', userId: 'owner-user', role: 'owner', email: 'owner@example.test' },
      { id: 'membership-admin', userId: 'admin-user', role: 'admin', email: 'admin@example.test' },
      { id: 'membership-member', userId: 'member-user', role: 'member', email: 'member@example.test' },
      { id: 'membership-security', userId: 'security-user', role: 'member', email: 'security@example.test' },
    ];
    for (const [index, membership] of memberships.entries()) {
      await database.run(`
        INSERT INTO organization_user_permissions (
          organization_id, user_id, role, status,
          can_write_team_workspace, can_create_public_links,
          can_create_team_automations, can_share_plugins_and_skills,
          can_export, can_delete_team_files, can_delete_studio_assets,
          can_manage_backups, can_migrate_database, can_enable_knowledge,
          can_recover_workspaces, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, ?, ?)
      `, [
        'organization-lifecycle',
        membership.userId,
        membership.role,
        now,
        now,
      ]);
      await database.run(`
        INSERT INTO team_memberships (
          id, organization_id, candidate_email, user_id, role, status,
          invited_at, accepted_at, activated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `, [
        membership.id,
        'organization-lifecycle',
        membership.email,
        membership.userId,
        membership.role,
        now + index,
        now + index,
        now + index,
        now + index,
        now + index,
      ]);
      await database.run(`
        INSERT INTO session (
          id, token, user_id, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        `session-${membership.userId}`,
        `token-${membership.userId}`,
        membership.userId,
        now + 86_400_000,
        now,
        now,
      ]);
    }
    await database.run(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, display_name, root_relative_path,
        status, created_at, updated_at
      ) VALUES (
        'workspace-team', 'organization-lifecycle', 'team', 'Team',
        'organizations/organization-lifecycle/workspaces/team', 'active',
        ?, ?
      )
    `, [now, now]);

    const expiredTeamStatus: LicenseStatus = {
      ...licenseStatus({ edition: 'team', seatLimit: 3 }),
      licensed: false,
      licenseState: 'expired',
      code: 'LICENSE_REFRESH_GRACE_EXPIRED',
      error: 'license_expired',
    };
    const fallback = await reconcileTeamLicenseLifecycle(
      expiredTeamStatus,
      {
        database,
        databaseProvider: 'sqlite',
        now: new Date(now + 1_000),
      },
    );
    assert.equal(fallback.mode, 'solo');
    assert.equal(fallback.reason, 'team_license_grace_expired');
    assert.equal(fallback.changed, true);
    assert.equal(fallback.suspendedMemberships, 3);
    assert.equal(fallback.disabledUsers, 2);
    assert.equal(fallback.revokedSessions, 3);
    assert.equal(fallback.remainingFallbackUsers, 2);
    assert.equal(fallback.membershipRevision, 1);

    const activeMembershipsAfterFallback = await database.all(`
      SELECT user_id
      FROM team_memberships
      WHERE organization_id = 'organization-lifecycle' AND status = 'active'
      ORDER BY user_id
    `) as Array<{ user_id: string }>;
    assert.deepEqual(activeMembershipsAfterFallback.map((row) => row.user_id), ['owner-user']);
    const usersAfterFallback = await database.all(`
      SELECT id, banned, ban_reason
      FROM "user"
      ORDER BY id
    `) as Array<{ id: string; banned: number; ban_reason: string | null }>;
    assert.deepEqual(usersAfterFallback, [
      { id: 'admin-user', banned: 1, ban_reason: 'canvas_team_license_fallback' },
      { id: 'member-user', banned: 1, ban_reason: 'canvas_team_license_fallback' },
      { id: 'owner-user', banned: 0, ban_reason: null },
      { id: 'security-user', banned: 1, ban_reason: 'security_policy' },
    ]);
    assert.equal(
      (await database.get(`
        SELECT COUNT(*) AS count
        FROM "user"
        WHERE COALESCE(banned, 0) = 0
      `) as { count: number }).count,
      1,
    );
    assert.deepEqual(
      await database.all('SELECT user_id FROM session ORDER BY user_id'),
      [{ user_id: 'owner-user' }],
    );
    assert.equal(
      (await database.get(`
        SELECT status
        FROM organization_user_permissions
        WHERE organization_id = 'organization-lifecycle' AND user_id = 'owner-user'
      `) as { status: string }).status,
      'active',
    );
    assert.equal(
      (await database.get(`
        SELECT status
        FROM organization_user_permissions
        WHERE organization_id = 'organization-lifecycle' AND user_id = 'admin-user'
      `) as { status: string }).status,
      'disabled',
    );
    assert.equal(existsSync(workspaceFile), true);
    assert.equal(readFileSync(workspaceFile, 'utf8'), 'preserve team data\n');
    assert.equal(
      (await database.get('SELECT COUNT(*) AS count FROM "user"') as { count: number }).count,
      4,
    );
    assert.equal(
      (await database.get('SELECT COUNT(*) AS count FROM canvas_workspaces') as { count: number }).count,
      1,
    );

    const repeatedFallback = await reconcileTeamLicenseLifecycle(
      expiredTeamStatus,
      {
        database,
        databaseProvider: 'sqlite',
        now: new Date(now + 2_000),
      },
    );
    assert.equal(repeatedFallback.changed, false);
    assert.equal(
      (await database.get('SELECT COUNT(*) AS count FROM team_seat_outbox') as { count: number }).count,
      1,
    );

    const teamTwo = await reconcileTeamLicenseLifecycle(
      licenseStatus({ edition: 'team', seatLimit: 2 }),
      {
        database,
        databaseProvider: 'sqlite',
        now: new Date(now + 3_000),
      },
    );
    assert.equal(teamTwo.restoredMemberships, 1);
    assert.equal(teamTwo.restoredUsers, 1);
    assert.equal(teamTwo.remainingFallbackUsers, 1);
    assert.deepEqual(
      await database.all(`
        SELECT user_id
        FROM team_memberships
        WHERE organization_id = 'organization-lifecycle' AND status = 'active'
        ORDER BY user_id
      `),
      [{ user_id: 'admin-user' }, { user_id: 'owner-user' }],
    );

    const teamThree = await reconcileTeamLicenseLifecycle(
      licenseStatus({ edition: 'team', seatLimit: 3 }),
      {
        database,
        databaseProvider: 'sqlite',
        now: new Date(now + 4_000),
      },
    );
    assert.equal(teamThree.restoredMemberships, 1);
    assert.equal(teamThree.restoredUsers, 1);
    assert.equal(teamThree.remainingFallbackUsers, 0);
    assert.deepEqual(
      await database.all(`
        SELECT user_id
        FROM team_memberships
        WHERE organization_id = 'organization-lifecycle' AND status = 'active'
        ORDER BY user_id
      `),
      [
        { user_id: 'admin-user' },
        { user_id: 'member-user' },
        { user_id: 'owner-user' },
      ],
    );
    assert.equal(
      (await database.get('SELECT COUNT(*) AS count FROM "user"') as { count: number }).count,
      4,
      'Team reactivation must reuse the preserved user identities',
    );
    assert.equal(existsSync(workspaceFile), true);
    assert.equal(readFileSync(workspaceFile, 'utf8'), 'preserve team data\n');
    assert.deepEqual(
      await database.get('SELECT banned, ban_reason FROM "user" WHERE id = ?', ['security-user']),
      { banned: 1, ban_reason: 'security_policy' },
    );
    assert.equal(
      (await database.get('SELECT COUNT(*) AS count FROM team_membership_transitions') as { count: number }).count,
      5,
    );
    assert.equal(
      (await database.get(`
        SELECT COUNT(*) AS count
        FROM audit_events
        WHERE source = 'license' AND event_type = 'license_lifecycle'
      `) as { count: number }).count,
      3,
    );
    assert.equal(
      (await database.get('SELECT COUNT(*) AS count FROM team_seat_outbox') as { count: number }).count,
      3,
    );

    const explicitDowngrade = await reconcileTeamLicenseLifecycle(
      licenseStatus({ edition: 'solo', seatLimit: 1 }),
      {
        database,
        databaseProvider: 'sqlite',
        now: new Date(now + 5_000),
      },
    );
    assert.equal(explicitDowngrade.reason, 'team_license_downgraded');
    assert.equal(explicitDowngrade.suspendedMemberships, 2);
    assert.equal(explicitDowngrade.disabledUsers, 2);
    assert.equal(explicitDowngrade.remainingFallbackUsers, 2);
    assert.deepEqual(
      await database.all(`
        SELECT user_id
        FROM team_memberships
        WHERE organization_id = 'organization-lifecycle' AND status = 'active'
        ORDER BY user_id
      `),
      [{ user_id: 'owner-user' }],
    );
    assert.equal(existsSync(workspaceFile), true);
    assert.equal(readFileSync(workspaceFile, 'utf8'), 'preserve team data\n');
    assert.equal(
      (await database.get('SELECT COUNT(*) AS count FROM "user"') as { count: number }).count,
      4,
    );
    assert.equal(
      (await database.get('SELECT COUNT(*) AS count FROM canvas_workspaces') as { count: number }).count,
      1,
    );

    const serverSource = readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    const instrumentationSource = readFileSync(
      path.join(process.cwd(), 'instrumentation.ts'),
      'utf8',
    );
    const authSource = readFileSync(
      path.join(process.cwd(), 'app/lib/auth.ts'),
      'utf8',
    );
    assert.match(serverSource, /initializeTeamLicenseLifecycleRuntime/u);
    assert.match(instrumentationSource, /initializeTeamLicenseLifecycleRuntime/u);
    assert.match(authSource, /cookieCache:\s*\{\s*[\s\S]*?enabled:\s*false/u);
    initializeTeamLicenseLifecycleRuntime().stop();
    await database.close();
  } finally {
    restoreEnvironment();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().then(() => console.log('team-license-lifecycle-test: ok'));
