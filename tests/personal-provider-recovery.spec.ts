import { test, expect, type Page } from '@playwright/test';
import { authenticateManagedTestPage } from './helpers/managed-test-context';
import { MAIN_AGENT_ID } from '@/app/lib/agents/main-agent';
import type { AiEffectiveRuntimeResolution } from '@/app/lib/agent-runtime-policy/types';

const managedId = `aip_${'c'.repeat(24)}`;
const personalId = `aip_${'a'.repeat(24)}`;
const personalName = 'OpenAI Codex (ChatGPT Login)';

async function fixture(page: Page, consentInitially = true, providerId = 'openai-codex', connectedInitially = true) {
  const displayName = providerId === 'openai' ? 'OpenAI (ChatGPT Login)' : personalName;
  let connected = connectedInitially;
  let status: 'ready' | 'degraded' = 'degraded';
  let consent = consentInitially;
  let failureCode: string | null = 'MODEL_TEST_FAILED';
  let verificationRequests = 0;
  let oauthInitiations = 0;
  let nextFailure: string | null = null;
  let hold: Promise<void> | null = null;
  let workspaceId = 'fixture-workspace';
  const selection = { providerInstallationId: managedId, providerId: 'canvas-control-plane', modelId: 'managed-model', thinkingLevel: 'medium' as const };
  const resolution = (): AiEffectiveRuntimeResolution => ({
    context: { organizationId: 'fixture-org', userId: 'fixture-user', workspaceId, workspaceType: 'team', agentId: MAIN_AGENT_ID,
      executionMode: 'interactive', principal: { type: 'user', userId: 'fixture-user', credentialSubjectUserId: 'fixture-user' } },
    catalogRevision: 7, policyRevision: 1,
    providers: [
      { installationId: managedId, providerId: 'canvas-control-plane', name: 'Canvas Control Plane', source: 'managed', credentialScope: 'managed', credentialAvailable: true, selectable: true, status: 'ready',
        models: [{ id: 'managed-model', name: 'Managed model', enabled: true, isProviderDefault: true, reasoning: true, supportsVision: false, thinkingLevels: ['medium'], metadata: {}, revision: 1 }] },
      { installationId: personalId, providerId, name: displayName, source: 'built-in', credentialScope: 'user', authMethod: 'oauth', credentialAvailable: connected && consent, selectable: connected && consent && status === 'ready', status,
        userCredentialEligibility: { state: !connected ? 'not_connected' : consent ? 'ready' : 'consent_required', connected, consentGranted: consent, grantRevision: consent ? 8 : null,
          verification: { status, verifiedAt: '2026-10-01T00:00:00Z', checkedAt: '2026-10-01T00:00:00Z', failureCode } },
        models: [{ id: 'gpt-6-sol', name: 'GPT-6 Sol', enabled: true, isProviderDefault: true, reasoning: true, supportsVision: true, thinkingLevels: ['medium', 'high'], metadata: {}, revision: 1 }] },
    ],
    inheritedSelection: { selection, catalogRevision: 7, policyRevision: 1, selectionSource: 'app_default', credentialScope: 'managed' },
    effectiveSelection: { selection, catalogRevision: 7, policyRevision: 1, selectionSource: 'app_default', credentialScope: 'managed' },
    preference: null, source: 'app_default', valid: true, issues: [],
  });
  await page.route('**/api/agent-runtime/effective**', async route => {
    workspaceId = new URL(route.request().url()).searchParams.get('workspaceId') || workspaceId;
    await route.fulfill({ json: { success: true, data: resolution(), resolution: resolution() } });
  });
  await page.route(/\/api\/agents(\?.*)?$/, route => route.fulfill({ json: { success: true, data: { agents: [{ agentId: MAIN_AGENT_ID, name: 'Canvas Agent', type: 'main', iconId: 'bot', removable: false }] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, route => route.fulfill({ json: { success: true, sessions: [] } }));
  await page.route('**/api/user-preferences', route => route.fulfill({ json: { success: true, data: { lastActiveAgentId: MAIN_AGENT_ID } } }));
  await page.route('**/api/oauth/pi/status**', route => route.fulfill({ json: { success: true, provider: { provider: providerId, displayName, connected } } }));
  await page.route('**/api/oauth/pi/initiate', async route => {
    oauthInitiations++;
    expect(route.request().postDataJSON()).toEqual({ provider: 'openai' });
    await route.fulfill({ json: { success: true, flowId: 'fixture-login', authUrl: 'https://auth.openai.com/fixture', instructions: 'Paste the full final callback URL.' } });
  });
  await page.route('**/api/oauth/pi/poll**', route => route.fulfill({ json: { success: true, status: 'waiting_for_code', authUrl: 'https://auth.openai.com/fixture' } }));
  await page.route('**/api/oauth/pi/exchange', async route => {
    expect(route.request().postDataJSON()).toEqual({ flowId: 'fixture-login', provider: 'openai', code: 'http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture-state&client_id=fixture-client' });
    connected = true;
    await route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/agent-runtime/user-credential-grants**', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      expect(body.allowedExecutionModes).toEqual(['interactive']);
      expect(body.expectedRevision).toBe(7);
      consent = true;
    }
    await route.fulfill({ json: { success: true, data: { grant: { revision: consent ? 8 : 7, status: consent ? 'active' : 'revoked' } } } });
  });
  await page.route('**/api/agent-runtime/personal-provider-verify', async route => {
    verificationRequests++;
    expect(route.request().postDataJSON()).toEqual({ workspaceId, agentId: MAIN_AGENT_ID, providerInstallationId: personalId, modelId: 'gpt-6-sol' });
    if (hold) await hold;
    failureCode = nextFailure;
    status = nextFailure ? 'degraded' : 'ready';
    await route.fulfill({ status: nextFailure ? 502 : 200,
      json: { success: !nextFailure, code: nextFailure || 'PROVIDER_VERIFIED', data: { result: { success: !nextFailure, status }, resolution: resolution() } } }).catch(() => {});
  });
  await authenticateManagedTestPage(page);
  await page.goto('/notebook?chat=open', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-provider-selector')).toBeEnabled({ timeout: 45_000 });
  return {
    requests: () => verificationRequests, logins: () => oauthInitiations,
    failNext: (code: string | null) => { nextFailure = code; },
    holdNext: (promise: Promise<void> | null) => { hold = promise; },
  };
}

async function openPersonal(page: Page, mobile: boolean, name = personalName) {
  await page.getByTestId('chat-provider-selector').click();
  await page.getByRole(mobile ? 'button' : 'menuitem', { name: new RegExp(name.replace(/[()]/g, '\\$&')) }).click();
  await expect(page.getByTestId('chat-personal-provider-dialog')).toBeVisible();
  await expect(page.getByTestId('chat-personal-provider-dialog')).toHaveCSS('opacity', '1');
  if (mobile) await expect(page.getByRole('dialog', { name: 'Provider', exact: true })).toHaveCount(0);
}

for (const mobile of [false, true]) {
  test(`personal provider recovers without reconnecting on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const state = await fixture(page);
    await openPersonal(page, mobile);
    await expect(page.getByText('Account connected', { exact: true })).toBeVisible();
    await expect(page.getByText('Connected and ready', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('chat-personal-provider-verify')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('personal-provider-degraded.png') });
    state.failNext('PROVIDER_RATE_LIMITED');
    await page.getByTestId('chat-personal-provider-verify').click();
    await expect(page.getByTestId('chat-personal-provider-verification')).toContainText('usage or rate limit');
    await expect(page.getByTestId('chat-provider-selector')).toContainText('Canvas Control Plane');
    state.failNext(null);
    await page.getByTestId('chat-personal-provider-verify').click();
    await expect(page.getByTestId('chat-personal-provider-dialog')).toHaveCount(0);
    await expect(page.getByTestId('chat-provider-selector')).toContainText(personalName);
    await expect(page.getByTestId('chat-model-selector')).toHaveAttribute('title', /GPT-6 Sol/);
    expect(state.requests()).toBe(2); expect(state.logins()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('personal-provider-recovered.png') });
  });
}

test('personal approval automatically checks the connected account', async ({ page }) => {
  test.setTimeout(90_000);
  const state = await fixture(page, false);
  await openPersonal(page, false);
  await expect(page.getByTestId('chat-personal-provider-verify')).toBeDisabled();
  await page.getByTestId('chat-personal-provider-grant').click();
  await expect(page.getByTestId('chat-provider-selector')).toContainText(personalName);
  expect(state.requests()).toBe(1); expect(state.logins()).toBe(0);
});

test('closing a pending personal check cannot switch providers later', async ({ page }) => {
  test.setTimeout(90_000);
  const state = await fixture(page);
  const release = Promise.withResolvers<void>();
  state.holdNext(release.promise);
  try {
    await openPersonal(page, false);
    await page.getByTestId('chat-personal-provider-verify').click();
    await expect(page.getByTestId('chat-personal-provider-verify')).toBeDisabled();
    await expect.poll(state.requests).toBe(1);
    await page.getByTestId('chat-personal-provider-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    release.resolve();
    await expect(page.getByTestId('chat-personal-provider-dialog')).toHaveCount(0);
    await expect(page.getByTestId('chat-provider-selector')).toContainText('Canvas Control Plane');
  } finally { release.resolve(); }
});

test('new ChatGPT login preserves the full callback and checks the model after connecting', async ({ page }) => {
  test.setTimeout(90_000);
  const name = 'OpenAI (ChatGPT Login)';
  const state = await fixture(page, true, 'openai', false);
  await openPersonal(page, false, name);
  await expect(page.getByTestId('chat-personal-provider-verify')).toBeDisabled();
  await page.getByTestId('pi-oauth-connect-button').click();
  await expect(page.getByTestId('pi-oauth-code-input')).toBeVisible();
  await page.getByTestId('pi-oauth-code-input').fill('http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture-state&client_id=fixture-client');
  await page.getByTestId('pi-oauth-complete-button').click();
  await expect(page.getByTestId('chat-personal-provider-dialog')).toHaveCount(0);
  await expect(page.getByTestId('chat-provider-selector')).toContainText(name);
  expect(state.logins()).toBe(1); expect(state.requests()).toBe(1);
});

test('new ChatGPT account can recover without another login on mobile', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const name = 'OpenAI (ChatGPT Login)';
  const state = await fixture(page, true, 'openai');
  await openPersonal(page, true, name);
  await page.getByTestId('chat-personal-provider-verify').click();
  await expect(page.getByTestId('chat-provider-selector')).toContainText(name);
  expect(state.logins()).toBe(0); expect(state.requests()).toBe(1);
});
