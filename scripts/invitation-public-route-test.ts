import assert from 'node:assert/strict';
import test from 'node:test';

import { NextRequest } from 'next/server';

import middleware from '../proxy';

const publicInvitationRoutes = [
  '/api/organization/invitations/accept',
  '/api/organization/invitations/activate',
  '/api/organization/invitations/preview',
] as const;

const invitationToken = 'A'.repeat(43);

test('allows token-authenticated invitation routes without a session cookie', async () => {
  for (const path of publicInvitationRoutes) {
    const response = await middleware(new NextRequest(`http://localhost:3000${path}`, {
      method: 'POST',
    }));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('x-middleware-next'), '1', path);
  }
});

test('allows localized invitation pages without a session cookie', async () => {
  for (const path of [
    `/invite/team?token=${invitationToken}`,
    `/en/invite/team?token=${invitationToken}`,
  ]) {
    const response = await middleware(new NextRequest(`http://localhost:3000${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('location'), null, path);

    const rewrite = response.headers.get('x-middleware-rewrite');
    if (rewrite) {
      assert.equal(new URL(rewrite).searchParams.get('token'), invitationToken, path);
    }
  }
});

test('keeps neighboring organization routes behind session authentication', async () => {
  for (const path of [
    '/api/organization/invitations/preview/extra',
    '/api/organization/private',
  ]) {
    const response = await middleware(new NextRequest(`http://localhost:3000${path}`, {
      method: 'POST',
    }));
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'Unauthorized',
    });
  }
});

test('keeps neighboring invitation pages behind session authentication', async () => {
  const path = `/invite/team/private?token=${invitationToken}`;
  const response = await middleware(new NextRequest(`http://localhost:3000${path}`));
  assert.equal(response.status, 307);

  const location = response.headers.get('location');
  assert.ok(location);
  const loginUrl = new URL(location);
  assert.equal(loginUrl.pathname, '/login');
  assert.equal(loginUrl.searchParams.get('from'), path);
});
