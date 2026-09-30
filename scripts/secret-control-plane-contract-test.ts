import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type CapturedRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
};

const fixtureKeys = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'KIE_API_KEY',
  'CANVAS_DATA_ROOT', 'DATA', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH',
  'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY', 'CANVAS_SECRETS_ENV_PATH',
  'CANVAS_SECRETS_MASTER_KEY', 'CANVAS_CONTROL_PLANE_URL', 'NEXT_PUBLIC_CANVAS_CONTROL_PLANE_URL',
  'CANVAS_INSTANCE_TOKEN', 'CANVAS_MANAGED_SERVICES_ENABLED',
];

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-managed-secrets-contract-'));
  const previousEnv = new Map(fixtureKeys.map((key) => [key, process.env[key]]));
  const captured: CapturedRequest[] = [];
  const providerRequests: Array<{ url: string; authorization: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  let expectedKieAuthorization = 'Bearer fixture-user-kie-byok';
  let nextJob = 0;
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = request.url || '/';
    captured.push({
      method: request.method || 'GET',
      url,
      authorization: request.headers.authorization,
      body,
    });

    if (request.method === 'POST' && url === '/v1/managed/media-generations') {
      nextJob += 1;
      sendJson(response, 201, { jobId: `fixture-job-${nextJob}`, status: 'queued' });
      return;
    }
    if (request.method === 'GET' && /^\/v1\/managed\/media-generations\/fixture-job-\d+$/.test(url)) {
      sendJson(response, 200, {
        job: {
          id: url.split('/').at(-1),
          status: 'succeeded',
          outputs: [{ id: 'fixture-output', fileName: 'result.bin', mimeType: 'application/octet-stream', downloadUrl: '/fixture-output' }],
        },
      });
      return;
    }
    if (request.method === 'GET' && url === '/fixture-output') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.from('fixture-result'));
      return;
    }
    if (request.method === 'POST' && /^\/v1\/managed\/media-generations\/fixture-job-\d+\/ack$/.test(url)) {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: 'unexpected fake Control Plane request' });
  });

  try {
    for (const key of fixtureKeys) delete process.env[key];
    process.env.CANVAS_DATA_ROOT = dataRoot;
    process.env.CANVAS_CONTROL_PLANE_URL = await new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Fake Control Plane did not bind TCP'));
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    process.env.CANVAS_INSTANCE_TOKEN = 'fixture-control-plane-instance-token';
    process.env.GEMINI_API_KEY = 'fixture-process-gemini-byok';
    process.env.OPENAI_API_KEY = 'fixture-process-openai-byok';
    process.env.KIE_API_KEY = 'fixture-process-kie-byok';

    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const { resolveStudioProviderCredential } = await import('../app/lib/integrations/studio-provider-credentials');
    const { generateManagedMedia, isManagedMediaFallbackAvailable } = await import('../app/lib/integrations/managed-media-client');
    const { generateSeedanceVideo } = await import('../app/lib/integrations/seedance-generation-service');

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith('https://api.kie.ai/') || url.startsWith('https://kieai.redpandaai.co/')) {
        const pathname = new URL(url).pathname;
        const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
        providerRequests.push({ url, authorization });
        assert.equal(authorization, expectedKieAuthorization, 'the scoped provider key reaches only the provider boundary');
        if (pathname === '/api/v1/jobs/createTask') {
          return Response.json({ code: 200, msg: 'success', data: { taskId: 'fixture-byok-task' } });
        }
        if (pathname === '/api/v1/jobs/recordInfo') {
          return Response.json({
            code: 200,
            msg: 'success',
            data: {
              taskId: 'fixture-byok-task',
              state: 'success',
              resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie.ai/generated/fixture-byok.mp4'] }),
            },
          });
        }
        throw new Error(`Unexpected fake KIE provider request: ${pathname}`);
      }
      if (url === 'https://cdn.kie.ai/generated/fixture-byok.mp4') {
        providerRequests.push({ url, authorization: undefined });
        return new Response(Buffer.from('fixture-byok-video'), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    await replaceScopedEnvEntries('integrations', [
      { key: 'GEMINI_API_KEY', value: 'fixture-system-gemini' },
      { key: 'OPENAI_API_KEY', value: 'fixture-system-openai' },
    ]);
    await replaceScopedEnvEntries('integrations', [
      { key: 'GEMINI_API_KEY', value: 'fixture-user-gemini' },
      { key: 'KIE_API_KEY', value: 'fixture-user-kie-byok' },
    ], { secretScope: 'user', userId: 'alice' });
    await replaceScopedEnvEntries('integrations', [
      { key: 'OPENAI_API_KEY', value: 'fixture-org-openai' },
      { key: 'KIE_API_KEY', value: 'fixture-org-kie-byok' },
    ], { secretScope: 'organization', organizationId: 'org-a' });

    assert.equal(await resolveStudioProviderCredential('gemini', { userId: 'alice' }), 'fixture-user-gemini', 'user credential wins over system and process');
    assert.equal(await resolveStudioProviderCredential('gemini', { userId: 'bob' }), 'fixture-system-gemini', 'user without an override falls back to system before process');
    assert.equal(await resolveStudioProviderCredential('openai', { organizationId: 'org-a' }), 'fixture-org-openai', 'organization credential wins over system and process');
    assert.equal(await resolveStudioProviderCredential('openai', { organizationId: 'org-b' }), 'fixture-system-openai', 'organization without an override falls back to system before process');
    assert.equal(await resolveStudioProviderCredential('kie', { userId: 'bob' }), 'fixture-process-kie-byok', 'process env remains a fallback after scoped and system stores');

    const requestCountBeforeByok = captured.length;
    const userByokResult = await generateSeedanceVideo({
      prompt: 'Scoped user BYOK generation',
      storageScope: { userId: 'alice' },
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    assert.equal(userByokResult.metadata.managedFallback, undefined, 'user BYOK follows the real provider branch');
    assert.equal(providerRequests.filter((item) => item.url.includes('/api/v1/jobs/')).length, 2);
    assert.equal(captured.length, requestCountBeforeByok, 'actual generation service does not call the Control Plane when scoped BYOK exists');

    const orgByokCallsBefore = providerRequests.length;
    expectedKieAuthorization = 'Bearer fixture-org-kie-byok';
    await generateSeedanceVideo({
      prompt: 'Scoped organization BYOK generation',
      storageScope: { organizationId: 'org-a' },
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    assert.equal(providerRequests.length - orgByokCallsBefore, 3, 'organization BYOK follows the actual provider upload/create/poll path');
    assert(providerRequests.slice(orgByokCallsBefore).filter((item) => item.url.includes('/api/v1/jobs/')).length === 2);
    assert.equal(captured.length, requestCountBeforeByok, 'organization BYOK also suppresses managed transport');

    await replaceScopedEnvEntries('integrations', []);
    await replaceScopedEnvEntries('integrations', [], { secretScope: 'organization', organizationId: 'org-a' });
    delete process.env.KIE_API_KEY;
    assert.equal(await resolveStudioProviderCredential('kie', { organizationId: 'org-a' }), null, 'no provider key remains unresolved for managed fallback');
    assert.equal(isManagedMediaFallbackAvailable(), true);

    const resultBytes: string[] = [];
    for (const capability of ['image', 'sound'] as const) {
      const result = await generateManagedMedia({
        capability,
        provider: 'gemini',
        model: `fixture-${capability}-model`,
        prompt: 'fixture prompt with no credentials',
        parameters: { storageScope: { organizationId: 'org-a' } },
      });
      assert.equal(result.outputs.length, 1);
      resultBytes.push(result.outputs[0].bytes.toString('utf8'));
    }
    const managedVideo = await generateSeedanceVideo({
      prompt: 'Organization managed fallback generation',
      storageScope: { organizationId: 'org-a' },
    });
    assert.equal(managedVideo.metadata.managedFallback, true, 'missing organization key follows the real managed Seedance branch');
    assert.equal(managedVideo.metadata.controlPlaneJobId, 'fixture-job-3');
    resultBytes.push('fixture-result');
    assert.deepEqual(resultBytes, ['fixture-result', 'fixture-result', 'fixture-result']);

    const creationRequests = captured.filter((item) => item.method === 'POST' && item.url === '/v1/managed/media-generations');
    assert.equal(creationRequests.length, 3, 'image, video, and sound each use the real managed-media transport');
    for (const request of captured) {
      assert.equal(request.authorization, 'Bearer fixture-control-plane-instance-token', 'all Control Plane requests use the instance identity token');
      assert.equal(request.body.includes('fixture-user-gemini'), false);
      assert.equal(request.body.includes('fixture-user-kie-byok'), false);
      assert.equal(request.body.includes('fixture-system-gemini'), false);
      assert.equal(request.body.includes('fixture-org-openai'), false);
      assert.equal(request.body.includes('fixture-org-kie-byok'), false);
      assert.equal(request.body.includes('fixture-process-kie-byok'), false);
    }
    assert.deepEqual(creationRequests.map((request) => JSON.parse(request.body).capability), ['image', 'sound', 'video']);
    assert.equal(captured.filter((item) => item.url === '/fixture-output').length, 3, 'outputs are fetched through the authenticated Control Plane transport');
    assert.equal(captured.filter((item) => item.url.endsWith('/ack')).length, 3);

    const requestCountBeforeByokDecision = captured.length;

    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';
    assert.equal(isManagedMediaFallbackAvailable(), false);
    await assert.rejects(
      generateSeedanceVideo({ prompt: 'Organization fallback disabled', storageScope: { organizationId: 'org-a' } }),
      /KIE API key is missing/,
      'the actual generation service fails clearly when both scoped key and managed fallback are unavailable',
    );
    assert.equal(captured.length, requestCountBeforeByokDecision, 'unavailable fallback does not issue requests');

    console.log('secret-control-plane-contract-test: scope cascade and authenticated managed media transport passed');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'secret-control-plane-contract-test failed');
  process.exitCode = 1;
});
