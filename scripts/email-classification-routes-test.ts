import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, type EmailClassificationConfiguration } from '../app/lib/email/classification/settings-types';

type Session = { user: { id: string; role: string; email: string; organizationRole?: string } } | null;
type Failure = 'conflict' | 'missing_credential' | 'unavailable' | 'provider_failure' | null;
type Load = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: Load };
const originalLoad = internals._load;
let session: Session = { user: { id: 'verified-admin', role: 'admin', email: 'admin@example.test' } };
let failure: Failure = null;
let limited = false;
const calls = { read: 0, update: [] as Array<{ actorUserId: string; expectedRevision: number; configuration: EmailClassificationConfiguration }>, test: [] as Array<{ configuration?: EmailClassificationConfiguration; signal?: AbortSignal }>, availability: 0 };
const rateCalls: Array<{ verifiedUserId?: string; keyPrefix?: string }> = [];
const audits: Array<Record<string, unknown>> = [];
const configuration = structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION);
const adminData = {
  settings: { revision: 7, configuration, updatedAt: 1, updatedByUserId: 'verified-admin' },
  availability: { enabled: false, available: false, revision: 7, defaultMode: 'classic', reason: 'disabled' },
  credentials: { status: 'missing', configured: false, scope: 'system', settingsLink: '/settings?tab=secrets', anonymous: false },
  health: { state: 'idle' }, providerOptions: [],
};
let availability = { ...adminData.availability, endpoint: 'https://internal.example.test', credentialKey: 'EXAMPLE_PRIVATE_KEY', statistics: { mailCount: 10 }, rawError: 'Sensitive provider detail' };

class MockAdminError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly settingsLink?: string) { super(message); }
}

function failIfRequested() {
  if (failure === 'conflict') throw new MockAdminError('EMAIL_CLASSIFICATION_VERSION_CONFLICT', 409, 'Settings changed. Reload before saving.');
  if (failure === 'missing_credential') throw new MockAdminError('CLASSIFICATION_CREDENTIAL_MISSING', 409, 'Configure the system credential before enabling classification.', '/settings?tab=secrets');
  if (failure === 'unavailable') throw new MockAdminError('CLASSIFICATION_CONFIGURATION_UNAVAILABLE', 503, 'Email classification configuration is unavailable.', '/settings?tab=secrets');
  if (failure === 'provider_failure') throw new Error('Upstream raw error contains EXAMPLE_PRIVATE_KEY and https://internal.example.test');
}

function matches(request: string, suffix: string) {
  return request === `@/app/lib/${suffix}` || request.endsWith(`/app/lib/${suffix}`) || request.endsWith(`/app/lib/${suffix}.ts`);
}

internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (matches(request, 'auth')) return { auth: { api: { getSession: async () => session } } };
  if (matches(request, 'bootstrap-admin')) return { isBootstrapAdminEmail: (email: string) => email === 'bootstrap@example.test' };
  if (matches(request, 'security/trusted-origins') || request === './trusted-origins' && parent?.filename.includes('/app/lib/security/')) return { isConfiguredTrustedOrigin: (origin: string) => origin === 'https://canvas.test' };
  if (matches(request, 'utils/rate-limit')) return { rateLimit: (_request: NextRequest, options: { verifiedUserId?: string; keyPrefix?: string }) => {
    rateCalls.push(options);
    return limited ? { ok: false, response: NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } }) } : { ok: true };
  } };
  if (matches(request, 'audit/audit-service')) return { recordAuditEvent: async (event: Record<string, unknown>) => { audits.push(event); return null; } };
  if (matches(request, 'email/classification/admin-service')) return {
    readAdminEmailClassificationSettings: async () => { calls.read++; failIfRequested(); return adminData; },
    updateAdminEmailClassificationSettings: async (input: { actorUserId: string; expectedRevision: number; configuration: EmailClassificationConfiguration }) => {
      calls.update.push(input); failIfRequested();
      return { ...adminData, settings: { ...adminData.settings, revision: input.expectedRevision + 1, configuration: input.configuration, updatedByUserId: input.actorUserId }, changedFields: ['enabled', 'endpoint', 'credentialKey'] };
    },
    testEmailClassificationProvider: async (input: { configuration?: EmailClassificationConfiguration; signal?: AbortSignal }) => {
      calls.test.push(input); failIfRequested();
      return { success: true, providerId: 'typesafe', model: configuration.model, latencyMs: 1, calibrationVerified: false };
    },
    readEmailClassificationAvailability: async () => { calls.availability++; failIfRequested(); return availability; },
    emailClassificationAdminErrorDetails: (error: unknown) => error instanceof MockAdminError
      ? { code: error.code, status: error.status, message: error.message, settingsLink: error.settingsLink }
      : { code: 'CLASSIFICATION_PROVIDER_UNAVAILABLE', status: 503, message: 'The classification provider is unavailable.' },
  };
  return originalLoad(request, parent, isMain);
};

function request(path: string, method = 'GET', payload?: unknown, extraHeaders: Record<string, string> = {}) {
  return new NextRequest(`https://canvas.test${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { Origin: 'https://canvas.test', 'Sec-Fetch-Site': 'same-origin' }), ...extraHeaders },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

function privateResponse(response: Response, status: number) {
  assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
}

async function main() {
  try {
    const settingsRoute = await import('../app/api/admin/email-classification/settings/route');
    const testRoute = await import('../app/api/admin/email-classification/test/route');
    const availabilityRoute = await import('../app/api/email/classification/availability/route');
    const settingsPath = '/api/admin/email-classification/settings';
    const testPath = '/api/admin/email-classification/test';
    const availabilityPath = '/api/email/classification/availability';
    const patch = () => request(settingsPath, 'PATCH', { expectedRevision: 7, configuration });

    session = null;
    privateResponse(await settingsRoute.GET(request(settingsPath)), 401);
    privateResponse(await settingsRoute.PATCH(patch()), 401);
    privateResponse(await testRoute.POST(request(testPath, 'POST', {})), 401);
    privateResponse(await availabilityRoute.GET(request(availabilityPath)), 401);
    assert.equal(calls.read + calls.update.length + calls.test.length + calls.availability, 0, 'Unauthenticated requests never reach configuration or providers');

    session = { user: { id: 'org-owner', role: 'member', email: 'owner@example.test', organizationRole: 'owner' } };
    privateResponse(await settingsRoute.GET(request(settingsPath)), 403);
    privateResponse(await settingsRoute.PATCH(patch()), 403);
    privateResponse(await testRoute.POST(request(testPath, 'POST', {})), 403);
    assert.equal(calls.read + calls.update.length + calls.test.length, 0, 'Organization owner is not an instance administrator');
    const memberAvailability = await availabilityRoute.GET(request(availabilityPath)); privateResponse(memberAvailability, 200);
    const publicData = (await memberAvailability.json()).data;
    assert.deepEqual(Object.keys(publicData).sort(), ['available', 'defaultMode', 'enabled', 'reason', 'revision']);
    assert.equal(JSON.stringify(publicData).includes('EXAMPLE_PRIVATE_KEY'), false);
    assert.equal(JSON.stringify(publicData).includes('internal.example.test'), false);
    assert.equal(publicData.reason, 'disabled');
    assert.equal(rateCalls.at(-1)?.verifiedUserId, 'org-owner');

    session = { user: { id: 'bootstrap-admin', role: 'member', email: 'bootstrap@example.test' } };
    privateResponse(await settingsRoute.GET(request(settingsPath)), 200);
    session = { user: { id: 'verified-admin', role: 'admin', email: 'admin@example.test' } };
    const adminGet = await settingsRoute.GET(request(settingsPath)); privateResponse(adminGet, 200);
    assert.equal((await adminGet.json()).data.settings.revision, 7);
    assert.equal(rateCalls.at(-1)?.verifiedUserId, 'verified-admin');

    const beforeCsrf = calls.update.length + calls.test.length;
    const rejectedOrigins: Array<Record<string, string>> = [
      { Origin: 'https://evil.example.test' },
      { Origin: '' },
      { Origin: 'https://canvas.test', 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'https://evil.example.test', Host: 'evil.example.test', 'X-Forwarded-Host': 'evil.example.test' },
    ];
    for (const headers of rejectedOrigins) {
      privateResponse(await settingsRoute.PATCH(request(settingsPath, 'PATCH', { expectedRevision: 7, configuration }, headers)), 403);
      privateResponse(await testRoute.POST(request(testPath, 'POST', {}, headers)), 403);
    }
    assert.equal(calls.update.length + calls.test.length, beforeCsrf, 'Missing or cross-site origins cannot mutate or incur provider calls');

    limited = true;
    privateResponse(await settingsRoute.GET(request(settingsPath)), 429);
    privateResponse(await settingsRoute.PATCH(patch()), 429);
    const limitedTest = await testRoute.POST(request(testPath, 'POST', {})); privateResponse(limitedTest, 429);
    assert.equal(limitedTest.headers.get('Retry-After'), '60');
    privateResponse(await availabilityRoute.GET(request(availabilityPath)), 429);
    limited = false;
    assert.ok(rateCalls.every(call => call.verifiedUserId && call.keyPrefix), 'Every rate budget uses verified session identity');

    const beforeInvalid = calls.update.length;
    for (const invalid of [null, [], {}, { configuration }, { expectedRevision: '7', configuration }, { expectedRevision: -1, configuration }, { expectedRevision: 7.5, configuration },
      { expectedRevision: 7, configuration, actorUserId: 'spoofed-admin' }, { expectedRevision: 7, configuration: { ...configuration, apiKey: 'forbidden-inline-key' } },
      { expectedRevision: 7, configuration: { ...configuration, timeoutMs: 0 } }, { expectedRevision: 7, configuration: { ...configuration, questionProfile: { ...configuration.questionProfile, categoryCriteria: { injected: 'execute' } } } }]) {
      privateResponse(await settingsRoute.PATCH(request(settingsPath, 'PATCH', invalid)), 400);
    }
    const malformed = new NextRequest(`https://canvas.test${settingsPath}`, { method: 'PATCH', headers: { Origin: 'https://canvas.test' }, body: '{broken' });
    privateResponse(await settingsRoute.PATCH(malformed), 400);
    assert.equal(calls.update.length, beforeInvalid, 'Invalid envelopes/configurations are rejected before persistence');

    const saved = await settingsRoute.PATCH(request(settingsPath, 'PATCH', { expectedRevision: 7, configuration: { ...configuration, enabled: true } }, { 'X-User-ID': 'spoofed-admin' }));
    privateResponse(saved, 200);
    assert.equal((await saved.json()).data.settings.revision, 8);
    assert.equal(calls.update.at(-1)?.actorUserId, 'verified-admin');
    assert.equal(calls.update.at(-1)?.expectedRevision, 7);
    assert.equal(audits.at(-1)?.userId, 'verified-admin');
    assert.deepEqual(audits.at(-1)?.metadata, { previousRevision: 7, revision: 8, changedFields: ['enabled', 'endpoint', 'credentialKey'] });
    const auditText = JSON.stringify(audits);
    assert.equal(auditText.includes('TYPESAFE_API_KEY'), false); assert.equal(auditText.includes('example.test'), false, 'Audit includes no recipient or endpoint values');

    for (const [mode, status, code] of [
      ['conflict', 409, 'EMAIL_CLASSIFICATION_VERSION_CONFLICT'], ['missing_credential', 409, 'CLASSIFICATION_CREDENTIAL_MISSING'], ['unavailable', 503, 'CLASSIFICATION_CONFIGURATION_UNAVAILABLE'],
    ] as const) {
      failure = mode;
      const failed = await settingsRoute.PATCH(patch()); privateResponse(failed, status);
      const body = await failed.json(); assert.equal(body.code, code);
      if (mode === 'missing_credential') assert.equal(body.settingsLink, '/settings?tab=secrets');
    }
    failure = null;

    const beforeInvalidTest = calls.test.length;
    for (const invalid of [null, [], { state: { email: { body: 'Private message' } } }, { email: 'Private message' }, { apiKey: 'forbidden-inline-key' }, { questions: {} },
      { configuration: null }, { configuration: { ...configuration, credentialValue: 'forbidden-inline-key' } }, { configuration: { ...configuration, endpoint: 'https://user:password@example.test' } }]) {
      privateResponse(await testRoute.POST(request(testPath, 'POST', invalid)), 400);
    }
    assert.equal(calls.test.length, beforeInvalidTest, 'Tests accept neither private email inputs nor credential values');
    const disabledTest = await testRoute.POST(request(testPath, 'POST', {})); privateResponse(disabledTest, 200);
    assert.equal(configuration.enabled, false);
    assert.equal(calls.test.at(-1)?.configuration, undefined, 'Explicit synthetic connection test uses saved disabled configuration without enabling it');
    assert.ok(calls.test.at(-1)?.signal instanceof AbortSignal);
    assert.deepEqual(audits.at(-1)?.metadata, { synthetic: true });
    const unsaved = { ...configuration, model: 'jev-1.13.1' };
    const unsavedTest = await testRoute.POST(request(testPath, 'POST', { configuration: unsaved })); privateResponse(unsavedTest, 200);
    assert.equal(calls.test.at(-1)?.configuration?.model, 'jev-1.13.1');
    assert.equal(configuration.model, 'jev-1.13.0', 'Provider test never persists an unsaved configuration');

    failure = 'missing_credential';
    const missingTest = await testRoute.POST(request(testPath, 'POST', {})); privateResponse(missingTest, 409);
    assert.equal((await missingTest.json()).settingsLink, '/settings?tab=secrets');
    assert.equal((audits.at(-1)?.metadata as { code: string }).code, 'CLASSIFICATION_CREDENTIAL_MISSING');
    failure = 'provider_failure';
    const providerFailure = await testRoute.POST(request(testPath, 'POST', {})); privateResponse(providerFailure, 503);
    assert.equal(JSON.stringify(await providerFailure.json()).includes('EXAMPLE_PRIVATE_KEY'), false, 'Raw provider error is never returned');
    assert.equal(JSON.stringify(audits).includes('EXAMPLE_PRIVATE_KEY'), false);
    const availabilityFailure = await availabilityRoute.GET(request(availabilityPath)); privateResponse(availabilityFailure, 503);
    assert.deepEqual(await availabilityFailure.json(), { success: false, code: 'CLASSIFICATION_STATUS_UNAVAILABLE', error: 'Email classification status is unavailable.' });
    failure = null;
    availability = { ...availability, enabled: true, available: true, defaultMode: 'focus', reason: 'budget_exhausted' };
    const exhausted = await availabilityRoute.GET(request(availabilityPath)); privateResponse(exhausted, 200);
    assert.deepEqual((await exhausted.json()).data, { enabled: true, available: true, revision: 7, defaultMode: 'focus', reason: 'budget_exhausted' }, 'Budget exhaustion keeps already prepared focus results available');
    console.log('email-classification-routes-test: ok');
  } finally { internals._load = originalLoad; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
