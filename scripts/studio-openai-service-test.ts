import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import sharp from 'sharp';
import { StudioServiceError } from '../app/lib/integrations/studio-errors';
import { StudioGenerationFailureError } from '../app/lib/integrations/studio-generation-failures';
import { NextRequest } from 'next/server';
import type { StudioScope } from '../app/lib/integrations/studio-scope';
import type { StudioGenerateRequest } from '../app/lib/integrations/studio-generation-service';

type Row = Record<string, unknown>;
type Column = { key: string };
type Condition = { kind: 'eq'; column: Column; value: unknown } | { kind: 'and' | 'or'; conditions: Condition[] };

async function main() {
  const tableNames = ['user', 'studioProducts', 'studioProductImages', 'studioPersonas', 'studioPersonaImages',
    'studioStyles', 'studioStyleImages', 'studioPresets', 'studioGenerations', 'studioGenerationOutputs',
    'studioGenerationProducts', 'studioGenerationPersonas', 'studioGenerationStyles'];
  const columns = ['id', 'userId', 'organizationId', 'customerId', 'projectId', 'createdByUserId', 'workspaceId',
    'mode', 'provider', 'model', 'aspectRatio', 'prompt', 'metadata', 'status', 'generationId', 'productId',
    'personaId', 'styleId', 'name', 'description', 'sortOrder', 'createdAt', 'idempotencyKey', 'isDefault'];
  const schema = Object.fromEntries(tableNames.map((name) => [name,
    Object.fromEntries(columns.map((key) => [key, { key } satisfies Column]))]));
  const records = new Map<unknown, Row[]>(Object.values(schema).map((table) => [table, []]));
  let persistenceCalls = 0;
  const matches = (row: Row, condition?: Condition): boolean => !condition || (condition.kind === 'eq'
    ? row[condition.column.key] === condition.value
    : condition.kind === 'and' ? condition.conditions.every((entry) => matches(row, entry))
      : condition.conditions.some((entry) => matches(row, entry)));
  const db = {
    select() {
      return { from(table: unknown) {
        let condition: Condition | undefined;
        let maximum: number | undefined;
        const query = {
          where(value: Condition) { condition = value; return query; },
          limit(value: number) { maximum = value; return query; },
          orderBy() { return query; },
          then(resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) {
            const rows = (records.get(table) || []).filter((row) => matches(row, condition));
            return Promise.resolve(maximum === undefined ? rows : rows.slice(0, maximum)).then(resolve, reject);
          },
        };
        return query;
      } };
    },
    insert(table: unknown) {
      return { async values(value: Row) {
        persistenceCalls += 1;
        records.get(table)!.push({ ...value });
      } };
    },
    update(table: unknown) {
      return { set(values: Row) { return { async where(condition: Condition) {
        persistenceCalls += 1;
        for (const row of records.get(table) || []) if (matches(row, condition)) Object.assign(row, values);
      } }; } };
    },
  };
  const scope: StudioScope = { actorUserId: 'fixture-user', organizationId: 'fixture-org', customerId: null,
    projectId: null, workspaceId: 'fixture-workspace', storage: { organizationId: 'fixture-org', workspaceId: 'fixture-workspace' } };
  const images = await Promise.all(Array.from({ length: 17 }, (_, index) => sharp({ create: {
    width: 32, height: 32, channels: 4, background: { r: index * 10, g: 32, b: 64, alpha: 1 },
  } }).png().toBuffer()));
  const files = new Map(images.map((bytes, index) => [`reference-${index}.png`, bytes]));
  const sdkCalls: Array<{ method: 'generate' | 'edit'; request: Row }> = [];
  const outputWrites: Array<{ path: string; bytes: Buffer }> = [];
  const successfulResponse = { data: [{ b64_json: images[0].toString('base64') }] };
  let caseCallCount = 0;
  let sdkOutcome: (ordinal: number) => unknown = () => successfulResponse;
  const sdkResponse = async (method: 'generate' | 'edit', request: Row) => {
    sdkCalls.push({ method, request });
    const outcome = sdkOutcome(caseCallCount++);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const unexpected = () => { throw new Error('An unrelated media service must not run in image regression tests.'); };
  const videoCalls: Row[] = [];
  const soundCalls: Row[] = [];
  class FakeOpenAI {
    images = {
      generate: (request: Row) => sdkResponse('generate', request),
      edit: (request: Row) => sdkResponse('edit', request),
    };
  }
  mock.module('openai', { exports: { default: FakeOpenAI } });
  mock.module(createRequire(import.meta.url).resolve('openai'), { exports: { default: FakeOpenAI } });
  mock.module('@/app/lib/db', { exports: { db } });
  mock.module('@/app/lib/db/schema', { exports: schema });
  const drizzleMocks = {
    eq: (column: Column, value: unknown): Condition => ({ kind: 'eq', column, value }),
    and: (...conditions: Condition[]): Condition => ({ kind: 'and', conditions }),
    or: (...conditions: Condition[]): Condition => ({ kind: 'or', conditions }),
    asc: () => ({}), desc: () => ({}), count: () => ({}), inArray: unexpected,
  };
  mock.module('drizzle-orm', { exports: drizzleMocks });
  mock.module(createRequire(import.meta.url).resolve('drizzle-orm'), { exports: drizzleMocks });
  mock.module('@/app/lib/integrations/studio-scope', { exports: {
    studioVisibilityCondition: () => ({ kind: 'eq', column: { key: 'workspaceId' }, value: scope.workspaceId }),
    createPersistedStudioScope: () => scope,
  } });
  mock.module('@/app/lib/integrations/studio-workspace', { exports: {
    readAssetFile: async (file: string) => { const bytes = files.get(file); assert.ok(bytes); return bytes; },
    ensureStudioOutputsWorkspace: async () => {},
    generateOutputFilename: (_slug: string, index: number, extension: string) => `output-${index}.${extension}`,
    generateOutputPath: (_storage: unknown, id: string, name: string) => `studio/fixture/${id}/${name}`,
    getStudioWorkspaceVirtualRoot: () => 'studio/fixture',
    writeOutputFile: async (file: string, bytes: Buffer) => { outputWrites.push({ path: file, bytes }); },
    readOutputFile: unexpected,
    STUDIO_SYSTEM_PRESETS_DIR: 'studio/presets',
  } });
  mock.module('@/app/lib/utils/media-url', { exports: { toMediaUrl: (file: string) => `/api/studio/media/${file}` } });
  mock.module('@/app/lib/integrations/media-reference-resolver', { exports: {
    classifyMediaReference: unexpected, loadMediaReference: unexpected,
    loadMediaReferences: async (paths: string[]) => paths.map((file) => {
      const bytes = files.get(file); assert.ok(bytes);
      return { imageBytes: bytes.toString('base64'), mimeType: 'image/png', width: 32, height: 32, fileName: file, sourceId: file };
    }),
  } });
  mock.module('@/app/lib/integrations/veo-generation-service', { exports: {
    generateVideo: async (request: Row) => {
      videoCalls.push(request);
      return { path: 'fixture/video.mp4', mediaUrl: '/api/studio/media/fixture/video.mp4', fileSize: 10, mimeType: 'video/mp4', metadata: {} };
    },
  } });
  mock.module('@/app/lib/integrations/seedance-generation-service', { exports: {
    generateSeedanceVideo: unexpected, SEEDANCE_MODEL_ID: 'bytedance/seedance-2', SEEDANCE_PROVIDER_ID: 'bytedance',
  } });
  mock.module('@/app/lib/integrations/sound-generation-service', { exports: {
    generateSound: async (request: Row) => {
      soundCalls.push(request);
      return { audioBytes: Buffer.from('fixture sound'), mimeType: 'audio/mpeg', metadata: {} };
    }, LYRIA_CLIP_MODEL_ID: 'lyria-3-clip-preview', LYRIA_PRO_MODEL_ID: 'lyria-3-pro-preview',
  } });
  mock.module('@/app/lib/integrations/studio-generation-concurrency', { exports: {
    withStudioGenerationConcurrency: async (_mode: string, run: () => Promise<unknown>) => run(),
  } });
  mock.module('@/app/lib/integrations/studio-provider-credentials', { exports: { resolveStudioProviderCredential: async () => 'fixture-key' } });
  mock.module('@/app/lib/integrations/managed-media-client', { exports: { isManagedMediaFallbackAvailable: () => false, generateManagedMedia: unexpected } });
  mock.module('@/app/lib/mobile/push-devices', { exports: { sendStudioCompletedPush: async () => {}, sendFailureAttentionPush: async () => {} } });
  mock.module('@/app/lib/auth', { exports: { auth: { api: { getSession: async () => ({ user: { id: scope.actorUserId } }) } } } });
  mock.module('@/app/lib/integrations/studio-request-scope', { exports: { requireStudioRequestScope: async () => ({ scope }) } });
  mock.module('@/app/lib/integrations/studio-generation-queue', { exports: {
    assertStudioGenerationQueueCapacity: async () => {},
    enqueueStudioGeneration: () => ({ queuePosition: 1, queueLength: 1 }),
  } });
  mock.module('@/app/lib/audit/audit-service', { exports: { recordAuditEvent: async () => {} } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Studio service regression tests must not perform network requests.'); };

  try {
    const { createStudioGeneration, executeStudioGeneration, runStudioGeneration } = await import('../app/lib/integrations/studio-generation-service');
    const request = (patch: Partial<StudioGenerateRequest> = {}): StudioGenerateRequest => ({
      mode: 'image', provider: 'openai', model: 'gpt-image-2.5-flare-2026-09-08', prompt: 'Create a poster.',
      aspect_ratio: '1:1', image_size: '1024x1024', count: 1, ...patch,
    });
    const generation = (id: string) => {
      const row = records.get(schema.studioGenerations)!.find((entry) => entry.id === id); assert.ok(row); return row;
    };

    const formattedPrompt = 'Überblick 🖼️\n\n\t- Licht: weich\n- Hintergrund: blau';
    const windowsPrompt = ` \t${formattedPrompt.replace(/\n/gu, '\r\n')}\r `;
    const queued = await createStudioGeneration(scope, request({ prompt: windowsPrompt }));
    assert.equal(queued.prompt, formattedPrompt);
    assert.equal(generation(queued.generationId).prompt, formattedPrompt);
    assert.equal(generation(queued.generationId).rawPrompt, formattedPrompt);
    await runStudioGeneration(queued.generationId);
    assert.equal(generation(queued.generationId).status, 'completed');
    assert.equal(sdkCalls.at(-1)!.request.prompt, formattedPrompt, 'The real OpenAI adapter must send paragraphs and tabs to the SDK');

    records.get(schema.studioPresets)!.push({
      id: 'prompt-preset', workspaceId: scope.workspaceId, name: 'Soft light',
      blocks: JSON.stringify([{ type: 'lighting', promptFragment: 'Soft\nwindow light' }]),
    });
    const withPreset = await executeStudioGeneration(scope, request({ prompt: windowsPrompt, preset_id: 'prompt-preset' }));
    const composedPrompt = `## Preset — Visual Setting\nSoft\nwindow light\n\n## Instructions\n\n${formattedPrompt}`;
    assert.equal(sdkCalls.at(-1)!.request.prompt, composedPrompt);
    assert.equal(generation(withPreset.generationId).prompt, composedPrompt);
    assert.equal(generation(withPreset.generationId).rawPrompt, formattedPrompt, 'User text stays separate from preset composition');

    for (const mode of ['video', 'sound'] as const) {
      const result = await executeStudioGeneration(scope, {
        mode, provider: mode === 'video' ? 'veo' : 'gemini', prompt: windowsPrompt, aspect_ratio: '16:9',
      });
      assert.equal(result.status, 'completed');
      assert.equal((mode === 'video' ? videoCalls : soundCalls).at(-1)!.prompt, formattedPrompt);
      assert.equal(generation(result.generationId).rawPrompt, formattedPrompt);
    }

    const beforePromptInvalid = persistenceCalls;
    for (const prompt of ['bad\u0000text', '\u000btext', 'text\u000c', 'p'.repeat(32_001)]) {
      await assert.rejects(createStudioGeneration(scope, request({ prompt })), (error: unknown) => (
        error instanceof StudioServiceError && error.code === 'INVALID_REQUEST'
      ));
    }
    assert.equal(persistenceCalls, beforePromptInvalid, 'Invalid prompts fail before creating a job');
    const geminiRequest = request({
      provider: 'gemini', model: 'gemini-3.1-flash-image', image_size: undefined, prompt: 'p'.repeat(4_000),
    });
    assert.equal((await createStudioGeneration(scope, geminiRequest)).prompt.length, 4_000);
    const beforeDefaultLimit = persistenceCalls;
    await assert.rejects(createStudioGeneration(scope, { ...geminiRequest, prompt: 'p'.repeat(4_001) }),
      (error: unknown) => error instanceof StudioServiceError && error.code === 'INVALID_REQUEST');
    await assert.rejects(createStudioGeneration(scope, {
      mode: 'sound', provider: 'gemini', prompt: ' \r\n\t ', extra_reference_urls: ['reference-0.png'],
    }),
      /Prompt required for sound generation/);
    assert.equal(persistenceCalls, beforeDefaultLimit);
    const referenceOnly = await executeStudioGeneration(scope, request({ prompt: ' \r\n\t ', extra_reference_urls: ['reference-0.png'] }));
    assert.equal(referenceOnly.status, 'completed');
    assert.equal(generation(referenceOnly.generationId).rawPrompt, '');

    const { POST } = await import('../app/api/studio/generate/route');
    const webRequest = (prompt: string) => new NextRequest('https://studio.fixture.invalid/api/studio/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request({ prompt })),
    });
    const webResponse = await POST(webRequest(windowsPrompt));
    assert.equal(webResponse.status, 201);
    const webQueued = await webResponse.json();
    assert.equal(webQueued.prompt, formattedPrompt);
    assert.equal(generation(webQueued.generationId).rawPrompt, formattedPrompt);
    await runStudioGeneration(webQueued.generationId);
    assert.equal(sdkCalls.at(-1)!.request.prompt, formattedPrompt);
    assert.equal((await POST(webRequest('bad\u0000text'))).status, 400);

    for (const model of ['gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08']) {
      const before = sdkCalls.length;
      const result = await executeStudioGeneration(scope, request({ model, extra_reference_urls: ['reference-0.png'], input_fidelity: 'high' }));
      assert.equal(result.status, 'completed');
      assert.equal(result.outputs.length, 1);
      assert.equal(generation(result.generationId).model, model, 'The selected snapshot remains persisted');
      assert.equal(sdkCalls.length, before + 1);
      assert.equal(sdkCalls.at(-1)!.method, 'edit');
      assert.equal(sdkCalls.at(-1)!.request.model, model, 'Studio must retain the selected model through execution');
      assert.equal(Object.hasOwn(sdkCalls.at(-1)!.request, 'input_fidelity'), false);
    }

    const normalized = await createStudioGeneration(scope, request({
      background: 'transparent', output_format: 'jpeg', output_compression: 80, input_fidelity: 'low',
    }));
    const effectiveMetadata = JSON.parse(String(generation(normalized.generationId).metadata));
    assert.equal(effectiveMetadata.outputFormat, 'png');
    assert.equal(Object.hasOwn(effectiveMetadata, 'outputCompression'), false);
    assert.equal(Object.hasOwn(effectiveMetadata, 'inputFidelity'), false);
    await runStudioGeneration(normalized.generationId);
    assert.equal(generation(normalized.generationId).status, 'completed');
    assert.equal(sdkCalls.at(-1)!.request.output_format, 'png');
    assert.equal(Object.hasOwn(sdkCalls.at(-1)!.request, 'output_compression'), false);

    const beforeInvalid = persistenceCalls;
    const callsBeforeInvalid = sdkCalls.length;
    await assert.rejects(createStudioGeneration(scope, request({ model: 'gpt-image-2.5-unknown' })), /Model must be one of/);
    assert.equal(persistenceCalls, beforeInvalid, 'Unknown models fail before persistence');
    assert.equal(sdkCalls.length, callsBeforeInvalid);

    const legacy = await createStudioGeneration(scope, request({ model: 'gpt-image-2' }));
    const legacyRow = generation(legacy.generationId);
    legacyRow.model = 'gpt-image-2';
    const historicalMetadata = JSON.stringify({ count: 1, inputFidelity: 'high', quality: 'high',
      outputFormat: 'png', outputCompression: 100, imageSize: '1024x1024', extraReferenceUrls: ['reference-0.png'] });
    legacyRow.metadata = historicalMetadata;
    await runStudioGeneration(legacy.generationId);
    assert.equal(legacyRow.status, 'completed');
    assert.equal(legacyRow.metadata, historicalMetadata, 'Replaying a saved job keeps historical settings immutable');
    assert.equal(sdkCalls.at(-1)!.request.model, 'gpt-image-2.5-sunburst');
    assert.equal(Object.hasOwn(sdkCalls.at(-1)!.request, 'input_fidelity'), false);
    assert.equal(Object.hasOwn(sdkCalls.at(-1)!.request, 'output_compression'), false);

    records.get(schema.studioProducts)!.push({ id: 'fixture-product', workspaceId: scope.workspaceId, name: 'Product' });
    records.get(schema.studioProductImages)!.push({ id: 'fixture-product-image', productId: 'fixture-product',
      filePath: 'reference-0.png', fileName: 'reference-0.png', mimeType: 'image/png', width: 32, height: 32 });
    const atLimit = await executeStudioGeneration(scope, request({ product_ids: ['fixture-product'],
      extra_reference_urls: Array.from({ length: 15 }, (_, index) => `reference-${index + 1}.png`) }));
    assert.equal(atLimit.status, 'completed', 'Sixteen combined references remain supported');
    const referenceFiles = sdkCalls.at(-1)!.request.image;
    assert.ok(Array.isArray(referenceFiles));
    assert.equal(referenceFiles.length, 16);
    const overLimit = await createStudioGeneration(scope, request({ product_ids: ['fixture-product'],
      extra_reference_urls: Array.from({ length: 16 }, (_, index) => `reference-${index + 1}.png`) }));
    const callsBeforeLimit = sdkCalls.length;
    const writesBeforeLimit = outputWrites.length;
    await runStudioGeneration(overLimit.generationId);
    assert.equal(generation(overLimit.generationId).status, 'failed');
    assert.match(JSON.parse(String(generation(overLimit.generationId).metadata)).error, /16/);
    assert.equal(sdkCalls.length, callsBeforeLimit, 'Combined references exceeding 16 fail before the provider');
    assert.equal(outputWrites.length, writesBeforeLimit);
    const storedOutputs = (id: unknown) => records.get(schema.studioGenerationOutputs)!.filter((row) => row.generationId === id);
    const fixtureSecret = 'sk-fixtureSecret123456789';
    const bearerSecret = 'fixtureAuthorization123456789';
    const failureCases = [
      { outcome: Object.assign(new Error(`400 unsupported input_fidelity ${fixtureSecret} Bearer ${bearerSecret}`),
        { status: 400, code: 'unsupported_parameter', param: 'input_fidelity', requestID: 'req-fixture-400' }),
        code: 'INVALID_PROVIDER_REQUEST', retryable: false, status: 400 },
      { outcome: Object.assign(new Error(`401 invalid API key ${fixtureSecret}`), { status: 401, code: 'invalid_api_key' }),
        code: 'PROVIDER_AUTH_ERROR', retryable: false, status: 401 },
      { outcome: Object.assign(new Error('403 model access denied'), { status: 403, code: 'permission_denied' }),
        code: 'PROVIDER_AUTH_ERROR', retryable: false, status: 403 },
      { outcome: Object.assign(new Error('429 account quota exceeded'), { status: 429, code: 'insufficient_quota' }),
        code: 'PROVIDER_RATE_LIMIT', retryable: false, status: 429 },
      { outcome: Object.assign(new Error('500 provider unavailable'), { status: 500, code: 'server_error' }),
        code: 'PROVIDER_UNAVAILABLE', retryable: true, status: 500 },
      { outcome: Object.assign(new Error('Provider connection timed out'), { name: 'APIConnectionTimeoutError', code: 'ETIMEDOUT' }),
        code: 'PROVIDER_TIMEOUT', retryable: false },
      { outcome: { data: [] }, code: 'PROVIDER_EMPTY_RESULT', retryable: false },
      { outcome: Object.assign(new Error('429 too many image requests'), { status: 429, code: 'rate_limit_exceeded' }),
        code: 'PROVIDER_RATE_LIMIT', retryable: true, status: 429 },
    ];
    for (const failureCase of failureCases) {
      caseCallCount = 0;
      sdkOutcome = () => failureCase.outcome;
      const beforeWrites = outputWrites.length;
      const beforeCalls = sdkCalls.length;
      const count = failureCase.status === 400 ? 2 : 1;
      await assert.rejects(executeStudioGeneration(scope, request({ count, extra_reference_urls: ['reference-0.png'] })),
        (error: unknown) => {
          assert.ok(error instanceof StudioServiceError);
          assert.ok(error instanceof StudioGenerationFailureError);
          assert.equal(error.code, failureCase.code);
          assert.equal(error.failure.retryable, failureCase.retryable);
          assert.equal(error.failure.status, failureCase.status);
          if (failureCase.status === 400) assert.equal(error.failure.requestId, 'req-fixture-400');
          return true;
        },
        `${failureCase.code} must be thrown instead of returning an empty successful asset`);
      const failed = records.get(schema.studioGenerations)!.at(-1)!;
      assert.equal(failed.status, 'failed');
      const metadata = JSON.parse(String(failed.metadata));
      assert.equal(metadata.errorCode, failureCase.code);
      assert.equal(metadata.retryable, failureCase.retryable);
      assert.equal(typeof metadata.error, 'string');
      assert.equal(typeof metadata.errorDetails, 'string');
      assert.notEqual(metadata.errorDetails, 'All image generations failed');
      assert.equal(metadata.count, count);
      assert.deepEqual(metadata.extraReferenceUrls, ['reference-0.png']);
      assert.equal(metadata.model, 'gpt-image-2.5-flare-2026-09-08');
      assert.equal(metadata.imageSize, '1024x1024');
      assert.equal(metadata.errorStatus, failureCase.status);
      if (failureCase.status === 400) {
        assert.match(metadata.errorDetails, /input_fidelity/);
        assert.equal(metadata.errorRequestId, 'req-fixture-400');
      }
      if (failureCase.status === 401 || failureCase.status === 403) assert.match(metadata.error, /\/settings\?tab=secrets/);
      const outputs = storedOutputs(failed.id);
      assert.equal(outputs.length, count);
      for (const output of outputs) {
        assert.equal(output.filePath, '', 'Failed output rows cannot be presented as generated assets');
        const outputMetadata = JSON.parse(String(output.metadata));
        assert.equal(outputMetadata.errorCode, failureCase.code);
        assert.equal(outputMetadata.retryable, failureCase.retryable);
        assert.equal(typeof outputMetadata.errorDetails, 'string');
        assert.equal(JSON.stringify(outputMetadata).includes(fixtureSecret), false);
        assert.equal(JSON.stringify(outputMetadata).includes(bearerSecret), false);
      }
      assert.equal(JSON.stringify(metadata).includes(fixtureSecret), false);
      assert.equal(JSON.stringify(metadata).includes(bearerSecret), false);
      assert.equal(outputWrites.length, beforeWrites, 'All failed generations write no output files');
      assert.equal(sdkCalls.length - beforeCalls, count, 'Failures do not trigger unrequested provider retries');
    }

    const savedFailure = await createStudioGeneration(scope, request());
    const savedFailureRow = generation(savedFailure.generationId);
    const savedSettings = { count: 1, inputFidelity: 'high', quality: 'high', outputFormat: 'png',
      outputCompression: 100, imageSize: '1024x1024', extraReferenceUrls: ['reference-0.png'] };
    savedFailureRow.metadata = JSON.stringify(savedSettings);
    caseCallCount = 0;
    sdkOutcome = () => failureCases[0].outcome;
    await runStudioGeneration(savedFailure.generationId);
    const savedFailureMetadata = JSON.parse(String(savedFailureRow.metadata));
    for (const [key, value] of Object.entries(savedSettings)) assert.deepEqual(savedFailureMetadata[key], value,
      'Failure diagnostics append without rewriting historical requested settings');
    assert.equal(savedFailureMetadata.errorCode, 'INVALID_PROVIDER_REQUEST');
    assert.match(savedFailureMetadata.errorDetails, /input_fidelity/);

    caseCallCount = 0;
    sdkOutcome = (ordinal) => ordinal === 0 ? successfulResponse : failureCases[4].outcome;
    const writesBeforePartial = outputWrites.length;
    const partial = await executeStudioGeneration(scope, request({ count: 2, extra_reference_urls: ['reference-0.png'] }));
    assert.equal(partial.status, 'completed');
    assert.equal(partial.outputs.length, 1, 'A partial result exposes successful assets only');
    assert.ok(partial.outputs[0].filePath);
    assert.ok(partial.outputs[0].mediaUrl);
    assert.ok(partial.outputs[0].fileSize > 0);
    assert.equal(outputWrites.length - writesBeforePartial, 1);
    assert.equal(caseCallCount, 2);
    const partialDetails = partial as typeof partial & { failedOutputCount?: number; warnings?: string[] };
    assert.equal(partialDetails.failedOutputCount, 1);
    assert.equal(partialDetails.warnings?.length, 1, 'Agent callers receive an explicit partial-success warning');
    const partialMetadata = JSON.parse(String(generation(partial.generationId).metadata));
    assert.equal(partialMetadata.failedOutputCount, 1);
    assert.deepEqual(partialMetadata.warnings, partialDetails.warnings);
    assert.equal(typeof partialMetadata.warnings[0], 'string');
    assert.equal(partialMetadata.count, 2);
    assert.deepEqual(partialMetadata.extraReferenceUrls, ['reference-0.png']);
    const partialOutputs = storedOutputs(partial.generationId);
    assert.equal(partialOutputs.length, 2, 'Persistence retains the successful asset and failed variation diagnostics');
    const rejectedVariation = partialOutputs.find((output) => !output.filePath);
    assert.ok(rejectedVariation);
    assert.equal(JSON.parse(String(rejectedVariation.metadata)).errorCode, 'PROVIDER_UNAVAILABLE');
    assert.equal(partial.outputs.some((output) => output.id === rejectedVariation.id), false);

    const priorPartialRow = generation(partial.generationId);
    const settingsBeforeReplay = JSON.parse(String(priorPartialRow.metadata));
    const writesBeforeReplay = outputWrites.length;
    caseCallCount = 0;
    sdkOutcome = () => failureCases[0].outcome;
    await runStudioGeneration(partial.generationId);
    const replayedMetadata = JSON.parse(String(priorPartialRow.metadata));
    assert.equal(priorPartialRow.status, 'failed');
    assert.equal(replayedMetadata.errorCode, 'INVALID_PROVIDER_REQUEST');
    assert.equal(replayedMetadata.failedOutputCount, 2, 'The new total failure replaces the earlier partial failure count');
    assert.equal(Object.hasOwn(replayedMetadata, 'warning'), false, 'A total failure cannot retain an earlier partial-success message');
    assert.equal(Object.hasOwn(replayedMetadata, 'warnings'), false, 'Earlier provider warnings cannot describe the new failed attempt');
    for (const key of ['count', 'provider', 'model', 'quality', 'outputFormat', 'background', 'imageSize', 'extraReferenceUrls']) {
      assert.deepEqual(replayedMetadata[key], settingsBeforeReplay[key], 'Replay preserves the original generation settings');
    }
    assert.equal(caseCallCount, 2);
    assert.equal(outputWrites.length, writesBeforeReplay);
    assert.ok(storedOutputs(partial.generationId).some((output) => output.id === partial.outputs[0].id && output.filePath),
      'An earlier successfully generated asset remains in history');

    caseCallCount = 0;
    sdkOutcome = (ordinal) => ordinal === 0 ? failureCases[0].outcome : failureCases[3].outcome;
    await assert.rejects(executeStudioGeneration(scope, request({ count: 2 })),
      (error: unknown) => error instanceof StudioServiceError && error.code === 'INVALID_PROVIDER_REQUEST',
      'When every variation fails, preserve the first classified cause instead of a generic batch error');
    const mixedFailed = records.get(schema.studioGenerations)!.at(-1)!;
    assert.equal(JSON.parse(String(mixedFailed.metadata)).errorCode, 'INVALID_PROVIDER_REQUEST');
    assert.deepEqual(storedOutputs(mixedFailed.id).map((output) => JSON.parse(String(output.metadata)).errorCode).sort(),
      ['INVALID_PROVIDER_REQUEST', 'PROVIDER_RATE_LIMIT']);
    console.log('studio-openai-service-test: snapshots, request normalization, failure classifications and partial outputs passed');
  } finally {
    globalThis.fetch = previousFetch;
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
