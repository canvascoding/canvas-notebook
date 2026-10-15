// Real preview handler and mobile response mapping with controlled auth,
// workspace/rate checks and generation transport. No provider/network calls.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import { StudioServiceError } from '../app/lib/integrations/studio-errors';
import {
  classifyStudioGenerationFailure,
  StudioGenerationFailureError,
} from '../app/lib/integrations/studio-generation-failures';

async function main() {
  let authenticated = true;
  let permitted = true;
  let limited = false;
  let scopeChecks = 0;
  let generationCalls = 0;
  let generationError: unknown;
  const session = { user: { id: 'studio-route-user' } };
  const scope = { actorUserId: session.user.id, organizationId: 'studio-route-organization', workspaceId: 'studio-route-workspace' };
  const requestBody = { sourcePath: 'studio/route-source.png', frame: { x: -32, y: -32, width: 1088, height: 1088 },
    mode: 'ai_extend', aspectRatio: '1:1', targetWidth: 1024, targetHeight: 1024, provider: 'openai', model: 'gpt-image-2.5-sunburst' };
  const preview = { path: 'studio/edits/route-preview.png', name: 'route-preview.png', mediaUrl: '/api/studio/media/studio/edits/route-preview.png',
    previewUrl: '/api/preview/studio/edits/route-preview.png', mode: 'ai_extend', width: 1024, height: 1024, mimeType: 'image/png' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Route failure tests must not make network requests.'); };
  class FixtureMobileStudioError extends Error {
    constructor(message: string, public readonly status: number, public readonly code: string) { super(message); }
  }

  mock.module('@/app/lib/auth', { exports: { auth: { api: { getSession: async () => authenticated ? session : null } } } });
  mock.module('@/app/lib/integrations/studio-request-scope', { exports: {
    requireStudioRequestScope: async (_request: NextRequest, receivedSession: typeof session, options: { permissions: string }) => {
      scopeChecks += 1;
      assert.equal(receivedSession, session);
      assert.equal(options.permissions, 'canWrite');
      return permitted ? { scope } : { scope: null, response: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) };
    },
  } });
  mock.module('@/app/lib/utils/rate-limit', { exports: {
    rateLimit: () => limited
      ? { ok: false, response: NextResponse.json({ success: false, error: 'Rate limited' }, { status: 429 }) }
      : { ok: true },
  } });
  mock.module('@/app/lib/integrations/studio-aspect-ratio-service', { exports: {
    createAspectRatioPreview: async (body: unknown, receivedScope: typeof scope, credentials: { userId: string }) => {
      generationCalls += 1;
      assert.deepEqual(body, requestBody);
      assert.equal(receivedScope, scope);
      assert.deepEqual(credentials, { userId: session.user.id });
      if (generationError !== undefined) throw generationError;
      return preview;
    },
  } });
  mock.module('../app/lib/mobile/studio.ts', { exports: { MobileStudioError: FixtureMobileStudioError } });
  mock.module('@/app/lib/api/route-helpers', { exports: {
    jsonServerError: () => assert.fail('Structured generation failures must not fall through to a generic mobile server error.'),
  } });
  try {
    const { POST } = await import('../app/api/studio/aspect-ratio/preview/route');
    const { mobileStudioErrorResponse, mobileStudioResponseHeaders } = await import('../app/lib/mobile/studio-route');
    const request = (body = JSON.stringify(requestBody)) => new NextRequest('https://studio-route.fixture.invalid/api/studio/aspect-ratio/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const assertMobileHeaders = (response: Response) => {
      for (const [name, value] of Object.entries(mobileStudioResponseHeaders)) assert.equal(response.headers.get(name), value);
    };

    authenticated = false;
    const unauthenticated = await POST(request('invalid-json'));
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { success: false, error: 'Unauthorized' });
    assert.equal(scopeChecks, 0);
    assert.equal(generationCalls, 0);

    authenticated = true;
    permitted = false;
    const forbidden = await POST(request('invalid-json'));
    assert.equal(forbidden.status, 403);
    assert.equal(generationCalls, 0, 'Application permissions must block generation before provider processing.');
    permitted = true;
    limited = true;
    assert.equal((await POST(request())).status, 429);
    assert.equal(generationCalls, 0);
    limited = false;
    assert.equal((await POST(request('invalid-json'))).status, 400);
    assert.equal(generationCalls, 0);

    const successful = await POST(request());
    assert.equal(successful.status, 201);
    assert.deepEqual(await successful.json(), { success: true, preview });
    assert.equal(generationCalls, 1);

    const providerFailure = (message: string, properties: Record<string, unknown> = {}) => new StudioGenerationFailureError(
      classifyStudioGenerationFailure(Object.assign(new Error(message), properties)),
    );
    const cases = [
      { error: providerFailure('401 rejected API key sk-routeSecret1234567890', { status: 401 }), status: 502, code: 'PROVIDER_AUTH_ERROR' },
      { error: providerFailure('403 provider account blocked', { status: 403 }), status: 502, code: 'PROVIDER_AUTH_ERROR' },
      { error: providerFailure('400 unsupported input_fidelity', { status: 400 }), status: 400, code: 'INVALID_PROVIDER_REQUEST' },
      { error: providerFailure('429 provider quota reached', { status: 429 }), status: 429, code: 'PROVIDER_RATE_LIMIT' },
      { error: providerFailure('408 provider timeout', { status: 408 }), status: 504, code: 'PROVIDER_TIMEOUT' },
      { error: providerFailure('503 upstream unavailable', { status: 503 }), status: 502, code: 'PROVIDER_UNAVAILABLE' },
      { error: providerFailure('The input is unsafe', { status: 400, code: 'moderation_blocked' }), status: 400, code: 'PROVIDER_MODERATION_BLOCKED' },
      { error: providerFailure('Reference image 1 must use PNG, JPEG or WebP.'), status: 400, code: 'INVALID_IMAGE_OPTIONS' },
      { error: providerFailure('No final image was returned by OpenAI'), status: 502, code: 'PROVIDER_EMPTY_RESULT' },
      { error: providerFailure('Unexpected upstream rejection'), status: 502, code: 'GENERATION_FAILED' },
    ];
    for (const item of cases) {
      generationError = item.error;
      const response = await POST(request());
      assert.equal(response.status, item.status);
      const expected = { success: false, error: item.error.userMessage, code: item.code, retryable: item.error.failure.retryable };
      const payload = await response.json();
      assert.deepEqual(payload, expected);
      assert.equal(Object.hasOwn(payload, 'details'), false);
      assert.equal(Object.hasOwn(payload, 'requestId'), false);
      assert.equal(JSON.stringify(payload).includes('sk-routeSecret1234567890'), false);
      if (item.code === 'PROVIDER_AUTH_ERROR') {
        assert.notEqual(response.status, 401, 'Provider authorization is independent of the application login session.');
        assert.notEqual(response.status, 403, 'Provider authorization is independent of application workspace permissions.');
        assert.match(payload.error, /\/settings\?tab=secrets/u);
        assert.equal(payload.error.includes(item.error.failure.details), false);
      }
      const mobile = mobileStudioErrorResponse(item.error, '[fixture] Mobile Studio failure');
      assert.equal(mobile.status, item.status);
      assertMobileHeaders(mobile);
      assert.deepEqual(await mobile.json(), expected, 'Web/mobile must expose the same machine code and safe message.');
    }

    const mobileUnauthorized = mobileStudioErrorResponse(new FixtureMobileStudioError('Unauthorized', 401, 'UNAUTHORIZED'), '[fixture]');
    assert.equal(mobileUnauthorized.status, 401);
    assertMobileHeaders(mobileUnauthorized);
    assert.deepEqual(await mobileUnauthorized.json(), { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    const mobileForbidden = mobileStudioErrorResponse(new StudioServiceError('Permission denied', 'Forbidden', 'FORBIDDEN'), '[fixture]');
    assert.equal(mobileForbidden.status, 403);
    assertMobileHeaders(mobileForbidden);
    assert.deepEqual(await mobileForbidden.json(), { success: false, error: 'Forbidden', code: 'FORBIDDEN' });
    generationError = undefined;
    assert.equal((await POST(request())).status, 201, 'A preceding provider auth failure must not replace application authentication.');
    console.log('studio-openai-errors-route-test: Web/mobile provider failures preserve app auth status, safe responses and headers');
  } finally {
    globalThis.fetch = originalFetch;
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
