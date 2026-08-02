import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import type { LicenseStatus } from '../app/lib/license/types';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fingerprint(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function signLicense(
  privateKey: crypto.KeyObject,
  kid: string,
  payload: Record<string, unknown>,
): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${encodedPayload}`),
    privateKey,
  );
  return `${header}.${encodedPayload}.${signature.toString('base64url')}`;
}

function testLicensePayload(input: {
  instanceId: string;
  licenseId: string;
  seatLimit: number;
  entitlementsVersion: number;
  expiresAtSeconds: number;
}) {
  const issuedAt = Math.floor(Date.now() / 1_000) - 60;
  return {
    sub: input.instanceId,
    iss: 'canvas-control-plane',
    aud: 'canvas-notebook-test',
    plan: 'community',
    status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    licenseId: input.licenseId,
    instanceId: input.instanceId,
    hostingMode: 'community',
    edition: 'team',
    licenseClass: 'test',
    licenseEnvironment: 'development',
    provider: 'test',
    grantId: 'grant-no-stripe-notebook',
    seatLimit: input.seatLimit,
    entitlementsVersion: input.entitlementsVersion,
    nonBillable: true,
    deploymentMode: 'community-team',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: {
      multiUser: true,
      teamWorkspace: true,
      vectorSearch: true,
      liveCollaboration: true,
    },
    features: {
      multiUser: true,
      teamWorkspace: true,
      vectorSearch: true,
      liveCollaboration: true,
    },
    quotas: { users: input.seatLimit },
    iat: issuedAt,
    exp: input.expiresAtSeconds,
  };
}

function details(input: {
  instanceId: string;
  licenseId: string;
  seatLimit: number;
  entitlementsVersion: number;
}) {
  return {
    id: input.licenseId,
    plan: 'community',
    status: 'active',
    instanceId: input.instanceId,
    hostingMode: 'community',
    edition: 'team',
    licenseClass: 'test',
    licenseEnvironment: 'development',
    billingOrganizationId: 'organization-no-stripe',
    entitlementsVersion: input.entitlementsVersion,
    deploymentMode: 'community-team',
    features: {
      multiUser: true,
      teamWorkspace: true,
      vectorSearch: true,
      liveCollaboration: true,
    },
    quotas: { users: input.seatLimit },
    activatedAt: '2026-08-01T10:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
}

function prepareResponse(input: {
  licenseId: string;
  desiredQuantity: number;
}) {
  const quoteId = randomUUID();
  const authorizationId = randomUUID();
  return {
    quote: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      quoteId,
      subject: {
        type: 'license',
        licenseId: input.licenseId,
      },
      provider: 'test',
      environment: 'development',
      priceVersionId: 'test-price-no-stripe',
      quantityBefore: input.desiredQuantity - 1,
      quantityAfter: input.desiredQuantity,
      quantityDelta: 1,
      unitAmountCents: 0,
      currency: 'eur',
      billingInterval: 'month',
      immediateAmountCents: 0,
      recurringAmountCents: 0,
      status: 'active',
      expiresAt: '2030-01-01T00:05:00.000Z',
      quoteHash: `quote-hash-${quoteId}`,
      nonBillable: true,
    },
    authorization: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      authorizationId,
      quoteId,
      quoteHash: `quote-hash-${quoteId}`,
      quantityBefore: input.desiredQuantity - 1,
      quantityAfter: input.desiredQuantity,
      status: 'approved',
      expiresAt: '2030-01-01T00:05:00.000Z',
      approvedAt: '2026-08-01T10:00:01.000Z',
      consumedAt: null,
    },
    requiresBillingApproval: false,
    snapshot: {
      revision: 1,
      observedQuantity: input.desiredQuantity - 1,
      licensedQuantity: input.desiredQuantity - 1,
      approvedQuantity: 10,
      billedQuantity: 0,
      billingStatus: 'active',
    },
  };
}

function appliedResponse(input: {
  certificate: string;
  instanceId: string;
  licenseId: string;
  operationKey: string;
  desiredQuantity: number;
  entitlementsVersion: number;
}) {
  return {
    operation: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      operationId: randomUUID(),
      operationKey: input.operationKey,
      operationType: 'member_create',
      provider: 'test',
      environment: 'development',
      status: 'applied',
      paymentStatus: 'test',
      previousQuantity: input.desiredQuantity - 1,
      requestedQuantity: input.desiredQuantity,
      effectiveQuantity: input.desiredQuantity,
      retryCount: 0,
      lastError: null,
      effectiveAt: '2026-08-01T10:01:00.000Z',
      entitlementsVersion: input.entitlementsVersion,
      certificateReissueStatus: 'issued',
      createdAt: '2026-08-01T10:01:00.000Z',
      updatedAt: '2026-08-01T10:01:00.000Z',
    },
    replayed: false,
    license: {
      license: input.certificate,
      details: details({
        instanceId: input.instanceId,
        licenseId: input.licenseId,
        seatLimit: input.desiredQuantity,
        entitlementsVersion: input.entitlementsVersion,
      }),
    },
  };
}

function lifecycleStatus(
  active: LicenseStatus,
): LicenseStatus {
  return {
    ...active,
    licensed: false,
    licenseState: 'expired',
    code: 'LICENSE_REFRESH_GRACE_EXPIRED',
    error: 'license_expired',
  };
}

function revokedGrantStatus(active: LicenseStatus): LicenseStatus {
  return {
    ...active,
    licensed: true,
    licenseState: 'active',
    edition: 'solo',
    licenseClass: 'commercial',
    licenseEnvironment: 'production',
    seatLimit: 1,
    postgresRequired: false,
    capabilities: {},
    entitlementsVersion: (active.entitlementsVersion ?? 0) + 1,
    features: {},
    quotas: { users: 1 },
    code: undefined,
    error: undefined,
  };
}

async function main(): Promise<void> {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-no-stripe-notebook-'));
  const databasePath = path.join(dataRoot, 'membership.db');
  const workspaceDirectory = path.join(
    dataRoot,
    'organizations',
    'organization-no-stripe',
    'workspaces',
    'team',
  );
  const workspaceFile = path.join(workspaceDirectory, 'preserved.txt');
  const instanceId = 'instance-no-stripe-notebook';
  const licenseId = '11111111-1111-4111-8111-111111111111';
  const environmentNames = [
    'DATA',
    'CANVAS_DATABASE_PROVIDER',
    'CANVAS_INSTANCE_ID',
    'CANVAS_LICENSE_RUNTIME_ENVIRONMENT',
    'CANVAS_LICENSE_PUBLIC_KEY',
    'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_LICENSE_TEST_PUBLIC_KEY',
    'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_LICENSE_TEST_AUDIENCE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ] as const;
  const previousEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  const productionPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const testPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const productionPublicKey = productionPair.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const testPublicKey = testPair.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const productionFingerprint = fingerprint(productionPublicKey);
  const testFingerprint = fingerprint(testPublicKey);
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 7_200;

  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_INSTANCE_ID = instanceId;
  process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
  process.env.CANVAS_LICENSE_PUBLIC_KEY = productionPublicKey;
  process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = productionFingerprint;
  process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY = testPublicKey;
  process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS = testFingerprint;
  process.env.CANVAS_LICENSE_TEST_AUDIENCE = 'canvas-notebook-test';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;

  const initialPayload = testLicensePayload({
    instanceId,
    licenseId,
    seatLimit: 1,
    entitlementsVersion: 1,
    expiresAtSeconds,
  });
  const raisedPayload = testLicensePayload({
    instanceId,
    licenseId,
    seatLimit: 2,
    entitlementsVersion: 2,
    expiresAtSeconds,
  });
  const testKid = `test-${testFingerprint.slice(0, 16)}`;
  const initialCertificate = signLicense(testPair.privateKey, testKid, initialPayload);
  const raisedCertificate = signLicense(testPair.privateKey, testKid, raisedPayload);
  let sqlite: Database.Database | null = null;

  try {
    const {
      activateLicenseCert,
    } = await import('../app/lib/license');
    const {
      verifyLicenseJwtDetailed,
    } = await import('../app/lib/license/jwt');
    const {
      reconcileTeamLicenseLifecycle,
    } = await import('../app/lib/license/team-license-lifecycle');
    const {
      beginDirectMembershipActivation,
      completeDirectMembershipActivation,
      MembershipOrchestratorError,
      recordDirectMembershipSeatExecutionPending,
      recordDirectMembershipSeatPreparation,
    } = await import('../app/lib/organization/membership-orchestrator');
    const {
      adoptActiveTeamMembership,
      getActiveTeamMembershipProjection,
      getTeamMembershipByCandidateEmail,
    } = await import('../app/lib/organization/team-membership');

    const initialStatus = await activateLicenseCert(
      initialCertificate,
      {
        licenseId,
        instanceId,
        plan: 'community',
        status: 'active',
        hostingMode: 'community',
        edition: 'team',
        licenseClass: 'test',
        licenseEnvironment: 'development',
        entitlementsVersion: 1,
      },
    );
    assert.equal(initialStatus.licensed, true);
    assert.equal(initialStatus.licenseClass, 'test');
    assert.equal(initialStatus.seatLimit, 1);

    sqlite = new Database(databasePath);
    sqlite.pragma('foreign_keys = ON');
    runMigrations(sqlite);
    const connection = {
      get: (sql: string, params?: unknown[]) => (
        params ? sqlite!.prepare(sql).get(...params) : sqlite!.prepare(sql).get()
      ),
      run: (sql: string, params?: unknown[]) => (
        params ? sqlite!.prepare(sql).run(...params) : sqlite!.prepare(sql).run()
      ),
      all: (sql: string, params?: unknown[]) => (
        params ? sqlite!.prepare(sql).all(...params) : sqlite!.prepare(sql).all()
      ),
      close: () => undefined,
    };
    const now = Date.parse('2026-08-01T10:00:00.000Z');

    sqlite.prepare(`
      INSERT INTO "user" (
        id, name, email, email_verified, role, banned, ban_reason, created_at, updated_at
      ) VALUES ('owner-user', 'Owner', 'owner@example.test', 1, 'admin', 0, NULL, ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled,
        created_at, updated_at
      ) VALUES ('organization-no-stripe', 'owner-user', 'community-team', 1, ?, ?)
    `).run(now, now);
    await adoptActiveTeamMembership(connection, {
      organizationId: 'organization-no-stripe',
      userId: 'owner-user',
      role: 'owner',
      source: 'first_owner',
      seatOperationType: 'reconcile',
      now,
      databaseProvider: 'sqlite',
    });

    const started = await beginDirectMembershipActivation({
      organizationId: 'organization-no-stripe',
      actorUserId: 'owner-user',
      email: 'test.member@example.test',
      displayName: 'Test Member',
      role: 'member',
      database: connection,
      databaseProvider: 'sqlite',
      now: now + 100,
    });
    const preparedPayload = prepareResponse({ licenseId, desiredQuantity: 2 });
    assert.equal(preparedPayload.quote.provider, 'test');
    assert.equal(preparedPayload.quote.nonBillable, true);
    assert.equal(preparedPayload.quote.recurringAmountCents, 0);
    const prepared = await recordDirectMembershipSeatPreparation({
      organizationId: 'organization-no-stripe',
      membershipId: started.membership.id,
      prepareOperationId: started.prepareOperation.operationId,
      response: preparedPayload,
      actorUserId: 'owner-user',
      database: connection,
      databaseProvider: 'sqlite',
      now: now + 200,
    });
    assert.equal(prepared.stage, 'seat_execute_pending');
    assert.ok(prepared.executeOperation);
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?')
        .pluck()
        .get('test.member@example.test'),
      0,
    );

    let identityCreations = 0;
    let identityActivations = 0;
    const identity = {
      ensurePending: async (input: {
        name: string;
        email: string;
        password: string;
        role: 'admin' | 'user';
      }) => {
        identityCreations += 1;
        sqlite!.prepare(`
          INSERT INTO "user" (
            id, name, email, email_verified, role, banned, ban_reason, created_at, updated_at
          ) VALUES (
            'test-member-user', ?, ?, 1, ?, 1,
            'canvas_team_membership_pending', ?, ?
          )
        `).run(input.name, input.email, input.role, now + 300, now + 300);
        return { id: 'test-member-user', email: input.email };
      },
      activate: async (userId: string) => {
        identityActivations += 1;
        sqlite!.prepare(`
          UPDATE "user"
          SET banned = 0, ban_reason = NULL
          WHERE id = ? AND ban_reason = 'canvas_team_membership_pending'
        `).run(userId);
      },
    };
    const insufficientResponse = appliedResponse({
      certificate: initialCertificate,
      instanceId,
      licenseId,
      operationKey: prepared.executeOperation!.operationId,
      desiredQuantity: 2,
      entitlementsVersion: 2,
    });
    await assert.rejects(
      completeDirectMembershipActivation({
        organizationId: 'organization-no-stripe',
        membershipId: started.membership.id,
        executeOperationId: prepared.executeOperation!.operationId,
        response: insufficientResponse,
        password: 'test-only-password',
        actorUserId: 'owner-user',
        database: connection,
        databaseProvider: 'sqlite',
        identity,
        now: now + 300,
      }),
      (error: unknown) => (
        error instanceof MembershipOrchestratorError
        && error.code === 'MEMBERSHIP_SIGNED_LIMIT_INVALID'
      ),
    );
    assert.equal(identityCreations, 0);
    assert.equal(identityActivations, 0);
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?')
        .pluck()
        .get('test.member@example.test'),
      0,
      'a valid test certificate with insufficient capacity must not create a user',
    );

    const raisedResponse = appliedResponse({
      certificate: raisedCertificate,
      instanceId,
      licenseId,
      operationKey: prepared.executeOperation!.operationId,
      desiredQuantity: 2,
      entitlementsVersion: 2,
    });
    const completed = await completeDirectMembershipActivation({
      organizationId: 'organization-no-stripe',
      membershipId: started.membership.id,
      executeOperationId: prepared.executeOperation!.operationId,
      response: raisedResponse,
      password: 'test-only-password',
      actorUserId: 'owner-user',
      database: connection,
      databaseProvider: 'sqlite',
      identity,
      now: now + 400,
    });
    assert.equal(completed.stage, 'active');
    assert.equal(completed.observedQuantity, 2);
    assert.equal(identityCreations, 1);
    assert.equal(identityActivations, 1);
    assert.deepEqual(
      sqlite.prepare('SELECT banned, ban_reason FROM "user" WHERE id = ?')
        .get('test-member-user'),
      { banned: 0, ban_reason: null },
    );

    const failureStarted = await beginDirectMembershipActivation({
      organizationId: 'organization-no-stripe',
      actorUserId: 'owner-user',
      email: 'failure.member@example.test',
      displayName: 'Failure Member',
      role: 'member',
      database: connection,
      databaseProvider: 'sqlite',
      now: now + 500,
    });
    const failurePreparedPayload = prepareResponse({ licenseId, desiredQuantity: 3 });
    const failurePrepared = await recordDirectMembershipSeatPreparation({
      organizationId: 'organization-no-stripe',
      membershipId: failureStarted.membership.id,
      prepareOperationId: failureStarted.prepareOperation.operationId,
      response: failurePreparedPayload,
      actorUserId: 'owner-user',
      database: connection,
      databaseProvider: 'sqlite',
      now: now + 600,
    });
    assert.ok(failurePrepared.executeOperation);
    const requiresActionResponse = {
      operation: {
        protocolVersion: 'canvas-team-seat-protocol-v1',
        operationId: randomUUID(),
        operationKey: failurePrepared.executeOperation!.operationId,
        operationType: 'member_create',
        provider: 'test',
        environment: 'development',
        status: 'requires_action',
        paymentStatus: 'requires_action',
        previousQuantity: 2,
        requestedQuantity: 3,
        effectiveQuantity: null,
        retryCount: 0,
        lastError: null,
        effectiveAt: null,
        entitlementsVersion: null,
        certificateReissueStatus: 'pending',
        createdAt: '2026-08-01T10:02:00.000Z',
        updatedAt: '2026-08-01T10:02:00.000Z',
      },
      replayed: false,
      license: null,
    };
    const requiresAction = await recordDirectMembershipSeatExecutionPending({
      organizationId: 'organization-no-stripe',
      membershipId: failureStarted.membership.id,
      executeOperationId: failurePrepared.executeOperation!.operationId,
      response: requiresActionResponse,
      database: connection,
      now: now + 700,
    });
    assert.equal(requiresAction.activation.stage, 'billing_pending');
    assert.equal(requiresAction.activation.membership.status, 'billing_pending');
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?')
        .pluck()
        .get('failure.member@example.test'),
      0,
    );
    const paymentFailed = await recordDirectMembershipSeatExecutionPending({
      organizationId: 'organization-no-stripe',
      membershipId: failureStarted.membership.id,
      executeOperationId: failurePrepared.executeOperation!.operationId,
      response: {
        ...requiresActionResponse,
        operation: {
          ...requiresActionResponse.operation,
          status: 'failed',
          paymentStatus: 'payment_failed',
          lastError: 'Simulated non-billable provider failure.',
          certificateReissueStatus: 'failed',
          updatedAt: '2026-08-01T10:02:01.000Z',
        },
      },
      database: connection,
      now: now + 800,
    });
    assert.equal(paymentFailed.activation.stage, 'billing_pending');
    assert.equal(paymentFailed.execution.operation.status, 'failed');
    assert.equal(paymentFailed.execution.license, null);
    assert.equal(
      (await getActiveTeamMembershipProjection(
        connection,
        'organization-no-stripe',
      )).observedQuantity,
      2,
    );
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) FROM "user" WHERE email = ?')
        .pluck()
        .get('failure.member@example.test'),
      0,
    );

    mkdirSync(workspaceDirectory, { recursive: true });
    writeFileSync(workspaceFile, 'preserve no-stripe data\n', 'utf8');
    sqlite.prepare(`
      INSERT INTO canvas_workspaces (
        id, organization_id, type, display_name, root_relative_path,
        status, created_at, updated_at
      ) VALUES (
        'workspace-no-stripe', 'organization-no-stripe', 'team', 'Team',
        'organizations/organization-no-stripe/workspaces/team',
        'active', ?, ?
      )
    `).run(now, now);
    for (const userId of ['owner-user', 'test-member-user']) {
      sqlite.prepare(`
        INSERT INTO session (
          id, token, user_id, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        `session-${userId}`,
        `token-${userId}`,
        userId,
        now + 86_400_000,
        now,
        now,
      );
    }

    const activeTestStatus = await activateLicenseCert(
      raisedCertificate,
      {
        licenseId,
        instanceId,
        plan: 'community',
        status: 'active',
        hostingMode: 'community',
        edition: 'team',
        licenseClass: 'test',
        licenseEnvironment: 'development',
        entitlementsVersion: 2,
      },
    );
    const expired = await reconcileTeamLicenseLifecycle(
      lifecycleStatus(activeTestStatus),
      {
        database: connection,
        databaseProvider: 'sqlite',
        now: new Date(now + 1_000),
      },
    );
    assert.equal(expired.mode, 'solo');
    assert.equal(expired.suspendedMemberships, 1);
    assert.equal(expired.revokedSessions, 1);
    assert.deepEqual(
      await connection.all(`
        SELECT user_id
        FROM team_memberships
        WHERE organization_id = 'organization-no-stripe' AND status = 'active'
      `),
      [{ user_id: 'owner-user' }],
    );
    assert.equal(sqlite.prepare('SELECT COUNT(*) FROM "user"').pluck().get(), 2);
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) FROM canvas_workspaces').pluck().get(),
      1,
    );
    assert.equal(existsSync(workspaceFile), true);
    assert.equal(readFileSync(workspaceFile, 'utf8'), 'preserve no-stripe data\n');

    const restored = await reconcileTeamLicenseLifecycle(
      activeTestStatus,
      {
        database: connection,
        databaseProvider: 'sqlite',
        now: new Date(now + 2_000),
      },
    );
    assert.equal(restored.mode, 'team');
    assert.equal(restored.restoredMemberships, 1);
    assert.equal(
      (await getTeamMembershipByCandidateEmail(
        connection,
        'organization-no-stripe',
        'test.member@example.test',
      ))?.status,
      'active',
    );

    const revoked = await reconcileTeamLicenseLifecycle(
      revokedGrantStatus(activeTestStatus),
      {
        database: connection,
        databaseProvider: 'sqlite',
        now: new Date(now + 3_000),
      },
    );
    assert.equal(revoked.mode, 'solo');
    assert.equal(revoked.suspendedMemberships, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) FROM "user"').pluck().get(), 2);
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) FROM canvas_workspaces').pluck().get(),
      1,
    );
    assert.equal(existsSync(workspaceFile), true);

    process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'production';
    const productionRejection = await verifyLicenseJwtDetailed(
      raisedCertificate,
      instanceId,
    );
    assert.equal(productionRejection.ok, false);
    if (!productionRejection.ok) {
      assert.equal(productionRejection.code, 'LICENSE_CERT_ENVIRONMENT_INVALID');
    }
    assert.equal(process.env.STRIPE_SECRET_KEY, undefined);
    assert.equal(process.env.STRIPE_WEBHOOK_SECRET, undefined);
  } finally {
    sqlite?.close();
    for (const name of environmentNames) {
      const value = previousEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
}

void main()
  .then(() => {
    console.log('team-seat-test-license-activation-test: ok');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
