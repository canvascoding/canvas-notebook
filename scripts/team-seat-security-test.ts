import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  redactTeamControlPlaneLogText,
} from '../app/lib/control-plane/team-client';
import {
  publicCommunityInstanceTokenStatus,
} from '../app/lib/license/control-plane';
import { teamSeatMemberHash } from '../app/lib/license/team-seat-outbox';
import type { CommunityInstanceTokenStatus } from '../app/lib/license/storage';
import {
  requireTrustedMutationOrigin,
} from '../app/lib/security/mutation-origin';

const projectRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function mutationRequest(origin?: string, fetchSite?: string): NextRequest {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  if (fetchSite) headers.set('Sec-Fetch-Site', fetchSite);
  return new NextRequest('https://notebook.example.test/api/license/claim/start', {
    method: 'POST',
    headers,
  });
}

function testRedaction(): void {
  const instanceToken = `lit_${'s'.repeat(64)}`;
  const deviceCode = `dc_${'d'.repeat(64)}`;
  const activationKey = `opaque-${'k'.repeat(48)}`;
  const memberHash = 'a'.repeat(64);
  const certificate = [
    `eyJ${'a'.repeat(20)}`,
    `${'b'.repeat(24)}`,
    `${'c'.repeat(24)}`,
  ].join('.');
  const databaseUrl = 'postgresql://canvas:database-secret@postgres.internal/canvas';
  const text = [
    `Bearer ${instanceToken}`,
    deviceCode,
    activationKey,
    memberHash,
    certificate,
    'member@example.test',
    databaseUrl,
  ].join(' ');
  const redacted = redactTeamControlPlaneLogText(text, [activationKey]);

  for (const secret of [
    instanceToken,
    deviceCode,
    activationKey,
    memberHash,
    certificate,
    'member@example.test',
    'database-secret',
  ]) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /\[member-hash-redacted\]/u);
  assert.match(redacted, /\[certificate-redacted\]/u);
  assert.match(redacted, /\[email-redacted\]/u);
}

function testBrowserTokenBoundary(): void {
  const internal: CommunityInstanceTokenStatus = {
    configured: true,
    instanceId: 'self_security_test',
    tokenPrefix: 'lit_secret…',
    scopes: ['license:refresh', 'seat:snapshot'],
    expiresAt: '2030-01-01T00:00:00.000Z',
    expired: false,
    generation: 3,
    createdAt: '2026-08-01T00:00:00.000Z',
    rotatedAt: '2026-08-01T01:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
  };
  const browser = publicCommunityInstanceTokenStatus(internal);
  assert.deepEqual(browser, {
    configured: true,
    expiresAt: '2030-01-01T00:00:00.000Z',
    expired: false,
  });
  assert.doesNotMatch(
    JSON.stringify(browser),
    /instanceId|tokenPrefix|scope|generation|createdAt|rotatedAt|updatedAt|lit_secret/u,
  );

  const connectionPanel = source('app/components/license/CommunityTeamConnectionPanel.tsx');
  assert.doesNotMatch(
    connectionPanel,
    /instanceToken|deviceCode|tokenPrefix|\bscopes\b/u,
  );
  const statusRoute = source('app/api/license/status/route.ts');
  assert.doesNotMatch(statusRoute, /instanceToken|deviceCode|tokenPrefix/u);
}

function testMutationOriginBoundary(): void {
  const previousBaseUrl = process.env.BASE_URL;
  process.env.BASE_URL = 'https://notebook.example.test';
  try {
    assert.equal(
      requireTrustedMutationOrigin(
        mutationRequest('https://notebook.example.test', 'same-origin'),
      ).ok,
      true,
    );
    assert.equal(
      requireTrustedMutationOrigin(
        mutationRequest('https://attacker.example.test', 'cross-site'),
      ).ok,
      false,
    );
    assert.equal(
      requireTrustedMutationOrigin(
        mutationRequest('https://attacker.example.test', 'same-origin'),
      ).ok,
      false,
    );
    assert.equal(requireTrustedMutationOrigin(mutationRequest()).ok, false);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBaseUrl;
  }
}

function testPseudonymBoundary(): void {
  const organizationId = 'organization-security-test';
  const membershipId = 'team-membership-9f779e82-a916-4e4a-97a5-e10a38f34a41';
  const memberHash = teamSeatMemberHash(organizationId, membershipId);
  assert.match(memberHash, /^[a-f0-9]{64}$/u);
  assert.equal(teamSeatMemberHash(organizationId, membershipId), memberHash);
  assert.notEqual(
    teamSeatMemberHash(organizationId, 'team-membership-7de2ce07-8132-4cb7-af5d-aa633df218fe'),
    memberHash,
  );
  assert.notEqual(teamSeatMemberHash('organization-other', membershipId), memberHash);
  assert.doesNotMatch(memberHash, /member|example|@/u);

  const syncSource = source('app/lib/license/team-membership-sync.ts');
  const outboxSource = source('app/lib/license/team-seat-outbox.ts');
  assert.match(syncSource, /teamSeatMemberHash\(input\.organizationId, membershipId\)/u);
  assert.match(outboxSource, /teamSeatMemberHash\(input\.organizationId, member\.membershipId\)/u);
  assert.doesNotMatch(
    outboxSource.slice(outboxSource.indexOf('export function teamSeatMemberHash')),
    /candidateEmail|candidate_email|\.email/u,
  );
}

function testMutationRoutes(): void {
  const routes = [
    'app/api/license/activate/route.ts',
    'app/api/license/register/route.ts',
    'app/api/license/claim/start/route.ts',
    'app/api/license/claim/poll/route.ts',
    'app/api/license/claim/cancel/route.ts',
    'app/api/license/claim/rotate/route.ts',
    'app/api/license/team/preflight/route.ts',
    'app/api/license/team/recovery/route.ts',
    'app/api/admin/organization/memberships/route.ts',
    'app/api/admin/organization/memberships/invitations/route.ts',
    'app/api/admin/organization/memberships/invitations/[invitationId]/route.ts',
    'app/api/admin/organization/memberships/[membershipId]/activate/route.ts',
    'app/api/admin/organization/memberships/[membershipId]/quote/route.ts',
    'app/api/admin/organization/users/[userId]/reactivation/route.ts',
    'app/api/admin/organization/users/[userId]/suspension/route.ts',
    'app/api/admin/organization/users/[userId]/role/route.ts',
    'app/api/admin/organization/users/[userId]/permissions/route.ts',
    'app/api/admin/organization/users/[userId]/offboarding/route.ts',
    'app/api/organization/invitations/accept/route.ts',
    'app/api/organization/invitations/activate/route.ts',
  ];
  for (const route of routes) {
    assert.match(
      source(route),
      /requireTrustedMutationOrigin\(request\)/u,
      `${route} must enforce the explicit CSRF origin boundary`,
    );
  }

  for (const route of [
    'app/api/license/activate/route.ts',
    'app/api/license/register/route.ts',
  ]) {
    assert.match(source(route), /rateLimit\(request/u);
  }

  const createRoute = source('app/api/admin/organization/memberships/route.ts');
  assert.match(createRoute, /requireInstanceAdmin/u);
  assert.match(createRoute, /isOrganizationAdminLike/u);
  assert.doesNotMatch(
    createRoute.slice(createRoute.indexOf('const body =')),
    /body\.(price|quantity|quoteHash|authorizationId|operationKey)/u,
  );
  const recoveryRoute = source('app/api/license/team/recovery/route.ts');
  assert.match(recoveryRoute, /isOrganizationBillingApprover/u);
  assert.doesNotMatch(
    recoveryRoute,
    /seat_prepare|seat_execute|prepareCommunityTeamSeatChange|executeCommunityTeamSeatChange/u,
  );
}

function testPrivateStorageBoundary(): void {
  const storage = source('app/lib/license/storage.ts');
  assert.match(storage, /^import 'server-only';/u);
  assert.match(storage, /PRIVATE_DIRECTORY_MODE = 0o700/u);
  assert.match(storage, /PRIVATE_FILE_MODE = 0o600/u);
  assert.match(storage, /assertOwnedNonSymlink/u);
  assert.match(storage, /writePrivateLicenseFileAtomic/u);
}

function main(): void {
  testRedaction();
  testBrowserTokenBoundary();
  testMutationOriginBoundary();
  testPseudonymBoundary();
  testMutationRoutes();
  testPrivateStorageBoundary();
  console.log('team-seat-security-test: ok');
}

main();
