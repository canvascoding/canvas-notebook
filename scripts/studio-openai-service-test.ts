import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import sharp from 'sharp';
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
  const unexpected = () => { throw new Error('An unrelated media service must not run in image regression tests.'); };
  class FakeOpenAI {
    images = {
      generate: async (request: Row) => { sdkCalls.push({ method: 'generate', request }); return { data: [{ b64_json: images[0].toString('base64') }] }; },
      edit: async (request: Row) => { sdkCalls.push({ method: 'edit', request }); return { data: [{ b64_json: images[0].toString('base64') }] }; },
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
  mock.module('@/app/lib/integrations/veo-generation-service', { exports: { generateVideo: unexpected } });
  mock.module('@/app/lib/integrations/seedance-generation-service', { exports: {
    generateSeedanceVideo: unexpected, SEEDANCE_MODEL_ID: 'bytedance/seedance-2', SEEDANCE_PROVIDER_ID: 'bytedance',
  } });
  mock.module('@/app/lib/integrations/sound-generation-service', { exports: {
    generateSound: unexpected, LYRIA_CLIP_MODEL_ID: 'lyria-3-clip-preview', LYRIA_PRO_MODEL_ID: 'lyria-3-pro-preview',
  } });
  mock.module('@/app/lib/integrations/studio-generation-concurrency', { exports: {
    withStudioGenerationConcurrency: async (_mode: string, run: () => Promise<unknown>) => run(),
  } });
  mock.module('@/app/lib/integrations/studio-provider-credentials', { exports: { resolveStudioProviderCredential: async () => 'fixture-key' } });
  mock.module('@/app/lib/integrations/managed-media-client', { exports: { isManagedMediaFallbackAvailable: () => false, generateManagedMedia: unexpected } });
  mock.module('@/app/lib/mobile/push-devices', { exports: { sendStudioCompletedPush: async () => {}, sendFailureAttentionPush: async () => {} } });
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
    console.log('studio-openai-service-test: snapshots, normalized persistence, legacy replay and combined reference limits passed');
  } finally {
    globalThis.fetch = previousFetch;
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
