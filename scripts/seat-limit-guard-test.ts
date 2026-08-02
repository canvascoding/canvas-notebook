import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  assertOrganizationSeatProjectionNotOverLimit,
  assertSeatActivationCapacity,
  assertUserSeatAccess,
  resolveEffectiveSeatPolicy,
  SeatLimitGuardError,
} from '../app/lib/license/seat-limit';
import type { LicenseStatus } from '../app/lib/license/types';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-seat-limit-guard-'));
const sqlite = new Database(path.join(tempRoot, 'seat-limit.db'));
sqlite.pragma('foreign_keys = ON');
runMigrations(sqlite);

const connection = {
  get: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).get(...params) : sqlite.prepare(sql).get()
  ),
  run: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).run(...params) : sqlite.prepare(sql).run()
  ),
  all: (sql: string, params?: unknown[]) => (
    params ? sqlite.prepare(sql).all(...params) : sqlite.prepare(sql).all()
  ),
  close: () => undefined,
};

function licenseStatus(input: {
  edition: 'solo' | 'team' | null;
  seatLimit: number | null;
  licensed: boolean;
  licenseState?: LicenseStatus['licenseState'];
}): LicenseStatus {
  return {
    plan: input.licensed ? 'community' : 'unregistered',
    licensed: input.licensed,
    instanceId: 'seat-limit-test',
    licenseState: input.licenseState ?? (input.licensed ? 'active' : 'inactive'),
    protocolVersion: input.licensed ? 'canvas-team-seat-protocol-v1' : null,
    hostingMode: input.licensed ? 'community' : null,
    edition: input.edition,
    licenseClass: input.licensed ? 'commercial' : null,
    licenseEnvironment: input.licensed ? 'production' : null,
    seatLimit: input.seatLimit,
    deploymentMode: input.edition === 'team' ? 'self_hosted' : 'community',
    databaseProvider: input.edition === 'team' ? 'postgres' : 'sqlite',
    vectorProvider: input.edition === 'team' ? 'pgvector' : 'none',
    postgresRequired: input.edition === 'team',
    capabilities: {
      multiUser: input.edition === 'team',
      teamWorkspace: input.edition === 'team',
    },
    organizationId: 'organization-1',
    entitlementsVersion: input.licensed ? 1 : null,
    expiresAt: null,
    features: {
      multiUser: input.edition === 'team',
      teamWorkspace: input.edition === 'team',
    },
    quotas: input.seatLimit === null ? {} : { users: input.seatLimit },
    source: input.licensed ? 'stored' : 'none',
    refresh: null,
    graceStartedAt: null,
    graceExpiresAt: null,
  };
}

function insertUser(input: {
  id: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: number;
}) {
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, banned, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 0, ?, ?)
  `).run(
    input.id,
    input.id,
    input.email,
    input.role,
    input.createdAt,
    input.createdAt,
  );
}

function insertPermission(userId: string, role: 'owner' | 'admin' | 'member') {
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id,
      user_id,
      role,
      status,
      created_at,
      updated_at
    ) VALUES ('organization-1', ?, ?, 'active', 1000, 1000)
  `).run(userId, role);
}

function insertMembership(input: {
  id: string;
  userId: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  activatedAt: number;
}) {
  sqlite.prepare(`
    INSERT INTO team_memberships (
      id,
      organization_id,
      candidate_email,
      user_id,
      role,
      status,
      invited_at,
      accepted_at,
      activated_at,
      created_at,
      updated_at
    ) VALUES (?, 'organization-1', ?, ?, ?, 'active', 1000, 1000, ?, 1000, 1000)
  `).run(
    input.id,
    input.email,
    input.userId,
    input.role,
    input.activatedAt,
  );
}

function insertPendingMembership(input: {
  id: string;
  email: string;
  status: 'invited' | 'approval_required' | 'billing_pending';
  acceptedAt?: number | null;
}) {
  sqlite.prepare(`
    INSERT INTO team_memberships (
      id,
      organization_id,
      candidate_email,
      role,
      status,
      invited_at,
      accepted_at,
      created_at,
      updated_at
    ) VALUES (?, 'organization-1', ?, 'member', ?, 1000, ?, 1000, 1000)
  `).run(
    input.id,
    input.email,
    input.status,
    input.acceptedAt ?? null,
  );
}

async function expectSeatError(
  operation: () => Promise<unknown>,
  code: SeatLimitGuardError['code'],
) {
  await assert.rejects(operation, (error) => (
    error instanceof SeatLimitGuardError && error.code === code
  ));
}

async function main() {
  insertUser({
    id: 'owner-user',
    email: 'owner@example.test',
    role: 'admin',
    createdAt: 1_000,
  });
  insertUser({
    id: 'admin-user',
    email: 'admin@example.test',
    role: 'admin',
    createdAt: 1_100,
  });
  insertUser({
    id: 'member-user',
    email: 'member@example.test',
    role: 'user',
    createdAt: 1_200,
  });
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id,
      owner_user_id,
      deployment_mode,
      team_features_enabled,
      created_at,
      updated_at
    ) VALUES ('organization-1', 'owner-user', 'team', 1, 1000, 1000)
  `).run();
  insertPermission('owner-user', 'owner');
  insertPermission('admin-user', 'admin');
  insertPermission('member-user', 'member');
  insertMembership({
    id: 'membership-owner',
    userId: 'owner-user',
    email: 'owner@example.test',
    role: 'owner',
    activatedAt: 1_000,
  });
  insertMembership({
    id: 'membership-admin',
    userId: 'admin-user',
    email: 'admin@example.test',
    role: 'admin',
    activatedAt: 1_100,
  });
  insertMembership({
    id: 'membership-member',
    userId: 'member-user',
    email: 'member@example.test',
    role: 'member',
    activatedAt: 1_200,
  });

  const solo = licenseStatus({
    edition: null,
    seatLimit: null,
    licensed: false,
  });
  assert.deepEqual(resolveEffectiveSeatPolicy(solo), {
    mode: 'solo',
    seatLimit: 1,
    reason: 'team_license_inactive',
  });
  const soloOwner = await assertUserSeatAccess({
    userId: 'owner-user',
    database: connection,
    licenseStatus: solo,
  });
  assert.equal(soloOwner.seatLimit, 1);
  assert.equal(soloOwner.observedQuantity, 3);
  assert.equal(soloOwner.overallocated, true);
  await expectSeatError(
    () => assertOrganizationSeatProjectionNotOverLimit({
      organizationId: 'organization-1',
      database: connection,
      licenseStatus: solo,
    }),
    'SEAT_LIMIT_EXCEEDED',
  );
  await expectSeatError(
    () => assertUserSeatAccess({
      userId: 'admin-user',
      database: connection,
      licenseStatus: solo,
    }),
    'SEAT_LIMIT_EXCEEDED',
  );

  insertPendingMembership({
    id: 'membership-invited',
    email: 'invited@example.test',
    status: 'invited',
  });
  insertPendingMembership({
    id: 'membership-approval-required',
    email: 'approval-required@example.test',
    status: 'approval_required',
    acceptedAt: 1_300,
  });
  insertPendingMembership({
    id: 'membership-billing-pending',
    email: 'billing-pending@example.test',
    status: 'billing_pending',
    acceptedAt: 1_400,
  });
  assert.deepEqual(
    await assertOrganizationSeatProjectionNotOverLimit({
      organizationId: 'organization-1',
      database: connection,
      licenseStatus: licenseStatus({
        edition: 'team',
        seatLimit: 3,
        licensed: true,
      }),
    }),
    { seatLimit: 3, observedQuantity: 3 },
    'invited, approval_required, and billing_pending memberships must not consume active Seats',
  );

  const teamTwo = licenseStatus({
    edition: 'team',
    seatLimit: 2,
    licensed: true,
  });
  assert.equal((await assertUserSeatAccess({
    userId: 'owner-user',
    database: connection,
    licenseStatus: teamTwo,
  })).overallocated, true);
  assert.equal((await assertUserSeatAccess({
    userId: 'admin-user',
    database: connection,
    licenseStatus: teamTwo,
  })).seatLimit, 2);
  await expectSeatError(
    () => assertUserSeatAccess({
      userId: 'member-user',
      database: connection,
      licenseStatus: teamTwo,
    }),
    'SEAT_LIMIT_EXCEEDED',
  );
  await expectSeatError(
    () => assertOrganizationSeatProjectionNotOverLimit({
      organizationId: 'organization-1',
      database: connection,
      licenseStatus: teamTwo,
    }),
    'SEAT_LIMIT_EXCEEDED',
  );
  await expectSeatError(
    () => assertSeatActivationCapacity(connection, {
      organizationId: 'organization-1',
      desiredQuantity: 5,
      signedSeatLimit: 5,
    }),
    'SEAT_ACTIVATION_STALE',
  );

  sqlite.prepare(`
    UPDATE team_memberships
    SET status = 'suspended', suspended_at = 2000, updated_at = 2000
    WHERE id = 'membership-member'
  `).run();
  assert.deepEqual(
    await assertOrganizationSeatProjectionNotOverLimit({
      organizationId: 'organization-1',
      database: connection,
      licenseStatus: teamTwo,
    }),
    { seatLimit: 2, observedQuantity: 2 },
  );
  await assert.doesNotReject(() => assertSeatActivationCapacity(connection, {
    organizationId: 'organization-1',
    desiredQuantity: 3,
    signedSeatLimit: 3,
  }));
  await expectSeatError(
    () => assertSeatActivationCapacity(connection, {
      organizationId: 'organization-1',
      desiredQuantity: 3,
      signedSeatLimit: 2,
    }),
    'SEAT_LIMIT_EXCEEDED',
  );
  await expectSeatError(
    () => assertUserSeatAccess({
      userId: 'member-user',
      database: connection,
      licenseStatus: licenseStatus({
        edition: 'team',
        seatLimit: 3,
        licensed: true,
      }),
    }),
    'SEAT_MEMBERSHIP_REQUIRED',
  );

  const authSource = readFileSync(path.join(process.cwd(), 'app/lib/auth.ts'), 'utf8');
  assert.match(authSource, /hooks:\s*\{[\s\S]*after:\s*createAuthMiddleware/u);
  assert.match(authSource, /context\.path === "\/get-session"/u);
  assert.match(authSource, /assertUserSeatAccess/u);
  assert.match(authSource, /revokeSeatGuardSessions/u);
  const mobileBootstrapSource = readFileSync(
    path.join(process.cwd(), 'app/api/mobile/v1/bootstrap/route.ts'),
    'utf8',
  );
  assert.match(mobileBootstrapSource, /assertUserSeatAccess/u);
  const workspaceBootstrapSource = readFileSync(
    path.join(process.cwd(), 'app/lib/workspaces/bootstrap-service.ts'),
    'utf8',
  );
  assert.match(workspaceBootstrapSource, /assertUserSeatAccess/u);
  const restoreSource = readFileSync(
    path.join(process.cwd(), 'scripts/apply-pending-migration-restore.ts'),
    'utf8',
  );
  assert.match(restoreSource, /reconcileTeamLicenseLifecycle/u);

  console.log('seat limit guard tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });
