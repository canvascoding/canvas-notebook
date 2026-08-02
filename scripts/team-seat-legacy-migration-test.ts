import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import {
  runMigrations,
  TEAM_SEAT_LEGACY_MIGRATION_KEY,
  TEAM_SEAT_LEGACY_MIGRATION_METADATA,
} from '../app/lib/db/migrate';
import {
  runPostgresTeamSeatLegacyBackfill,
  TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL,
} from '../app/lib/db/postgres';

type MembershipRow = {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  accepted_at: number | null;
  suspended_at: number | null;
  removed_at: number | null;
};

const TEST_NOW = 1_800_000_000_000;

function openMigratedDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  runMigrations(sqlite);
  const marker = sqlite.prepare(`
    SELECT migration_key
    FROM canvas_data_migrations
    WHERE migration_key = ?
  `).get(TEAM_SEAT_LEGACY_MIGRATION_KEY);
  assert.equal(marker, undefined, 'an empty fresh installation must not consume the legacy migration');
  return sqlite;
}

function insertUser(
  sqlite: Database.Database,
  input: {
    id: string;
    email: string;
    name?: string;
    role?: string;
    banned?: boolean;
  },
): void {
  sqlite.prepare(`
    INSERT INTO "user" (
      id,
      name,
      email,
      email_verified,
      image,
      role,
      banned,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name ?? input.id,
    input.email,
    input.role ?? 'user',
    input.banned ? 1 : 0,
    TEST_NOW,
    TEST_NOW,
  );
}

function insertOrganization(
  sqlite: Database.Database,
  input: {
    id: string;
    ownerUserId: string;
    deploymentMode: string;
  },
): void {
  sqlite.prepare(`
    INSERT INTO canvas_organization_settings (
      organization_id,
      owner_user_id,
      deployment_mode,
      team_features_enabled,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.ownerUserId,
    input.deploymentMode,
    input.deploymentMode === 'managed-team' ? 1 : 0,
    TEST_NOW,
    TEST_NOW,
  );
}

function insertPermission(
  sqlite: Database.Database,
  input: {
    organizationId: string;
    userId: string;
    role: string;
    status: string;
  },
): void {
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id,
      user_id,
      role,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.organizationId,
    input.userId,
    input.role,
    input.status,
    TEST_NOW,
    TEST_NOW,
  );
}

function getMemberships(sqlite: Database.Database): MembershipRow[] {
  return sqlite.prepare(`
    SELECT
      id,
      organization_id,
      user_id,
      role,
      status,
      accepted_at,
      suspended_at,
      removed_at
    FROM team_memberships
    ORDER BY organization_id, user_id
  `).all() as MembershipRow[];
}

function getLegacyData(sqlite: Database.Database) {
  return {
    users: sqlite.prepare(`
      SELECT id, name, email, role, banned, created_at, updated_at
      FROM "user"
      ORDER BY id
    `).all(),
    organizations: sqlite.prepare(`
      SELECT organization_id, owner_user_id, deployment_mode, team_features_enabled
      FROM canvas_organization_settings
      ORDER BY organization_id
    `).all(),
    permissions: sqlite.prepare(`
      SELECT organization_id, user_id, role, status, created_at, updated_at
      FROM organization_user_permissions
      ORDER BY organization_id, user_id
    `).all(),
    todos: sqlite.prepare(`
      SELECT id, user_id, title, description, status, priority, created_at, updated_at
      FROM todo_items
      ORDER BY id
    `).all(),
    certificates: sqlite.prepare(`
      SELECT cert, plan, instance_id, expires_at, created_at, updated_at
      FROM license_certs
      ORDER BY id
    `).all(),
  };
}

function getTeamSeatMigrationState(sqlite: Database.Database) {
  return {
    memberships: sqlite.prepare(`
      SELECT *
      FROM team_memberships
      ORDER BY organization_id, user_id, id
    `).all(),
    transitions: sqlite.prepare(`
      SELECT *
      FROM team_membership_transitions
      ORDER BY membership_id, id
    `).all(),
    sync: sqlite.prepare(`
      SELECT *
      FROM team_membership_sync_state
      ORDER BY organization_id
    `).all(),
    outbox: sqlite.prepare(`
      SELECT *
      FROM team_seat_outbox
      ORDER BY operation_id
    `).all(),
    marker: sqlite.prepare(`
      SELECT *
      FROM canvas_data_migrations
      WHERE migration_key = ?
    `).get(TEAM_SEAT_LEGACY_MIGRATION_KEY),
  };
}

function assertNoSyntheticBilling(sqlite: Database.Database): void {
  const outboxCount = sqlite.prepare('SELECT COUNT(*) AS count FROM team_seat_outbox').get() as { count: number };
  assert.equal(outboxCount.count, 0);

  const transitions = sqlite.prepare(`
    SELECT source, membership_revision, metadata_json
    FROM team_membership_transitions
    ORDER BY membership_id
  `).all() as Array<{
    source: string;
    membership_revision: number | null;
    metadata_json: string | null;
  }>;
  assert.ok(transitions.length > 0);
  for (const transition of transitions) {
    assert.equal(transition.source, 'migration');
    assert.equal(transition.membership_revision, null);
    assert.equal(transition.metadata_json, TEAM_SEAT_LEGACY_MIGRATION_METADATA);
  }
}

function testLegacyDeploymentModes(): void {
  const sqlite = openMigratedDatabase();
  try {
    insertUser(sqlite, {
      id: 'community-owner',
      email: 'Community.Owner@example.test',
      role: 'admin',
    });
    insertOrganization(sqlite, {
      id: 'org-community',
      ownerUserId: 'community-owner',
      deploymentMode: 'single_user',
    });

    insertUser(sqlite, {
      id: 'managed-single-owner',
      email: 'single@example.test',
      role: 'admin',
    });
    insertOrganization(sqlite, {
      id: 'org-managed-single',
      ownerUserId: 'managed-single-owner',
      deploymentMode: 'managed-single',
    });
    insertPermission(sqlite, {
      organizationId: 'org-managed-single',
      userId: 'managed-single-owner',
      role: 'owner',
      status: 'active',
    });

    insertUser(sqlite, {
      id: 'managed-team-owner',
      email: 'team-owner@example.test',
      role: 'admin',
    });
    insertUser(sqlite, {
      id: 'managed-team-active',
      email: 'team-active@example.test',
    });
    insertUser(sqlite, {
      id: 'managed-team-banned',
      email: 'team-banned@example.test',
      banned: true,
    });
    insertUser(sqlite, {
      id: 'managed-team-archived',
      email: 'team-archived@example.test',
    });
    insertOrganization(sqlite, {
      id: 'org-managed-team',
      ownerUserId: 'managed-team-owner',
      deploymentMode: 'managed-team',
    });
    insertPermission(sqlite, {
      organizationId: 'org-managed-team',
      userId: 'managed-team-owner',
      role: 'owner',
      status: 'active',
    });
    insertPermission(sqlite, {
      organizationId: 'org-managed-team',
      userId: 'managed-team-active',
      role: 'member',
      status: 'active',
    });
    insertPermission(sqlite, {
      organizationId: 'org-managed-team',
      userId: 'managed-team-banned',
      role: 'admin',
      status: 'active',
    });
    insertPermission(sqlite, {
      organizationId: 'org-managed-team',
      userId: 'managed-team-archived',
      role: 'external',
      status: 'archived',
    });
    sqlite.prepare(`
      INSERT INTO todo_items (
        id,
        user_id,
        title,
        description,
        status,
        priority,
        source_type,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'open', 'high', 'user', ?, ?)
    `).run(
      'legacy-team-todo',
      'managed-team-active',
      'Keep this existing task',
      'Migration must preserve unrelated user data.',
      TEST_NOW,
      TEST_NOW,
    );
    sqlite.prepare(`
      INSERT INTO license_certs (
        cert,
        plan,
        instance_id,
        expires_at,
        created_at,
        updated_at
      ) VALUES (?, 'managed', ?, ?, ?, ?)
    `).run(
      'legacy-certificate-payload',
      'legacy-managed-instance',
      TEST_NOW + 86_400_000,
      TEST_NOW,
      TEST_NOW,
    );

    const legacyDataBefore = getLegacyData(sqlite);
    runMigrations(sqlite);
    assert.deepEqual(
      getLegacyData(sqlite),
      legacyDataBefore,
      'Team Seat adoption must preserve existing users, permissions, application data, and license state',
    );

    const memberships = getMemberships(sqlite);
    assert.equal(memberships.length, 6);
    const byUserId = new Map(memberships.map((membership) => [membership.user_id, membership]));

    assert.equal(byUserId.get('community-owner')?.role, 'owner');
    assert.equal(byUserId.get('community-owner')?.status, 'active');
    assert.ok(byUserId.get('community-owner')?.accepted_at);
    assert.equal(byUserId.get('managed-single-owner')?.status, 'active');
    assert.equal(byUserId.get('managed-team-owner')?.status, 'active');
    assert.equal(byUserId.get('managed-team-active')?.status, 'active');
    assert.equal(byUserId.get('managed-team-banned')?.status, 'suspended');
    assert.ok(byUserId.get('managed-team-banned')?.suspended_at);
    assert.equal(byUserId.get('managed-team-archived')?.status, 'removed');
    assert.ok(byUserId.get('managed-team-archived')?.removed_at);

    const observed = sqlite.prepare(`
      SELECT organization_id, current_revision, current_observed_quantity
      FROM team_membership_sync_state
      ORDER BY organization_id
    `).all() as Array<{
      organization_id: string;
      current_revision: number;
      current_observed_quantity: number;
    }>;
    assert.deepEqual(observed, [
      { organization_id: 'org-community', current_revision: 0, current_observed_quantity: 1 },
      { organization_id: 'org-managed-single', current_revision: 0, current_observed_quantity: 1 },
      { organization_id: 'org-managed-team', current_revision: 0, current_observed_quantity: 2 },
    ]);
    assertNoSyntheticBilling(sqlite);

    const beforeRetry = getTeamSeatMigrationState(sqlite);
    runMigrations(sqlite);
    assert.deepEqual(
      getTeamSeatMigrationState(sqlite),
      beforeRetry,
      're-running the completed migration must be a byte-for-byte logical no-op',
    );
    assert.deepEqual(getLegacyData(sqlite), legacyDataBefore);
  } finally {
    sqlite.close();
  }
}

function testPartialMigrationRecovery(): void {
  const sqlite = openMigratedDatabase();
  try {
    insertUser(sqlite, { id: 'partial-owner', email: 'partial-owner@example.test', role: 'admin' });
    insertUser(sqlite, { id: 'partial-member', email: 'partial-member@example.test' });
    insertOrganization(sqlite, {
      id: 'org-partial',
      ownerUserId: 'partial-owner',
      deploymentMode: 'managed-team',
    });
    insertPermission(sqlite, {
      organizationId: 'org-partial',
      userId: 'partial-owner',
      role: 'owner',
      status: 'active',
    });
    insertPermission(sqlite, {
      organizationId: 'org-partial',
      userId: 'partial-member',
      role: 'member',
      status: 'active',
    });
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
      ) VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?, ?, ?)
    `).run(
      'partial-owner-membership',
      'org-partial',
      'partial-owner@example.test',
      'partial-owner',
      TEST_NOW,
      TEST_NOW,
      TEST_NOW,
      TEST_NOW,
      TEST_NOW,
    );

    const legacyDataBefore = getLegacyData(sqlite);
    runMigrations(sqlite);
    assert.equal(getMemberships(sqlite).length, 2);
    assert.equal(
      getMemberships(sqlite).find((membership) => membership.user_id === 'partial-owner')?.id,
      'partial-owner-membership',
      'partial recovery must preserve the already-created membership identity',
    );
    assert.deepEqual(getLegacyData(sqlite), legacyDataBefore);
    assert.equal(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM team_membership_transitions').get() as { count: number }).count,
      2,
    );
    assertNoSyntheticBilling(sqlite);
  } finally {
    sqlite.close();
  }
}

function testFailedMigrationCanRetry(): void {
  const sqlite = openMigratedDatabase();
  try {
    insertUser(sqlite, { id: 'duplicate-owner', email: 'duplicate@example.test', role: 'admin' });
    insertUser(sqlite, { id: 'duplicate-member', email: 'DUPLICATE@example.test' });
    insertOrganization(sqlite, {
      id: 'org-duplicate',
      ownerUserId: 'duplicate-owner',
      deploymentMode: 'managed-team',
    });
    insertPermission(sqlite, {
      organizationId: 'org-duplicate',
      userId: 'duplicate-owner',
      role: 'owner',
      status: 'active',
    });
    insertPermission(sqlite, {
      organizationId: 'org-duplicate',
      userId: 'duplicate-member',
      role: 'member',
      status: 'active',
    });

    const legacyDataBefore = getLegacyData(sqlite);
    assert.throws(
      () => runMigrations(sqlite),
      /duplicate Team Seat identity/u,
    );
    assert.deepEqual(
      getLegacyData(sqlite),
      legacyDataBefore,
      'a failed migration must roll back Team Seat state without touching legacy data',
    );
    assert.equal(getMemberships(sqlite).length, 0);
    assert.equal(
      sqlite.prepare(`
        SELECT migration_key
        FROM canvas_data_migrations
        WHERE migration_key = ?
      `).get(TEAM_SEAT_LEGACY_MIGRATION_KEY),
      undefined,
    );

    sqlite.prepare('UPDATE "user" SET email = ? WHERE id = ?')
      .run('recovered@example.test', 'duplicate-member');
    runMigrations(sqlite);
    assert.equal(getMemberships(sqlite).length, 2);
    assertNoSyntheticBilling(sqlite);
  } finally {
    sqlite.close();
  }
}

async function testPostgresMigrationContract(): Promise<void> {
  const statements: string[] = [];
  await runPostgresTeamSeatLegacyBackfill({
    query: async (statement: string) => {
      statements.push(statement);
      return { rows: [], rowCount: 0 } as never;
    },
  } as never);

  assert.deepEqual(statements, [TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL]);
  assert.match(TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL, /pg_advisory_xact_lock/u);
  assert.match(TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL, /ON CONFLICT DO NOTHING/u);
  assert.match(TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL, /billableOperationsCreated":0/u);
  assert.doesNotMatch(TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL, /team_seat_outbox/u);
}

async function main(): Promise<void> {
  testLegacyDeploymentModes();
  testPartialMigrationRecovery();
  testFailedMigrationCanRetry();
  await testPostgresMigrationContract();
  console.log('team seat legacy migration tests passed');
}

void main();
