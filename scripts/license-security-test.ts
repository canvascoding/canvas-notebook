import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function publicKeyFingerprint(publicKeyPem: string) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function signLicense(
  privateKey: crypto.KeyObject,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' },
) {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    privateKey,
  );
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

async function main() {
  for (const routePath of [
    'app/api/auth/[...all]/route.ts',
    'app/api/onboarding/user-initialize/route.ts',
    'app/api/agents/[agentId]/members/route.ts',
    'app/api/agents/[agentId]/members/[userId]/route.ts',
    'app/api/admin/organization/users/[userId]/permissions/route.ts',
    'app/api/admin/organization/users/[userId]/role/route.ts',
    'app/api/admin/organization/users/[userId]/offboarding/route.ts',
    'app/api/admin/organization/users/[userId]/suspension/route.ts',
    'app/api/admin/organization/users/[userId]/reactivation/route.ts',
  ]) {
    assert.match(
      readFileSync(path.join(process.cwd(), routePath), 'utf8'),
      /requireTeamRuntimeRoute/u,
      `${routePath} must enforce the Team license boundary`,
    );
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-license-security-'));
  const originalDatabaseProvider = process.env.CANVAS_DATABASE_PROVIDER;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATA = dataDir;
  process.env.CANVAS_INSTANCE_ID = 'self_license_test';

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = publicKeyFingerprint(publicKeyPem);
  process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
  process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;

  const {
    verifyLicenseJwt,
    verifyLicenseJwtDetailed,
  } = await import('../app/lib/license/jwt');
  const {
    LicenseCertificateStorageError,
    loadStoredLicenseCert,
    saveLicenseCert,
  } = await import('../app/lib/license/storage');
  const { getLicenseStatus } = await import('../app/lib/license');
  const {
    LicenseEntitlementError,
    requireLicenseFeature,
    requireLicenseQuota,
    requireLicensePlan,
    requireTeamRuntimeLicense,
  } = await import('../app/lib/license/entitlements');
  const { restrictWorkspaceListingToCore } = await import('../app/lib/workspaces/listing-action');

  const actor = { userId: 'owner-user', role: 'owner' as const };
  const personalWorkspace = {
    workspaceId: 'personal-workspace',
    workspaceType: 'personal' as const,
    rootPath: '/data/workspaces/personal/owner-user/files',
    isDefault: true,
    ownerUserId: actor.userId,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };
  const coreListing = restrictWorkspaceListingToCore({
    organizationId: 'org-test',
    teamFeaturesEnabled: true,
    projectFeaturesEnabled: true,
    canCreateSharedWorkspaces: true,
    databaseProvider: 'postgres',
    activeWorkspaceId: 'team-workspace',
    defaultWorkspace: null,
    workspaces: [
      personalWorkspace,
      {
        ...personalWorkspace,
        workspaceId: 'team-workspace',
        workspaceType: 'team',
        ownerUserId: null,
        isDefault: false,
      },
      {
        ...personalWorkspace,
        workspaceId: 'other-personal-workspace',
        ownerUserId: 'other-user',
        isDefault: false,
      },
    ],
    warnings: [],
  }, actor);
  assert.equal(coreListing.teamFeaturesEnabled, false);
  assert.equal(coreListing.projectFeaturesEnabled, false);
  assert.equal(coreListing.canCreateSharedWorkspaces, false);
  assert.equal(coreListing.activeWorkspaceId, personalWorkspace.workspaceId);
  assert.equal(coreListing.defaultWorkspace?.workspaceId, personalWorkspace.workspaceId);
  assert.deepEqual(coreListing.workspaces.map((workspace) => workspace.workspaceId), [personalWorkspace.workspaceId]);
  assert.match(coreListing.warnings.at(-1) || '', /Team features are unavailable/u);

  const basePayload = {
    sub: 'self_license_test',
    iss: 'canvas-control-plane',
    aud: 'canvas-notebook',
    plan: 'managed',
    status: 'active',
    deploymentMode: 'managed-team',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true, liveCollaboration: false },
    features: { teamWorkspace: true, multiUser: true, vectorSearch: true },
    quotas: { users: 10 },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  const validToken = signLicense(privateKey, basePayload);
  assert.equal((await verifyLicenseJwt(validToken, 'self_license_test'))?.plan, 'managed');

  assert.equal(await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, iss: 'other' }), 'self_license_test'), null);
  assert.equal(await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, aud: 'other' }), 'self_license_test'), null);
  assert.equal(await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, status: 'issued' }), 'self_license_test'), null);
  assert.equal(await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, sub: 'other_instance' }), 'self_license_test'), null);
  assert.equal(
    await verifyLicenseJwt(signLicense(privateKey, { ...basePayload, iat: Math.floor(Date.now() / 1000) + 600 }), 'self_license_test'),
    null,
  );

  const { privateKey: forgedPrivateKey, publicKey: forgedPublicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CANVAS_LICENSE_PUBLIC_KEY = forgedPublicKey.export({ type: 'spki', format: 'pem' }).toString();
  const forgedToken = signLicense(forgedPrivateKey, basePayload);
  assert.equal(await verifyLicenseJwt(forgedToken, 'self_license_test'), null);

  process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
  const trustedKid = fingerprint.slice(0, 16);
  const modernPayload = {
    ...basePayload,
    protocolVersion: 'canvas-team-seat-protocol-v1',
    licenseId: 'license-modern',
    instanceId: 'self_license_test',
    hostingMode: 'cloud',
    edition: 'team',
    licenseClass: 'commercial',
    licenseEnvironment: 'production',
    seatLimit: 10,
    entitlementsVersion: 5,
    nonBillable: false,
  };
  const modernToken = signLicense(privateKey, modernPayload, {
    alg: 'RS256',
    typ: 'JWT',
    kid: trustedKid,
  });
  assert.equal((await verifyLicenseJwtDetailed(modernToken, 'self_license_test')).ok, true);

  async function expectVerificationCode(
    token: string,
    code: string,
    expectedInstanceId = 'self_license_test',
  ) {
    const result = await verifyLicenseJwtDetailed(token, expectedInstanceId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, code);
  }

  await expectVerificationCode('not-a-jwt', 'LICENSE_CERT_MALFORMED');
  await expectVerificationCode(
    signLicense(privateKey, modernPayload, { alg: 'HS256', typ: 'JWT', kid: trustedKid }),
    'LICENSE_CERT_ALGORITHM_INVALID',
  );
  await expectVerificationCode(
    signLicense(forgedPrivateKey, modernPayload, { alg: 'RS256', typ: 'JWT', kid: trustedKid }),
    'LICENSE_CERT_SIGNATURE_INVALID',
  );
  await expectVerificationCode(
    signLicense(privateKey, { ...modernPayload, iss: 'other' }, { alg: 'RS256', typ: 'JWT', kid: trustedKid }),
    'LICENSE_CERT_ISSUER_INVALID',
  );
  await expectVerificationCode(
    signLicense(privateKey, { ...modernPayload, aud: 'other' }, { alg: 'RS256', typ: 'JWT', kid: trustedKid }),
    'LICENSE_CERT_AUDIENCE_INVALID',
  );
  await expectVerificationCode(
    signLicense(privateKey, { ...modernPayload, status: 'issued' }, { alg: 'RS256', typ: 'JWT', kid: trustedKid }),
    'LICENSE_CERT_STATUS_INVALID',
  );
  await expectVerificationCode(
    signLicense(privateKey, { ...modernPayload, plan: 'enterprise' }, { alg: 'RS256', typ: 'JWT', kid: trustedKid }),
    'LICENSE_CERT_PLAN_INVALID',
  );
  await expectVerificationCode(
    signLicense(privateKey, {
      ...modernPayload,
      iat: Math.floor(Date.now() / 1000) - 3600,
      exp: Math.floor(Date.now() / 1000) - 1,
    }, { alg: 'RS256', typ: 'JWT', kid: trustedKid }),
    'LICENSE_CERT_EXPIRED',
  );

  const wrongInstance = await verifyLicenseJwtDetailed(modernToken, 'other_instance');
  assert.equal(wrongInstance.ok, false);
  if (!wrongInstance.ok) assert.equal(wrongInstance.code, 'LICENSE_CERT_INSTANCE_MISMATCH');

  const missingKid = await verifyLicenseJwtDetailed(
    signLicense(privateKey, modernPayload),
    'self_license_test',
  );
  assert.equal(missingKid.ok, false);
  if (!missingKid.ok) assert.equal(missingKid.code, 'LICENSE_CERT_KEY_ID_MISSING');

  const unknownKid = await verifyLicenseJwtDetailed(
    signLicense(privateKey, modernPayload, { alg: 'RS256', typ: 'JWT', kid: 'unknown-key' }),
    'self_license_test',
  );
  assert.equal(unknownKid.ok, false);
  if (!unknownKid.ok) assert.equal(unknownKid.code, 'LICENSE_CERT_KEY_ID_UNKNOWN');

  const invalidSeatLimit = await verifyLicenseJwtDetailed(
    signLicense(privateKey, { ...modernPayload, seatLimit: 1.5 }, {
      alg: 'RS256',
      typ: 'JWT',
      kid: trustedKid,
    }),
    'self_license_test',
  );
  assert.equal(invalidSeatLimit.ok, false);
  if (!invalidSeatLimit.ok) assert.equal(invalidSeatLimit.code, 'LICENSE_CERT_CLAIMS_INVALID');

  const originalNodeEnv = process.env.NODE_ENV;
  Reflect.set(process.env, 'NODE_ENV', 'production');
  for (const licenseEnvironment of ['development', 'test']) {
    const productionTestCertificate = await verifyLicenseJwtDetailed(
      signLicense(privateKey, {
        ...modernPayload,
        licenseClass: 'test',
        licenseEnvironment,
        nonBillable: true,
        grantId: `grant-${licenseEnvironment}`,
      }, {
        alg: 'RS256',
        typ: 'JWT',
        kid: trustedKid,
      }),
      'self_license_test',
    );
    assert.equal(productionTestCertificate.ok, false);
    if (!productionTestCertificate.ok) {
      assert.equal(productionTestCertificate.code, 'LICENSE_CERT_ENVIRONMENT_INVALID');
    }
  }
  const productionTestInstanceId = 'production_test_license_instance';
  process.env.CANVAS_INSTANCE_ID = productionTestInstanceId;
  process.env.CANVAS_LICENSE_CERT = signLicense(privateKey, {
    ...modernPayload,
    sub: productionTestInstanceId,
    instanceId: productionTestInstanceId,
    licenseId: 'license-production-test-rejected',
    licenseClass: 'test',
    licenseEnvironment: 'test',
    nonBillable: true,
    grantId: 'grant-production-test-rejected',
  }, {
    alg: 'RS256',
    typ: 'JWT',
    kid: trustedKid,
  });
  const productionTestStatus = await getLicenseStatus();
  assert.equal(productionTestStatus.licensed, false);
  assert.equal(productionTestStatus.plan, 'unregistered');
  assert.equal(productionTestStatus.hostingMode, null);
  assert.equal(productionTestStatus.code, 'LICENSE_CERT_ENVIRONMENT_INVALID');
  assert.equal(productionTestStatus.error, 'license_environment_invalid');
  process.env.CANVAS_INSTANCE_ID = 'self_license_test';
  delete process.env.CANVAS_LICENSE_CERT;
  if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
  else Reflect.set(process.env, 'NODE_ENV', originalNodeEnv);

  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://127.0.0.1/canvas_license_security_test';
  process.env.CANVAS_LICENSE_CERT = validToken;
  assert.equal((await requireLicenseFeature('teamWorkspace')).features.teamWorkspace, true);
  assert.equal((await requireLicensePlan(['managed'])).plan, 'managed');
  assert.equal((await requireLicenseQuota('users', 5)).quotas.users, 10);
  const teamRuntimeStatus = await requireTeamRuntimeLicense();
  assert.equal(teamRuntimeStatus.protocolVersion, 'legacy');
  assert.equal(teamRuntimeStatus.hostingMode, 'cloud');
  assert.equal(teamRuntimeStatus.edition, 'team');
  assert.equal(teamRuntimeStatus.licenseClass, 'commercial');
  assert.equal(teamRuntimeStatus.licenseEnvironment, 'production');
  assert.equal(teamRuntimeStatus.seatLimit, 10);
  assert.equal(teamRuntimeStatus.databaseProvider, 'postgres');
  assert.equal(teamRuntimeStatus.vectorProvider, 'pgvector');
  assert.equal(teamRuntimeStatus.postgresRequired, true);

  const providerOptionalInstanceId = 'runtime_provider_optional_instance';
  const providerOptionalToken = signLicense(privateKey, {
    ...basePayload,
    sub: providerOptionalInstanceId,
    databaseProvider: undefined,
    iat: basePayload.iat + 30,
  });
  process.env.CANVAS_INSTANCE_ID = providerOptionalInstanceId;
  process.env.CANVAS_LICENSE_CERT = providerOptionalToken;
  const providerOptionalStatus = await requireTeamRuntimeLicense();
  assert.equal(providerOptionalStatus.databaseProvider, null);

  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  await assert.rejects(
    () => requireTeamRuntimeLicense(),
    (error) => error instanceof LicenseEntitlementError
      && error.code === 'LICENSE_FEATURE_REQUIRED'
      && error.statusCode === 403
      && error.details.runtimeDatabaseProvider === 'sqlite'
      && Array.isArray(error.details.blockers)
      && error.details.blockers.includes('team_requires_postgres'),
  );

  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  delete process.env.DATABASE_URL;
  await assert.rejects(
    () => requireTeamRuntimeLicense(),
    (error) => error instanceof LicenseEntitlementError
      && error.code === 'LICENSE_FEATURE_REQUIRED'
      && error.statusCode === 403
      && error.details.runtimeDatabaseProvider === 'postgres'
      && Array.isArray(error.details.blockers)
      && error.details.blockers.includes('postgres_missing_database_url'),
  );
  process.env.DATABASE_URL = 'postgresql://127.0.0.1/canvas_license_security_test';
  process.env.CANVAS_INSTANCE_ID = 'self_license_test';
  process.env.CANVAS_LICENSE_CERT = validToken;

  await assert.rejects(
    () => requireLicenseFeature('teamKnowledgeBase'),
    (error) => error instanceof LicenseEntitlementError && error.code === 'LICENSE_FEATURE_REQUIRED',
  );

  const rollbackInstanceId = 'license_rollback_instance';
  const rollbackBase = {
    ...modernPayload,
    sub: rollbackInstanceId,
    instanceId: rollbackInstanceId,
    licenseId: 'license-rollback',
    hostingMode: 'community',
    plan: 'community',
    deploymentMode: 'community',
    databaseProvider: 'postgres',
    edition: 'team',
    seatLimit: 5,
  };
  const versionFiveToken = signLicense(privateKey, {
    ...rollbackBase,
    entitlementsVersion: 5,
    iat: basePayload.iat + 10,
  }, { alg: 'RS256', typ: 'JWT', kid: trustedKid });
  const versionFive = await verifyLicenseJwtDetailed(versionFiveToken, rollbackInstanceId);
  if (!versionFive.ok) assert.fail(versionFive.code);
  await saveLicenseCert(versionFiveToken, versionFive.payload);

  const versionFourToken = signLicense(privateKey, {
    ...rollbackBase,
    entitlementsVersion: 4,
    iat: basePayload.iat + 20,
  }, { alg: 'RS256', typ: 'JWT', kid: trustedKid });
  const versionFour = await verifyLicenseJwtDetailed(versionFourToken, rollbackInstanceId);
  if (!versionFour.ok) assert.fail(versionFour.code);
  await assert.rejects(
    () => saveLicenseCert(versionFourToken, versionFour.payload),
    (error) => error instanceof LicenseCertificateStorageError
      && error.code === 'LICENSE_CERT_ROLLBACK',
  );
  assert.equal(await loadStoredLicenseCert(rollbackInstanceId), versionFiveToken);

  const versionSixToken = signLicense(privateKey, {
    ...rollbackBase,
    entitlementsVersion: 6,
    iat: basePayload.iat + 5,
  }, { alg: 'RS256', typ: 'JWT', kid: trustedKid });
  const versionSix = await verifyLicenseJwtDetailed(versionSixToken, rollbackInstanceId);
  if (!versionSix.ok) assert.fail(versionSix.code);
  await saveLicenseCert(versionSixToken, versionSix.payload);
  assert.equal(await loadStoredLicenseCert(rollbackInstanceId), versionSixToken);
  process.env.CANVAS_INSTANCE_ID = rollbackInstanceId;
  process.env.CANVAS_LICENSE_CERT = versionFourToken;
  const rollbackProtectedStatus = await getLicenseStatus();
  assert.equal(rollbackProtectedStatus.licensed, true);
  assert.equal(rollbackProtectedStatus.source, 'stored');
  assert.equal(rollbackProtectedStatus.entitlementsVersion, 6);
  assert.equal(await loadStoredLicenseCert(rollbackInstanceId), versionSixToken);
  process.env.CANVAS_INSTANCE_ID = 'self_license_test';
  process.env.CANVAS_LICENSE_CERT = validToken;
  await assert.rejects(
    () => requireLicensePlan(['pro']),
    (error) => error instanceof LicenseEntitlementError && error.code === 'LICENSE_PLAN_REQUIRED',
  );
  await assert.rejects(
    () => requireLicenseQuota('users', 11),
    (error) => error instanceof LicenseEntitlementError && error.code === 'LICENSE_QUOTA_REQUIRED',
  );

  process.env.CANVAS_LICENSE_CERT = signLicense(privateKey, {
    ...basePayload,
    deploymentMode: 'managed-single',
    databaseProvider: 'sqlite',
    vectorProvider: 'none',
    postgresRequired: false,
    capabilities: { teamWorkspace: false, multiUser: false, vectorSearch: false, liveCollaboration: false },
    features: { teamWorkspace: false },
    iat: basePayload.iat + 1,
  });
  await assert.rejects(
    () => requireTeamRuntimeLicense(),
    (error) => error instanceof LicenseEntitlementError && error.code === 'LICENSE_TEAM_REQUIRED',
  );

  delete process.env.CANVAS_LICENSE_CERT;
  process.env.CANVAS_INSTANCE_ID = 'self_unlicensed_license_test';
  await assert.rejects(
    () => requireTeamRuntimeLicense(),
    (error) => error instanceof LicenseEntitlementError
      && error.code === 'LICENSE_TEAM_REQUIRED'
      && error.statusCode === 402,
  );

  const expiredInstanceId = 'expired_team_license_instance';
  process.env.CANVAS_INSTANCE_ID = expiredInstanceId;
  process.env.CANVAS_LICENSE_CERT = signLicense(privateKey, {
    ...rollbackBase,
    sub: expiredInstanceId,
    instanceId: expiredInstanceId,
    licenseId: 'license-expired-team',
    entitlementsVersion: 7,
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 60,
  }, { alg: 'RS256', typ: 'JWT', kid: trustedKid });
  const expiredStatus = await getLicenseStatus();
  assert.equal(expiredStatus.licensed, false);
  assert.equal(expiredStatus.licenseState, 'grace_required');
  assert.equal(expiredStatus.edition, 'team');
  assert.equal(expiredStatus.error, 'license_expired');
  assert.equal(expiredStatus.code, 'LICENSE_CERT_EXPIRED');

  delete process.env.CANVAS_LICENSE_CERT;
  if (originalDatabaseProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
  else process.env.CANVAS_DATABASE_PROVIDER = originalDatabaseProvider;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
