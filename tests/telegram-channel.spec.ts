import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function login(page: import('@playwright/test').Page) {
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
}

type CanonicalSession = {
  id: number;
  sessionId: string;
  title: string;
  agentId: string;
  engine: string;
  createdAt: string;
  userId?: string;
  channelId?: string;
  workspace: { workspaceId: string; organizationId: string };
  creator: { email: string };
};

type OwnedChannelFixture = {
  ownerUserId?: string;
  workspaceId?: string;
  cleanupApi?: APIRequestContext;
  sessions: Array<{
    channelId: 'telegram' | 'web';
    channelSessionKey: string;
    clientRequestId: string;
    title: string;
    created: boolean;
    receipt: CanonicalSession;
  }>;
};

async function createOwnedChannelSessions(page: Page, fixture: OwnedChannelFixture): Promise<CanonicalSession[]> {
  await login(page);
  fixture.cleanupApi = await request.newContext({
    baseURL: BASE_URL, storageState: await page.context().storageState(), timeout: 5_000,
  });
  const identityResponse = await fixture.cleanupApi.get('/api/auth/get-session');
  expect(identityResponse.status()).toBe(200);
  const identity = await identityResponse.json() as { user: { id: string; email: string } };
  expect(identity.user.email).toBe(TEST_EMAIL);
  expect(identity.user.id).toEqual(expect.any(String));
  expect(identity.user.id.length).toBeGreaterThan(0);
  fixture.ownerUserId = identity.user.id;

  const workspaceResponse = await page.request.get(`${BASE_URL}/api/workspaces`, { timeout: 5_000 });
  expect(workspaceResponse.status()).toBe(200);
  const workspaces = await workspaceResponse.json() as { success: boolean; workspaces: Array<{
    id: string; type: string; ownerUserId: string; permissions: { canRead: boolean; canRunAgent: boolean };
  }> };
  expect(workspaces.success).toBe(true);
  const workspace = workspaces.workspaces.find(candidate => candidate.type === 'personal'
    && candidate.ownerUserId === fixture.ownerUserId && candidate.permissions.canRead && candidate.permissions.canRunAgent);
  expect(workspace, 'The authenticated owner needs an accessible personal workspace.').toBeTruthy();
  fixture.workspaceId = workspace!.id;

  for (const channelId of ['telegram', 'web'] as const) {
    const uuid = randomUUID();
    const title = `QA ${channelId} channel ${uuid}`;
    const channelSessionKey = `${channelId}:qa-${uuid}`;
    const clientRequestId = `channel-${channelId}-${uuid}`;
    const response = await page.request.post(`${BASE_URL}/api/sessions`, {
      headers: { Origin: BASE_URL }, timeout: 5_000,
      data: { title, channelId, channelSessionKey, clientRequestId, workspaceId: fixture.workspaceId },
    });
    const body = await response.json() as { success: boolean; created: boolean; session?: CanonicalSession };
    // Register the exact response ID before any assertion so a failing receipt still has guarded cleanup.
    if (typeof body.session?.sessionId === 'string' && body.session.sessionId) {
      fixture.sessions.push({ channelId, channelSessionKey, clientRequestId, title, created: body.created === true, receipt: body.session });
    }
    expect(response.status()).toBe(200);
    expect(body.success).toBe(true);
    expect(body.created).toBe(true);
    expect(body.session).toMatchObject({ title, engine: 'pi', workspace: { workspaceId: fixture.workspaceId }, creator: { email: TEST_EMAIL } });
    expect(body.session).not.toHaveProperty('channelId');
    expect(body.session).not.toHaveProperty('channelSessionKey');
  }
  expect(fixture.sessions).toHaveLength(2);
  expect(new Set(fixture.sessions.map(owned => owned.receipt.sessionId)).size).toBe(2);
  const allResponse = await page.request.get(`${BASE_URL}/api/sessions`, {
    params: { workspaceId: fixture.workspaceId! }, timeout: 5_000,
  });
  expect(allResponse.status()).toBe(200);
  const all = await allResponse.json() as { success: boolean; sessions: CanonicalSession[] };
  expect(all.success).toBe(true);
  expect(Array.isArray(all.sessions)).toBe(true);
  for (const owned of fixture.sessions) {
    expect(all.sessions.find(session => session.sessionId === owned.receipt.sessionId)).toMatchObject({
      id: owned.receipt.id, title: owned.title, userId: fixture.ownerUserId, engine: 'pi', channelId: 'web',
      workspace: { workspaceId: fixture.workspaceId }, creator: { email: TEST_EMAIL },
    });
  }
  return all.sessions;
}

async function cleanupOwnedChannelSessions(fixture: OwnedChannelFixture): Promise<void> {
  if (!fixture.cleanupApi) return;
  const api = fixture.cleanupApi;
  const errors: unknown[] = [];
  const deadline = Date.now() + 25_000;
  const timeout = () => Math.max(1, Math.min(5_000, deadline - Date.now()));
  try {
    const identityResponse = await api.get('/api/auth/get-session', { timeout: timeout() });
    expect(identityResponse.status()).toBe(200);
    const identity = await identityResponse.json() as { user: { id: string; email: string } };
    expect(identity.user.id).toBe(fixture.ownerUserId);
    expect(identity.user.email).toBe(TEST_EMAIL);
    for (const owned of fixture.sessions) {
      try {
        expect(Date.now()).toBeLessThan(deadline);
        expect(owned.created).toBe(true);
        const bootstrap = `/api/sessions/${encodeURIComponent(owned.receipt.sessionId)}/bootstrap`;
        const params = { workspaceId: fixture.workspaceId! };
        const before = await api.get(bootstrap, { params, timeout: timeout() });
        expect(before.status()).toBe(200);
        const proof = await before.json() as { success: boolean; session: CanonicalSession };
        expect(proof.success).toBe(true);
        expect(proof.session).toMatchObject({
          id: owned.receipt.id, sessionId: owned.receipt.sessionId, title: owned.title,
          agentId: owned.receipt.agentId, createdAt: owned.receipt.createdAt, engine: 'pi',
          workspace: { workspaceId: fixture.workspaceId, organizationId: owned.receipt.workspace.organizationId },
          creator: { email: TEST_EMAIL },
        });
        const deleted = await api.delete('/api/sessions', {
          headers: { Origin: BASE_URL },
          params: { sessionId: owned.receipt.sessionId, agentId: owned.receipt.agentId }, timeout: timeout(),
        });
        expect(deleted.status()).toBe(200);
        expect(await deleted.json()).toMatchObject({ success: true, deleted: owned.receipt.sessionId });
        const absent = await api.get(bootstrap, { params, timeout: timeout() });
        expect(absent.status()).toBe(404);
        expect(await absent.json()).toMatchObject({ success: false, error: 'Session not found' });
      } catch (error) { errors.push(error); }
    }
  } catch (error) { errors.push(error); }
  finally {
    try { await api.dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Exact owned channel-session cleanup failed.');
}

test.describe('Telegram Channel API', () => {
  test('channels/status returns 401 without auth', async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/channels/status`);
    expect(response.status()).toBe(401);
  });

  test('channels/status returns success with auth', async ({ page }) => {
    await login(page);
    const response = await page.request.get(`${BASE_URL}/api/channels/status`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body).toHaveProperty('channels');
    expect(body.channels).not.toContainEqual(expect.objectContaining({ id: 'telegram' }));
  });

  test('channels/link-token returns 401 without auth', async ({ page }) => {
    const response = await page.request.post(`${BASE_URL}/api/channels/link-token`, {
      headers: { Origin: BASE_URL },
    });
    expect(response.status()).toBe(401);
  });

  test('channels/link-token generates a token with auth', async ({ page }) => {
    await login(page);
    const response = await page.request.post(`${BASE_URL}/api/channels/link-token`, {
      headers: { Origin: BASE_URL },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body).toHaveProperty('token');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(10);
  });

  test('channels/link-token generates different tokens on successive calls', async ({ page }) => {
    await login(page);
    const res1 = await page.request.post(`${BASE_URL}/api/channels/link-token`, { headers: { Origin: BASE_URL } });
    const res2 = await page.request.post(`${BASE_URL}/api/channels/link-token`, { headers: { Origin: BASE_URL } });
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.token).not.toBe(body2.token);
  });

  test('channels/bind DELETE returns 401 without auth', async ({ page }) => {
    const response = await page.request.delete(`${BASE_URL}/api/channels/bind`, {
      headers: { Origin: BASE_URL },
    });
    expect(response.status()).toBe(401);
  });

  test('channels/bind DELETE returns 404 when no binding exists', async ({ page }) => {
    await login(page);
    const response = await page.request.delete(`${BASE_URL}/api/channels/bind`, {
      headers: { Origin: BASE_URL },
    });
    expect(response.status()).toBe(404);
  });

  test('channels/telegram/register-commands returns 401 without auth', async ({ page }) => {
    const response = await page.request.post(`${BASE_URL}/api/channels/telegram/register-commands`, {
      headers: { Origin: BASE_URL },
    });
    expect(response.status()).toBe(401);
  });

  test('sessions POST creates channel-neutral owned Telegram and Web sessions', async ({ page }) => {
    const fixture: OwnedChannelFixture = { sessions: [] };
    const errors: unknown[] = [];
    try {
      const sessions = await createOwnedChannelSessions(page, fixture);
      expect(sessions.map(session => session.sessionId)).toEqual(expect.arrayContaining(fixture.sessions.map(owned => owned.receipt.sessionId)));
    } catch (error) { errors.push(error); }
    finally {
      try { await cleanupOwnedChannelSessions(fixture); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Channel-neutral creation assertion or exact cleanup failed.');
  });

  test('sessions GET channel filters use actual owned links while metadata stays neutral', async ({ page }) => {
    const fixture: OwnedChannelFixture = { sessions: [] };
    const errors: unknown[] = [];
    try {
      await createOwnedChannelSessions(page, fixture);
      for (const channelId of ['telegram', 'web'] as const) {
        const response = await page.request.get(`${BASE_URL}/api/sessions`, {
          params: { channelId, workspaceId: fixture.workspaceId! }, timeout: 5_000,
        });
        expect(response.status()).toBe(200);
        const body = await response.json() as { success: boolean; sessions: CanonicalSession[] };
        expect(body.success).toBe(true);
        expect(Array.isArray(body.sessions)).toBe(true);
        const included = fixture.sessions.find(owned => owned.channelId === channelId)!;
        const excluded = fixture.sessions.find(owned => owned.channelId !== channelId)!;
        expect(body.sessions.find(session => session.sessionId === included.receipt.sessionId)).toMatchObject({
          id: included.receipt.id, title: included.title, userId: fixture.ownerUserId, engine: 'pi', channelId: 'web',
          workspace: { workspaceId: fixture.workspaceId }, creator: { email: TEST_EMAIL },
        });
        expect(body.sessions.map(session => session.sessionId)).not.toContain(excluded.receipt.sessionId);
      }
    } catch (error) { errors.push(error); }
    finally {
      try { await cleanupOwnedChannelSessions(fixture); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Actual channel-link filter assertion or exact cleanup failed.');
  });

  test('sessions GET without channelId returns all sessions', async ({ page }) => {
    await login(page);
    const response = await page.request.get(`${BASE_URL}/api/sessions`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
  });
});
