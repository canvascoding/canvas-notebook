// Outbound request contracts against the real provider with mocked SDK and
// credential/managed boundaries. The fetch guard prohibits live API calls.
// Run: node --experimental-test-module-mocks --import tsx --conditions react-server scripts/studio-openai-provider-test.ts
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { APIError } from 'openai/error';
import sharp from 'sharp';
import type { ProviderGenerateParams } from '../app/lib/integrations/image-generation-providers';

type Request = Record<string, unknown>;
type SdkCall = { method: 'generate' | 'edit'; request: Request };
type ManagedRequest = {
  model: string;
  parameters: Request;
  references: Array<{ imageBytes: string; mimeType: string }>;
};

async function main() {
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#224466' } }).png().toBuffer();
  const mask = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const smallMask = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#000000' } }).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const noAlphaPng = await sharp(png).removeAlpha().png().toBuffer();
  const unsupportedReferences = await Promise.all([
    sharp(png).gif().toBuffer().then((bytes) => ({ imageBytes: bytes.toString('base64'), mimeType: 'image/gif' })),
    sharp(png).tiff().toBuffer().then((bytes) => ({ imageBytes: bytes.toString('base64'), mimeType: 'image/tiff' })),
  ]);
  unsupportedReferences.push({ imageBytes: Buffer.from('BM unsupported bitmap').toString('base64'), mimeType: 'image/bmp' });
  const reference = { imageBytes: png.toString('base64'), mimeType: 'image/png', fileName: 'reference.png' };
  const editMask = { imageBytes: mask.toString('base64'), mimeType: 'image/png', fileName: 'mask.png' };
  const usage = { total_tokens: 30, input_tokens: 10, output_tokens: 20 };
  const sdkCalls: SdkCall[] = [];
  const managedCalls: ManagedRequest[] = [];
  let route: 'direct' | 'managed' = 'direct';
  let credentialCalls = 0;
  let constructorCalls = 0;
  let sdkResponse: unknown = { data: [{ b64_json: png.toString('base64') }], usage };
  let sdkFailure: Error | undefined;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    if (typeof values[0] !== 'string' || !values[0].startsWith('[OpenAI Image]')) originalLog(...values);
  };
  globalThis.fetch = async () => { throw new Error('Provider contract tests must not make network requests.'); };

  class FakeOpenAI {
    constructor(options: { apiKey: string; maxRetries: number }) {
      constructorCalls += 1;
      assert.equal(options.apiKey, 'provider-fixture-key');
      assert.equal(options.maxRetries, 0, 'Image generation must not be replayed automatically after an ambiguous network failure.');
    }

    images = {
      generate: async (request: Request) => {
        sdkCalls.push({ method: 'generate', request });
        if (sdkFailure) throw sdkFailure;
        return sdkResponse;
      },
      edit: async (request: Request) => {
        sdkCalls.push({ method: 'edit', request });
        if (sdkFailure) throw sdkFailure;
        return sdkResponse;
      },
    };
  }

  mock.module('openai', { exports: { default: FakeOpenAI } });
  // tsx emits this repository's TypeScript as CommonJS; OpenAI has separate
  // import and require entrypoints, so intercept both SDK resolutions.
  mock.module(createRequire(import.meta.url).resolve('openai'), { exports: { default: FakeOpenAI } });
  mock.module('../app/lib/integrations/studio-provider-credentials.ts', { exports: {
    resolveStudioProviderCredential: async (provider: string) => {
      assert.equal(provider, 'openai');
      credentialCalls += 1;
      return route === 'direct' ? 'provider-fixture-key' : null;
    },
  } });
  mock.module('../app/lib/integrations/managed-media-client.ts', { exports: {
    isManagedMediaFallbackAvailable: () => true,
    generateManagedMedia: async (request: ManagedRequest) => {
      managedCalls.push(request);
      return { jobId: 'provider-fixture-job', outputs: [{ bytes: png, mimeType: `image/${request.parameters.outputFormat}`, metadata: {
        usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 },
      } }] };
    },
  } });

  try {
    const { getImageGenerationProvider } = await import('../app/lib/integrations/image-generation-providers');
    const provider = getImageGenerationProvider('openai');
    assert.ok(provider);
    const params = (patch: Partial<ProviderGenerateParams> = {}): ProviderGenerateParams => ({
      prompt: 'Preserve the reference and generate a poster.',
      model: 'gpt-image-2.5-sunburst',
      aspectRatio: 'auto',
      imageSize: 'auto',
      referenceImages: [],
      endUserId: 'provider-fixture-user',
      ...patch,
    });
    const clearCalls = () => {
      sdkCalls.length = 0;
      managedCalls.length = 0;
      credentialCalls = 0;
      constructorCalls = 0;
    };
    const captured = () => {
      assert.equal(credentialCalls, 1);
      if (route === 'direct') {
        assert.equal(constructorCalls, 1);
        assert.equal(sdkCalls.length, 1);
        assert.equal(managedCalls.length, 0);
        return sdkCalls[0].request;
      }
      assert.equal(constructorCalls, 0);
      assert.equal(sdkCalls.length, 0);
      assert.equal(managedCalls.length, 1);
      return managedCalls[0].parameters;
    };
    const models = [
      ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst'],
      ['gpt-image-2.5-flare', 'gpt-image-2.5-flare'],
      ['gpt-image-2.5-sunburst-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08'],
      ['gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-flare-2026-09-08'],
      ['gpt-image-2', 'gpt-image-2.5-sunburst'],
      ['gpt-image-2-2026-04-21', 'gpt-image-2.5-sunburst'],
    ];

    for (const selectedRoute of ['direct', 'managed'] as const) {
      route = selectedRoute;
      for (const [model, effectiveModel] of models) {
        for (const inputFidelity of [undefined, 'low', 'high'] as const) {
          clearCalls();
          const result = await provider.generate(params({ model, referenceImages: [reference, reference], inputFidelity,
            quality: 'max', background: 'transparent', outputFormat: 'webp', outputCompression: 0, moderation: 'low' }));
          const request = captured();
          assert.equal(route === 'direct' ? request.model : managedCalls[0].model, effectiveModel);
          assert.equal(Object.hasOwn(request, 'input_fidelity'), false);
          assert.equal(Object.hasOwn(request, 'inputFidelity'), false);
          assert.equal(request.quality, 'max');
          assert.equal(request.background, 'transparent');
          assert.equal(request.moderation, 'low');
          assert.equal(request[route === 'direct' ? 'output_format' : 'outputFormat'], 'webp');
          assert.equal(request[route === 'direct' ? 'output_compression' : 'outputCompression'], 0);
          assert.equal(result.mimeType, 'image/webp');
          assert.deepEqual(result.usage, { totalTokens: 30, inputTokens: 10, outputTokens: 20 });
          if (route === 'direct') {
            assert.equal(sdkCalls[0].method, 'edit');
            assert.ok(Array.isArray(request.image));
            assert.equal(request.image.length, 2);
          } else {
            assert.equal(managedCalls[0].references.length, 2);
          }
        }
      }

      for (const quality of ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        clearCalls();
        await provider.generate(params({ model: 'gpt-image-2.5-flare', quality, inputFidelity: 'high',
          imageSize: '1280 × 1024', aspectRatio: '5:4', outputFormat: 'jpeg', outputCompression: 100, background: 'opaque' }));
        const request = captured();
        assert.equal(request.quality, quality);
        assert.equal(request[route === 'direct' ? 'size' : 'imageSize'], '1280x1024');
        assert.equal(request[route === 'direct' ? 'output_format' : 'outputFormat'], 'jpeg');
        assert.equal(request[route === 'direct' ? 'output_compression' : 'outputCompression'], 100);
        assert.equal(Object.hasOwn(request, 'input_fidelity'), false);
        assert.equal(request.inputFidelity, undefined);
        if (route === 'direct') assert.equal(sdkCalls[0].method, 'generate');
      }

      clearCalls();
      await provider.generate(params({ background: 'transparent', outputFormat: 'jpeg', outputCompression: 80 }));
      const transparentRequest = captured();
      assert.equal(transparentRequest[route === 'direct' ? 'output_format' : 'outputFormat'], 'png');
      assert.equal(transparentRequest[route === 'direct' ? 'output_compression' : 'outputCompression'], undefined);

      clearCalls();
      await provider.generate(params({ outputFormat: 'png', outputCompression: 0 }));
      assert.equal(captured()[route === 'direct' ? 'output_compression' : 'outputCompression'], undefined);

      for (const [bytes, mimeType] of [[jpeg, 'image/jpeg'], [webp, 'image/webp'], [png, 'image/png']] as const) {
        clearCalls();
        await provider.generate(params({ referenceImages: [{ imageBytes: bytes.toString('base64'), mimeType: 'application/octet-stream' }] }));
        const request = captured();
        if (route === 'direct') {
          assert.ok(request.image instanceof File);
          assert.equal(request.image.type, mimeType);
          assert.deepEqual(Buffer.from(await request.image.arrayBuffer()), bytes);
        } else {
          assert.equal(managedCalls[0].references[0].mimeType, mimeType);
          assert.equal(managedCalls[0].references[0].imageBytes, bytes.toString('base64'));
        }
      }

      if (route === 'managed') {
        for (const partialImages of [undefined, 0, 1, 2, 3]) {
          clearCalls();
          await provider.generate(params({ stream: true, partialImages }));
          const request = captured();
          assert.equal(request.stream, true);
          assert.equal(request.partialImages, partialImages ?? 0);
        }
      }

      for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
        clearCalls();
        await provider.generate(params({ model, referenceImages: [reference], editMask, inputFidelity: 'high' }));
        const request = captured();
        if (route === 'direct') {
          assert.equal(sdkCalls[0].method, 'edit');
          assert.ok(request.image instanceof File);
          assert.ok(request.mask instanceof File);
          assert.deepEqual(Buffer.from(await request.mask.arrayBuffer()), mask);
        } else {
          assert.equal(managedCalls[0].references.length, 2);
          assert.equal(request.editMaskReferenceIndex, 1);
          assert.equal(managedCalls[0].references[1].imageBytes, editMask.imageBytes);
        }
      }

      const invalid: Array<Partial<ProviderGenerateParams>> = [
        { model: 'gpt-image-2.5-unknown' },
        { quality: 'ultra' as never },
        { outputFormat: 'gif' as never },
        { background: 'missing' as never },
        { moderation: 'off' as never },
        { inputFidelity: 'ultra' as never },
        { outputCompression: -1 },
        { outputCompression: 101 },
        { outputCompression: 0.5 },
        { imageSize: '1537x864' },
        { imageSize: '4096x1024' },
        { imageSize: '3840x1024' },
        { imageSize: '512x512' },
        { aspectRatio: 'unknown', imageSize: undefined },
        { partialImages: -1, stream: true },
        { partialImages: 4, stream: true },
        { partialImages: 0, stream: false },
        { referenceImages: Array.from({ length: 17 }, () => reference) },
        { referenceImages: [{ ...reference, imageBytes: '' }] },
        { referenceImages: [{ ...reference, imageBytes: Buffer.from('invalid image bytes').toString('base64') }] },
        ...unsupportedReferences.map((unsupportedReference) => ({ referenceImages: [unsupportedReference] })),
        { editMask },
        { referenceImages: [reference], editMask: { imageBytes: jpeg.toString('base64'), mimeType: 'image/jpeg' } },
        { referenceImages: [reference], editMask: { ...editMask, imageBytes: noAlphaPng.toString('base64') } },
        { referenceImages: [reference], editMask: { ...editMask, imageBytes: smallMask.toString('base64') } },
        { referenceImages: [reference], editMask: { ...editMask, imageBytes: Buffer.concat([mask, Buffer.alloc(4 * 1024 * 1024 - mask.length)]).toString('base64') } },
        { referenceImages: [reference], editMask: { ...editMask, imageBytes: Buffer.concat([mask, Buffer.alloc(4 * 1024 * 1024)]).toString('base64') } },
      ];
      for (const patch of invalid) {
        clearCalls();
        await assert.rejects(provider.generate(params(patch)), Error, `Invalid ${Object.keys(patch).join(', ')} must be rejected`);
        assert.equal(credentialCalls, 0, `Invalid ${Object.keys(patch).join(', ')} must fail before credential resolution`);
        assert.equal(constructorCalls, 0);
        assert.equal(sdkCalls.length, 0);
        assert.equal(managedCalls.length, 0);
      }
    }

    route = 'direct';
    for (const references of [[], [reference]]) {
      for (const partialImages of [0, 1, 2, 3]) {
        clearCalls();
        sdkResponse = (async function* () {
          yield { type: references.length ? 'image_edit.partial_image' : 'image_generation.partial_image', b64_json: 'partial-only' };
          yield { type: references.length ? 'image_edit.completed' : 'image_generation.completed', b64_json: png.toString('base64'), usage };
        })();
        const result = await provider.generate(params({ referenceImages: references, stream: true, partialImages }));
        const request = captured();
        assert.equal(request.stream, true);
        assert.equal(request.partial_images, partialImages);
        assert.equal(result.imageBytes, png.toString('base64'));
        assert.deepEqual(result.usage, { totalTokens: 30, inputTokens: 10, outputTokens: 20 });
      }
      sdkResponse = (async function* () { yield { type: 'image_generation.partial_image', b64_json: 'partial-only' }; })();
      await assert.rejects(provider.generate(params({ referenceImages: references, stream: true })), /No final image/);
      const streamFailure = new Error('Provider stream interrupted');
      sdkResponse = (async function* () { throw streamFailure; })();
      await assert.rejects(provider.generate(params({ referenceImages: references, stream: true })), (error) => error === streamFailure);
      const sdkStreamFailure = new APIError(undefined, { code: 'rate_limit_exceeded', message: 'Streaming provider rate limit' }, undefined, undefined);
      sdkResponse = (async function* () {
        yield { type: references.length ? 'image_edit.partial_image' : 'image_generation.partial_image', b64_json: 'partial-only' };
        throw sdkStreamFailure;
      })();
      await assert.rejects(provider.generate(params({ referenceImages: references, stream: true })), (error) => error === sdkStreamFailure);
      assert.equal(sdkStreamFailure.status, undefined);
      sdkResponse = (async function* () {
        yield { type: references.length ? 'image_edit.partial_image' : 'image_generation.partial_image', b64_json: 'partial-only' };
        yield { type: 'error', code: 'moderation_blocked', status: 400, message: 'The streamed image did not meet safety requirements.' };
      })();
      await assert.rejects(provider.generate(params({ referenceImages: references, stream: true })), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'The streamed image did not meet safety requirements.');
        assert.equal((error as Error & { code?: string }).code, 'moderation_blocked');
        assert.equal((error as Error & { status?: number }).status, 400);
        return true;
      });
    }

    sdkResponse = { data: [] };
    await assert.rejects(provider.generate(params()), /No image/);
    sdkFailure = Object.assign(new Error('400 unsupported parameter'), { status: 400, code: 'unsupported_parameter', param: 'input_fidelity' });
    await assert.rejects(provider.generate(params()), (error) => error === sdkFailure);
    await assert.rejects(provider.generate(params({ referenceImages: [reference] })), (error) => error === sdkFailure);
    console.log('studio-openai-provider-test: outbound direct/managed, edit masks, validation, streams and errors passed');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
