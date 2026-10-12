import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { readBoundedJson } from '../app/lib/api/bounded-json';
import { TeamInvitationEmailError } from '../app/lib/organization/team-invitation-email';
import { TeamInvitationError } from '../app/lib/organization/team-invitations';
import { loadIsolatedModule } from './helpers/isolated-source-module';

async function main() {
  let trusted = true;
  let authenticated = true;
  let activeAdministrator = true;
  let runtimeReady = true;
  let policyReady = true;
  let limited = false;
  let sends = 0;
  let creates = 0;
  let captured: Record<string, unknown> | undefined;
  const failures: { current?: TeamInvitationEmailError } = {};
  let replayed = false;
  const invitation = { id: 'test-invitation', organizationId: 'session-org', membershipId: 'test-membership',
    email: 'invitee@example.test', role: 'member', status: 'pending', invitedByUserId: 'session-admin',
    expiresAt: 2_000_000_000_000, acceptedAt: null, revokedAt: null, createdAt: 1_000, updatedAt: 1_000 };
  const emailDelivery = { status: 'unconfigured', errorCode: 'INVITATION_EMAIL_DISABLED', deliveryUnknown: false,
    lastAttemptAt: 1_000, sentAt: null, resendAfter: 61_000, canResend: false };
  const mocks = {
    'next/server': { NextResponse },
    '@/app/lib/admin-auth': { requireInstanceAdmin: async () => authenticated
      ? { ok: true, session: { user: { id: 'session-admin' } } }
      : { ok: false, response: NextResponse.json({}, { status: 401 }) } },
    '@/app/lib/api/bounded-json': { readBoundedJson },
    '@/app/lib/license/team-route-guard': { requireTeamRuntimeRoute: async () => runtimeReady ? null : NextResponse.json({}, { status: 403 }) },
    '@/app/lib/license/managed-team-invitation-policy': { requireManagedTeamInvitationPolicy: async () => policyReady ? null : NextResponse.json({}, { status: 409 }) },
    '@/app/lib/organization/permissions': {
      readOrganizationPermissionForUser: async () => ({ configured: true, organizationId: 'session-org', permission: {} }),
      isOrganizationAdminLike: () => activeAdministrator,
    },
    '@/app/lib/security/mutation-origin': { requireTrustedMutationOrigin: () => trusted
      ? { ok: true } : { ok: false, response: NextResponse.json({}, { status: 403 }) } },
    '@/app/lib/utils/rate-limit': { rateLimit: () => limited
      ? { ok: false, response: NextResponse.json({}, { status: 429 }) } : { ok: true } },
    '@/app/lib/organization/features': { areExternalUsersEnabled: () => true },
    '@/app/lib/organization/team-invitations': {
      TeamInvitationError, expireTeamMembershipInvitations: async () => undefined,
      listTeamMembershipInvitations: async () => [invitation],
      createTeamMembershipInvitation: async () => { creates += 1; return { invitation, token: 'synthetic-link-token' }; },
    },
    '@/app/lib/organization/team-invitation-email': {
      TeamInvitationEmailError,
      listTeamInvitationEmailDeliveries: async () => ({ [invitation.id]: emailDelivery }),
      sendCreatedTeamInvitationEmail: async () => emailDelivery,
      resendTeamInvitationEmail: async (input: Record<string, unknown>) => {
        captured = input;
        if (failures.current) throw failures.current;
        sends += 1;
        return { invitation, token: replayed ? null : 'synthetic-link-token', emailDelivery, replayed };
      },
    },
  };
  const route = loadIsolatedModule<typeof import('../app/api/admin/organization/memberships/invitations/[invitationId]/resend/route')>(
    'app/api/admin/organization/memberships/invitations/[invitationId]/resend/route.ts', mocks);
  const createRoute = loadIsolatedModule<typeof import('../app/api/admin/organization/memberships/invitations/route')>(
    'app/api/admin/organization/memberships/invitations/route.ts', mocks);
  const request = (body: unknown = { requestId: randomUUID() }) => new NextRequest('http://127.0.0.1:3100/api/admin/organization/memberships/invitations/test-invitation/resend', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3100' }, body: JSON.stringify(body),
  });
  const context = { params: Promise.resolve({ invitationId: invitation.id }) };
  trusted = false; assert.equal((await route.POST(request(), context)).status, 403); trusted = true;
  authenticated = false; assert.equal((await route.POST(request(), context)).status, 401); authenticated = true;
  activeAdministrator = false; assert.equal((await route.POST(request(), context)).status, 403); activeAdministrator = true;
  runtimeReady = false; assert.equal((await route.POST(request(), context)).status, 403); runtimeReady = true;
  policyReady = false; assert.equal((await route.POST(request(), context)).status, 409); policyReady = true;
  limited = true; assert.equal((await route.POST(request(), context)).status, 429); limited = false;
  assert.equal((await route.POST(request({}), context)).status, 400);
  assert.equal((await route.POST(request({ requestId: randomUUID(), oversized: 'x'.repeat(17 * 1024) }), context)).status, 413);
  assert.equal(sends, 0, 'Every rejected guard must prevent access to the resend service.');
  const requestId = randomUUID();
  const response = await route.POST(request({ requestId, confirmDeliveryUnknown: true, locale: 'de',
    organizationId: 'untrusted-org', actorUserId: 'untrusted-user', email: 'untrusted@example.test' }), context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(captured?.organizationId, 'session-org');
  assert.equal(captured?.actorUserId, 'session-admin');
  assert.equal(captured?.invitationId, invitation.id);
  assert.equal(captured?.confirmDeliveryUnknown, true);
  assert.equal(captured?.locale, 'de');
  assert.ok(!('email' in captured!), 'Resend cannot replace the stored invitation recipient.');
  replayed = true;
  const replayResponse = await route.POST(request({ requestId }), context);
  const replay = await replayResponse.json();
  assert.equal(replay.data.token, null);
  assert.equal(replay.data.acceptancePath, null);
  assert.equal(replay.data.replayed, true);
  failures.current = new TeamInvitationEmailError('INVITATION_EMAIL_COOLDOWN', 'Wait before resending this invitation.', 409, 42);
  const cooldown = await route.POST(request(), context);
  assert.equal(cooldown.status, 409);
  assert.equal(cooldown.headers.get('Retry-After'), '42');
  console.log('Invitation email routes: CSRF/admin/organization/license/policy/rate/body guards, recipient scope, replay and cooldown passed.');

  const create = await createRoute.POST(request({ name: 'Invitee', email: invitation.email, role: 'member', locale: 'de' }));
  assert.equal(create.status, 201, 'Unavailable email must preserve successful invitation creation.');
  assert.equal(create.headers.get('Cache-Control'), 'private, no-store');
  const created = await create.json();
  assert.equal(created.data.emailDelivery.status, 'unconfigured');
  assert.ok(created.data.acceptancePath.startsWith('/invite/team?token='), 'Manual link must remain available.');
  assert.equal(creates, 1);
  const listed = await createRoute.GET(new NextRequest('http://127.0.0.1:3100/api/admin/organization/memberships/invitations'));
  assert.equal(listed.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await listed.json()).data.invitations[0].emailDelivery.errorCode, 'INVITATION_EMAIL_DISABLED');
  console.log('Invitation email routes: disabled-email Create201/manual fallback and reloaded List status use private,no-store.');
}

void main().catch(() => { console.error('Invitation email route regression failed.'); process.exitCode = 1; });
