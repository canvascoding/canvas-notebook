import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { hashPassword } from 'better-auth/crypto';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-auth-seat-limit-'));
process.env.DATA = dataDir;
process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
process.env.BASE_URL = 'http://localhost:3000';
process.env.CANVAS_INSTANCE_ID = 'auth-seat-limit-test';

async function signIn(auth: {
  handler: (request: Request) => Promise<Response>;
}, email: string, password: string) {
  return auth.handler(new Request('http://localhost:3000/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
    },
    body: JSON.stringify({
      email,
      password,
    }),
  }));
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const owner = await createInitialOwner({
    name: 'Solo Owner',
    email: 'owner@example.test',
    password: 'OwnerPassword123!',
  });

  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  const memberPassword = 'MemberPassword123!';
  const memberPasswordHash = await hashPassword(memberPassword);
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO "user" (
      id, name, email, email_verified, role, banned, created_at, updated_at
    ) VALUES ('member-user', 'Member User', 'member@example.test', 1, 'user', 0, ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO account (
      id, account_id, provider_id, user_id, issuer, password, created_at, updated_at
    ) VALUES (
      'member-account',
      'member-user',
      'credential',
      'member-user',
      'local:credential',
      ?,
      ?,
      ?
    )
  `).run(memberPasswordHash, now, now);
  sqlite.close();

  const { auth } = await import('../app/lib/auth');
  const ownerResponse = await signIn(
    auth,
    owner.email,
    'OwnerPassword123!',
  );
  assert.equal(ownerResponse.status, 200);
  assert.match(ownerResponse.headers.get('set-cookie') || '', /session_token/u);

  const memberResponse = await signIn(
    auth,
    'member@example.test',
    memberPassword,
  );
  assert.equal(memberResponse.status, 403);
  const memberPayload = await memberResponse.json() as {
    code?: string;
    message?: string;
  };
  assert.equal(memberPayload.code, 'SEAT_LIMIT_EXCEEDED');
  assert.match(memberPayload.message || '', /exactly one active user/u);

  const verification = new Database(path.join(dataDir, 'sqlite.db'));
  assert.equal(
    verification.prepare(`
      SELECT COUNT(*)
      FROM session
      WHERE user_id = 'member-user'
    `).pluck().get(),
    0,
    'a rejected sign-in must not leave a reusable web or Expo session',
  );
  verification.prepare(`
    UPDATE canvas_organization_settings
    SET owner_user_id = 'member-user', updated_at = ?
  `).run(now + 1);
  const temporaryMemberResponse = await signIn(
    auth,
    'member@example.test',
    memberPassword,
  );
  assert.equal(temporaryMemberResponse.status, 200);
  const temporaryMemberCookie = (temporaryMemberResponse.headers.get('set-cookie') || '')
    .split(';', 1)[0];
  assert.match(temporaryMemberCookie, /session_token/u);
  verification.prepare(`
    UPDATE canvas_organization_settings
    SET owner_user_id = ?, updated_at = ?
  `).run(owner.id, now + 2);
  const restoredMember = await auth.api.getSession({
    headers: new Headers({
      cookie: temporaryMemberCookie,
    }),
  });
  assert.equal(
    restoredMember,
    null,
    'web and Expo session restore must enforce the same Solo Seat boundary',
  );
  assert.equal(
    verification.prepare(`
      SELECT COUNT(*)
      FROM session
      WHERE user_id = 'member-user'
    `).pluck().get(),
    0,
  );
  assert.equal(
    verification.prepare(`
      SELECT COUNT(*)
      FROM session
      WHERE user_id = ?
    `).pluck().get(owner.id),
    1,
  );
  verification.close();

  console.log('auth seat limit tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
