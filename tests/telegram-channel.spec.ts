import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function login(page: import('@playwright/test').Page) {
  const response = await page.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
    headers: { Origin: BASE_URL, 'Content-Type': 'application/json' },
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  return response;
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
    expect(body).toHaveProperty('telegram');
    expect(body.telegram).toHaveProperty('configured');
    expect(body.telegram).toHaveProperty('enabled');
    expect(body.telegram).toHaveProperty('linked');
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

  test('sessions POST with channelId creates telegram session', async ({ page }) => {
    await login(page);
    const response = await page.request.post(`${BASE_URL}/api/sessions`, {
      headers: { Origin: BASE_URL, 'Content-Type': 'application/json' },
      data: {
        channelId: 'telegram',
        channelSessionKey: 'telegram:123456789',
      },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.session).toHaveProperty('sessionId');
    expect(body.session.channelId).toBe('telegram');
    expect(body.session.channelSessionKey).toBe('telegram:123456789');
  });

  test('sessions GET with channelId filter returns only telegram sessions', async ({ page }) => {
    await login(page);
    const response = await page.request.get(`${BASE_URL}/api/sessions?channelId=telegram`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
    for (const session of body.sessions) {
      if (session.engine === 'pi') {
        expect(session.channelId).toBe('telegram');
      }
    }
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