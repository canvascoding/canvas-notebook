import assert from 'node:assert/strict';

import {
  createTeamMembershipCandidate,
  getActiveTeamMembershipProjection,
  getTeamMembershipById,
  TeamMembershipError,
  transitionTeamMembership,
} from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

process.env.CANVAS_DEPLOYMENT_MODE = 'community';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const organizationId = 'membership-model';

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    await seedTeamSeatOrganization(database, organizationId, now);
    const candidate = await createTeamMembershipCandidate(database, {
      organizationId,
      email: ' New.Member@Example.Test ',
      displayName: 'New Member',
      role: 'member',
      status: 'invited',
      source: 'invitation',
      now,
    });
    assert.equal(candidate.candidateEmail, 'new.member@example.test');
    assert.equal(candidate.userId, null);
    assert.equal((await getActiveTeamMembershipProjection(database, organizationId)).observedQuantity, 0);

    await assert.rejects(transitionTeamMembership(database, {
      organizationId, membershipId: candidate.id, expectedStatus: 'invited',
      toStatus: 'active', source: 'invitation', acceptedAt: now,
    }), (error: unknown) => error instanceof TeamMembershipError && error.code === 'ACTIVE_IDENTITY_REQUIRED');

    const approved = await transitionTeamMembership(database, {
      organizationId, membershipId: candidate.id, expectedStatus: 'invited',
      toStatus: 'approval_required', source: 'invitation', acceptedAt: now + 1,
    });
    assert.equal(approved.status, 'approval_required');
    assert.equal(approved.userId, null);
    const billing = await transitionTeamMembership(database, {
      organizationId, membershipId: candidate.id, expectedStatus: 'approval_required',
      toStatus: 'billing_pending', source: 'control_plane', now: now + 2,
    });
    assert.equal(billing.status, 'billing_pending');
    assert.equal((await getActiveTeamMembershipProjection(database, organizationId)).observedQuantity, 0);

    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'Wrong Email', 'wrong@example.test', 1, 'user', $2, $2)
    `, ['wrong-user', now]);
    await assert.rejects(transitionTeamMembership(database, {
      organizationId, membershipId: candidate.id, expectedStatus: 'billing_pending',
      toStatus: 'active', source: 'control_plane', userId: 'wrong-user', now: now + 3,
    }), (error: unknown) => error instanceof TeamMembershipError && error.code === 'ACTIVE_IDENTITY_MISMATCH');

    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'New Member', 'new.member@example.test', 1, 'user', $2, $2)
    `, ['member-user', now]);
    const active = await transitionTeamMembership(database, {
      organizationId, membershipId: candidate.id, expectedStatus: 'billing_pending',
      toStatus: 'active', source: 'control_plane', userId: 'member-user', now: now + 4,
    });
    assert.equal(active.status, 'active');
    assert.equal(active.userId, 'member-user');
    assert.equal((await getActiveTeamMembershipProjection(database, organizationId)).observedQuantity, 1);
    await assert.rejects(transitionTeamMembership(database, {
      organizationId, membershipId: candidate.id, expectedStatus: 'billing_pending',
      toStatus: 'active', source: 'control_plane', userId: 'member-user', now: now + 5,
    }), (error: unknown) => error instanceof TeamMembershipError && error.code === 'MEMBERSHIP_CONFLICT');
    const persisted = await getTeamMembershipById(database, organizationId, candidate.id);
    assert.equal(persisted?.status, 'active');
  });
  console.info('team membership state machine and active-seat projection passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
