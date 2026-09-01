import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildTeamSeatHealth } from '../app/lib/license/team-seat-health';
import { codeFromLicenseStatus } from '../app/lib/license/error-codes';
import { publicLicenseStatus } from '../app/lib/license/status-response';
import { includesTeamRuntimeLicense } from '../app/lib/license/team-runtime-status';
import type { TeamSeatSyncDiagnostics } from '../app/lib/license/team-seat-outbox';
import type { LicenseStatus } from '../app/lib/license/types';

const now = Date.parse('2026-08-01T12:00:00.000Z');

function licenseStatus(input: {
  state?: LicenseStatus['licenseState'];
  graceExpiresAt?: string | null;
  licenseClass?: LicenseStatus['licenseClass'];
  licenseEnvironment?: LicenseStatus['licenseEnvironment'];
  seatLimit?: number;
  expiresAt?: string | null;
} = {}): LicenseStatus {
  return {
    plan: 'community',
    licensed: true,
    instanceId: 'self_team_seat_health_test',
    licenseState: input.state ?? 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    hostingMode: 'community',
    edition: 'team',
    licenseClass: input.licenseClass ?? 'commercial',
    licenseEnvironment: input.licenseEnvironment ?? 'production',
    seatLimit: input.seatLimit ?? 3,
    deploymentMode: 'community',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: { multiUser: true, teamWorkspace: true },
    organizationId: 'organization-health',
    entitlementsVersion: 7,
    expiresAt: input.expiresAt === undefined
      ? '2030-01-01T00:00:00.000Z'
      : input.expiresAt,
    features: { multiUser: true, teamWorkspace: true },
    quotas: { users: 3 },
    source: 'stored',
    refresh: {
      phase: input.state === 'grace' ? 'backoff' : 'active',
      lastAttemptAt: new Date(now - 30_000).toISOString(),
      lastSuccessAt: new Date(now - 60_000).toISOString(),
      nextAttemptAt: new Date(now + 30_000).toISOString(),
      consecutiveFailures: input.state === 'grace' ? 1 : 0,
      lastErrorCode: input.state === 'grace' ? 'TEAM_SEAT_TEMPORARY_UNAVAILABLE' : null,
      retryable: input.state === 'grace',
    },
    graceStartedAt: input.state === 'grace'
      ? new Date(now - 60_000).toISOString()
      : null,
    graceExpiresAt: input.graceExpiresAt ?? null,
  };
}

function diagnostics(overrides: Partial<TeamSeatSyncDiagnostics['state']> = {}): TeamSeatSyncDiagnostics {
  return {
    state: {
      organizationId: 'organization-health',
      currentRevision: 5,
      currentObservedQuantity: 3,
      latestSnapshotHash: 'snapshot-hash',
      latestSnapshotGeneratedAt: now - 60_000,
      lastLocalChangeAt: now - 60_000,
      acknowledgedRevision: 5,
      acknowledgedSnapshotId: 'snapshot-id',
      acknowledgedSnapshotHash: 'snapshot-hash',
      acknowledgedAt: now - 30_000,
      controlPlaneProtocolVersion: 'canvas-team-seat-protocol-v1',
      controlPlaneObservedQuantity: 3,
      approvedQuantity: 3,
      billedQuantity: 3,
      licensedQuantity: 3,
      expectedLicensedQuantity: 3,
      entitlementsVersion: 7,
      billingStatus: 'active',
      driftStatus: 'in_sync',
      reconciliationStatus: 'in_sync',
      reconciliationAction: 'none',
      reconciliationReason: 'quantities_in_sync',
      reconciliationSeatLimit: null,
      reconciliationSupportRequired: false,
      reconciledAt: now - 30_000,
      nextReportAt: now + 60_000,
      lastSyncErrorCode: null,
      lastSyncError: null,
      lastSyncAt: now - 30_000,
      createdAt: now - 300_000,
      updatedAt: now - 30_000,
      ...overrides,
    },
    outbox: {
      pending: 1,
      processing: 1,
      retryWait: 1,
      failed: 0,
      oldestPendingAt: now - 20_000,
    },
  };
}

function main(): void {
  const healthy = buildTeamSeatHealth({
    organizationId: 'organization-health',
    diagnostics: diagnostics(),
    claim: {
      state: 'connected',
      claimId: 'claim-id',
      organizationId: 'control-plane-organization',
      token: {
        configured: true,
        expiresAt: new Date(now + 3_600_000).toISOString(),
        expired: false,
      },
    },
    licenseStatus: licenseStatus(),
    now,
  });
  assert.equal(healthy.sync.state, 'healthy');
  assert.deepEqual(
    [
      healthy.sync.observedQuantity,
      healthy.sync.billedQuantity,
      healthy.sync.licensedQuantity,
    ],
    [3, 3, 3],
  );
  assert.equal(healthy.sync.pendingOperations, 3);
  assert.equal(healthy.claim.state, 'connected');
  assert.equal(healthy.recovery.canSyncSnapshot, true);
  assert.equal(healthy.recovery.canRefreshLicense, true);
  assert.equal(healthy.recovery.costConfirmationRequired, false);
  assert.deepEqual(healthy.license, {
    class: 'commercial',
    environment: 'production',
    seatLimit: 3,
    expiresAt: '2030-01-01T00:00:00.000Z',
    nonBillable: false,
    billingMode: 'commercial',
  });
  assert.doesNotMatch(JSON.stringify(healthy), /secret-prefix|license:refresh|seat:snapshot/u);

  const stale = buildTeamSeatHealth({
    organizationId: 'organization-health',
    diagnostics: diagnostics({
      nextReportAt: now - 120_000,
    }),
    claim: { state: 'idle', claimId: null },
    licenseStatus: licenseStatus(),
    now,
  });
  assert.equal(stale.sync.state, 'stale');

  const attention = buildTeamSeatHealth({
    organizationId: 'organization-health',
    diagnostics: diagnostics({
      reconciliationStatus: 'support_required',
      reconciliationAction: 'contact_support',
      reconciliationSupportRequired: true,
      reconciliationSeatLimit: 2,
    }),
    claim: {
      state: 'reconnect_required',
      claimId: null,
      reason: 'revoked',
      detectedAt: new Date(now - 10_000).toISOString(),
      coreUnaffected: true,
      teamAccessPolicy: 'signed_certificate_until_expiry',
    },
    licenseStatus: licenseStatus({
      state: 'grace',
      graceExpiresAt: new Date(now + 3_600_000).toISOString(),
    }),
    now,
  });
  assert.equal(attention.sync.state, 'attention');
  assert.equal(attention.sync.supportRequired, true);
  assert.equal(attention.sync.reconciliationSeatLimit, 2);
  assert.equal(attention.recovery.reconnectRequired, true);
  assert.equal(attention.recovery.canRefreshLicense, false);
  assert.equal(attention.grace.remainingSeconds, 3_600);

  const testGrantStatus = licenseStatus({
    licenseClass: 'test',
    licenseEnvironment: 'staging',
    seatLimit: 12,
    expiresAt: '2026-08-08T12:00:00.000Z',
  });
  const testGrant = buildTeamSeatHealth({
    organizationId: 'organization-health',
    diagnostics: diagnostics(),
    claim: { state: 'idle', claimId: null },
    licenseStatus: testGrantStatus,
    now,
  });
  assert.deepEqual(testGrant.license, {
    class: 'test',
    environment: 'staging',
    seatLimit: 12,
    expiresAt: '2026-08-08T12:00:00.000Z',
    nonBillable: true,
    billingMode: 'test_grant',
  });

  const authoritativeRuntime = buildTeamSeatHealth({
    organizationId: 'organization-health',
    diagnostics: diagnostics({
      currentRevision: 8,
      acknowledgedRevision: 7,
      currentObservedQuantity: 1,
      controlPlaneObservedQuantity: 2,
      approvedQuantity: 2,
      licensedQuantity: 2,
    }),
    claim: { state: 'connected', claimId: 'claim-id', organizationId: 'control-plane-organization', token: {
      configured: true,
      expiresAt: new Date(now + 3_600_000).toISOString(),
      expired: false,
    } },
    licenseStatus: licenseStatus({
      licenseClass: 'test',
      licenseEnvironment: 'development',
      seatLimit: 1,
    }),
    now,
  });
  assert.equal(authoritativeRuntime.sync.observedQuantity, 1);
  assert.equal(authoritativeRuntime.sync.approvedQuantity, 2);
  assert.equal(authoritativeRuntime.sync.licensedQuantity, 1);
  assert.equal(authoritativeRuntime.license.seatLimit, 1);

  const manualGrant = buildTeamSeatHealth({
    organizationId: 'organization-health',
    diagnostics: diagnostics(),
    claim: { state: 'idle', claimId: null },
    licenseStatus: licenseStatus({
      licenseClass: 'manual',
      licenseEnvironment: 'production',
    }),
    now,
  });
  assert.equal(manualGrant.license.nonBillable, true);
  assert.equal(manualGrant.license.billingMode, 'manual_grant');

  const memberStatus = publicLicenseStatus(testGrantStatus, 'LICENSE_ACTIVE');
  assert.equal(memberStatus.licensed, true);
  assert.equal(memberStatus.databaseProvider, 'postgres');
  assert.doesNotMatch(
    JSON.stringify(memberStatus),
    /licenseClass|licenseEnvironment|seatLimit|organizationId|entitlementsVersion|graceExpiresAt|refresh|quotas|source/u,
  );

  assert.equal(includesTeamRuntimeLicense({
    licensed: true,
    databaseProvider: null,
    runtimeDatabaseProvider: 'postgres',
    capabilities: {},
    features: { multiUser: true, teamWorkspace: true },
  }), true);
  assert.equal(includesTeamRuntimeLicense({
    licensed: true,
    databaseProvider: 'postgres',
    runtimeDatabaseProvider: 'sqlite',
    capabilities: { multiUser: true, teamWorkspace: true },
  }), false);

  const unavailableStatus: LicenseStatus = {
    ...licenseStatus(),
    licensed: false,
    licenseState: 'inactive',
    error: 'license_status_unavailable',
  };
  assert.equal(codeFromLicenseStatus(unavailableStatus), 'LICENSE_STATUS_UNAVAILABLE');

  const statusRoute = readFileSync(
    path.join(process.cwd(), 'app/api/license/status/route.ts'),
    'utf8',
  );
  assert.match(statusRoute, /isOrganizationBillingApprover/u);
  assert.match(statusRoute, /teamSeatHealth:\s*buildTeamSeatHealth/u);
  assert.match(statusRoute, /publicLicenseStatus\(status,\s*code\)/u);
  assert.match(statusRoute, /runtimeDatabaseProvider:\s*getDatabaseProvider\(\)/u);
  assert.doesNotMatch(statusRoute, /\.\.\.status/u);
  assert.doesNotMatch(statusRoute, /instanceToken|tokenPrefix|deviceCode/u);

  const activationRoute = readFileSync(
    path.join(process.cwd(), 'app/api/license/activate/route.ts'),
    'utf8',
  );
  assert.match(activationRoute, /publicLicenseStatus/u);
  assert.doesNotMatch(activationRoute, /\.\.\.status/u);

  const recoveryRoute = readFileSync(
    path.join(process.cwd(), 'app/api/license/team/recovery/route.ts'),
    'utf8',
  );
  assert.match(recoveryRoute, /isOrganizationBillingApprover/u);
  assert.match(recoveryRoute, /costConfirmationRequired:\s*false/u);
  assert.match(recoveryRoute, /automaticPurchaseAttempted:\s*false/u);
  assert.doesNotMatch(recoveryRoute, /seat_prepare|seat_execute|prepareCommunityTeamSeatChange|executeCommunityTeamSeatChange/u);

  const licensePanel = readFileSync(
    path.join(process.cwd(), 'app/components/license/LicenseActivationPanel.tsx'),
    'utf8',
  );
  const userPanel = readFileSync(
    path.join(process.cwd(), 'app/components/settings/UserManagementPanel.tsx'),
    'utf8',
  );
  assert.match(licensePanel, /canViewTeamSeatHealth[\s\S]*TeamSeatHealthPanel/u);
  assert.match(licensePanel, /licenseStatusAvailable=/u);
  assert.match(licensePanel, /teamSeatRollout=/u);
  assert.match(userPanel, /canViewTeamSeatHealth[\s\S]*TeamSeatHealthPanel/u);
  assert.match(userPanel, /teamLicenseUnavailableTitle/u);

  const connectionPanel = readFileSync(
    path.join(process.cwd(), 'app/components/license/CommunityTeamConnectionPanel.tsx'),
    'utf8',
  );
  assert.match(connectionPanel, /availabilityNotice/u);
  assert.match(connectionPanel, /licenseStatusAvailable/u);
  assert.match(connectionPanel, /<Alert>/u);

  const licenseStatusSource = readFileSync(
    path.join(process.cwd(), 'app/lib/license/index.ts'),
    'utf8',
  );
  assert.match(licenseStatusSource, /license status resolution failed/u);
  assert.match(licenseStatusSource, /license_status_unavailable/u);

  const loggingSource = readFileSync(
    path.join(process.cwd(), 'app/lib/license/logging.ts'),
    'utf8',
  );
  assert.match(loggingSource, /logLicenseError/u);
  assert.match(loggingSource, /redactTeamControlPlaneLogText/u);

  const healthPanel = readFileSync(
    path.join(process.cwd(), 'app/components/license/TeamSeatHealthPanel.tsx'),
    'utf8',
  );
  assert.match(healthPanel, /TESTLIZENZ/u);
  assert.match(healthPanel, /TEST LICENSE/u);
  assert.match(healthPanel, /NICHT ABRECHENBAR/u);
  assert.match(healthPanel, /NON-BILLABLE/u);
  assert.match(healthPanel, /Manual Grant/u);
  assert.match(healthPanel, /not represented as a Stripe subscription/u);
  assert.match(healthPanel, /health\.license\.expiresAt/u);
  assert.match(healthPanel, /health\.grace\.remainingSeconds/u);
  assert.doesNotMatch(
    healthPanel,
    /JSON\.stringify\(\{[^}]*(licenseClass|licenseEnvironment|environment)/u,
  );

  console.log('team-seat-health-test: ok');
}

main();
