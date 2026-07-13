import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

type RouteSession = {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
  session: {
    id: string;
  };
};

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/account/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-account-credentials-route-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  await fs.mkdir(dataRoot, { recursive: true });
  const { runMigrations } = await import('../app/lib/db/migrate');
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));

  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
      VALUES (?, ?, ?, 1, NULL, 'user', ?, ?)
    `).run('account-user', 'Account User', 'current@example.test', now, now);
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
      VALUES (?, ?, ?, 1, NULL, 'user', ?, ?)
    `).run('taken-user', 'Taken User', 'taken@example.test', now, now);
    sqlite.prepare(`
      INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('current-session', now + 60_000, randomUUID(), now, now, 'account-user');
    sqlite.prepare(`
      INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('other-session', now + 60_000, randomUUID(), now, now, 'account-user');
  } finally {
    sqlite.close();
  }

  const { auth } = await import('../app/lib/auth');
  let currentSession: RouteSession | null = {
    user: {
      id: 'account-user',
      email: 'current@example.test',
      name: 'Account User',
      role: 'user',
    },
    session: { id: 'current-session' },
  };
  const originalGetSession = auth.api.getSession;
  const originalVerifyPassword = auth.api.verifyPassword;
  const didPatchSession = Reflect.set(auth.api, 'getSession', async () => currentSession);
  const didPatchPassword = Reflect.set(auth.api, 'verifyPassword', async ({ body }: { body: { password: string } }) => {
    if (body.password !== 'CurrentPassword123!') {
      throw new Error('INVALID_PASSWORD');
    }
    return { status: true };
  });
  assert.equal(didPatchSession, true);
  assert.equal(didPatchPassword, true);

  try {
    const route = await import('../app/api/account/email/route');

    currentSession = null;
    const unauthorized = await route.POST(request({
      newEmail: 'new@example.test',
      currentPassword: 'CurrentPassword123!',
    }));
    assert.equal(unauthorized.status, 401);

    currentSession = {
      user: {
        id: 'account-user',
        email: 'current@example.test',
        name: 'Account User',
        role: 'user',
      },
      session: { id: 'current-session' },
    };
    const invalidPassword = await route.POST(request({
      newEmail: 'new@example.test',
      currentPassword: 'wrong-password',
    }));
    assert.equal(invalidPassword.status, 400);
    assert.equal((await responseJson(invalidPassword)).success, false);

    const takenEmail = await route.POST(request({
      newEmail: 'taken@example.test',
      currentPassword: 'CurrentPassword123!',
    }));
    assert.equal(takenEmail.status, 409);

    const updated = await route.POST(request({
      newEmail: 'New.Email@example.test',
      currentPassword: 'CurrentPassword123!',
    }));
    assert.equal(updated.status, 200);
    assert.equal((await responseJson(updated)).success, true);

    const verificationDb = new Database(path.join(dataRoot, 'sqlite.db'));
    try {
      const updatedUser = verificationDb.prepare('SELECT email FROM user WHERE id = ?').get('account-user') as { email: string };
      assert.equal(updatedUser.email, 'new.email@example.test');
      const remainingSessions = verificationDb.prepare('SELECT COUNT(*) AS count FROM session WHERE user_id = ?').get('account-user') as { count: number };
      assert.equal(remainingSessions.count, 0);
      const audit = verificationDb.prepare(`
        SELECT action, metadata_json AS metadataJson
        FROM audit_events
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get('account-user') as { action: string; metadataJson: string | null };
      assert.equal(audit.action, 'account.email_updated');
      assert.equal(audit.metadataJson?.includes('password'), false);
    } finally {
      verificationDb.close();
    }
  } finally {
    Reflect.set(auth.api, 'getSession', originalGetSession);
    Reflect.set(auth.api, 'verifyPassword', originalVerifyPassword);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('account credentials route test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
