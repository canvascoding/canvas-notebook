import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { StudioScope } from '../app/lib/integrations/studio-scope';

async function main() {
  const scope: StudioScope = { actorUserId: 'fixture-user', organizationId: 'fixture-org', customerId: null,
    projectId: null, workspaceId: 'fixture-workspace', storage: { organizationId: 'fixture-org', workspaceId: 'fixture-workspace' } };
  const catalogCalls: string[] = [];
  let hasOpenAIKey = true;
  const unexpected = () => { throw new Error('Catalog compatibility checks must not access files, persistence or providers.'); };
  mock.module('@/app/lib/integrations/studio-config', { exports: {
    getStudioProviderConfig: async (input: { userId: string }) => {
      assert.equal(input.userId, scope.actorUserId);
      catalogCalls.push('config');
      return { managedMediaAvailable: false, localApiKeys: { openai: hasOpenAIKey, gemini: false, kie: false } };
    },
  } });
  for (const [module, exportName] of [
    ['studio-preset-service', 'listPresets'], ['studio-product-service', 'listProducts'],
    ['studio-persona-service', 'listPersonas'], ['studio-style-service', 'listStyles'],
  ]) {
    mock.module(`@/app/lib/integrations/${module}`, { exports: {
      [exportName]: async (receivedScope: StudioScope) => {
        assert.equal(receivedScope, scope);
        catalogCalls.push(exportName);
        return [];
      },
    } });
  }
  mock.module('@/app/lib/integrations/studio-generation-service', { exports: {
    getStudioGeneration: unexpected, getStudioOutputForUser: unexpected, listStudioGenerations: unexpected,
  } });
  mock.module('@/app/lib/filesystem/workspace-files', { exports: { getFileStats: unexpected, readFile: unexpected } });
  mock.module('@/app/lib/integrations/studio-workspace', { exports: { generateStudioReferencePath: unexpected, writeAssetFile: unexpected } });
  mock.module('@/app/lib/mobile/files', { exports: { normalizeMobileFilePath: unexpected } });
  mock.module('@/app/lib/public-sharing/public-file-shares', { exports: { getPublicShareMimeType: unexpected } });
  mock.module('@/app/lib/utils/media-url', { exports: { toPreviewUrl: unexpected } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Catalog compatibility checks must not make network requests.'); };

  try {
    const { getMobileStudioCatalog, serializeMobileStudioGeneration } = await import('../app/lib/mobile/studio');
    const models = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'];
    for (const available of [true, false]) {
      hasOpenAIKey = available;
      catalogCalls.length = 0;
      const catalog = await getMobileStudioCatalog({ scope, userId: scope.actorUserId, canWrite: true, canDeleteAssets: false });
      const wireCatalog = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
      assert.deepEqual(catalogCalls.sort(), ['config', 'listPersonas', 'listPresets', 'listProducts', 'listStyles']);
      const imageMode = wireCatalog.modes.find((mode) => mode.id === 'image');
      assert.ok(imageMode);
      const openAI = imageMode.providers.find((provider) => provider.id === 'openai');
      assert.ok(openAI);
      assert.equal(openAI.available, available);
      assert.deepEqual(openAI.models.map((model) => model.id), models);
      for (const model of openAI.models) {
        assert.ok(model.capabilities);
        assert.equal(model.capabilities.modelId, model.id);
        assert.equal(model.capabilities.supportsInputFidelity, false);
        assert.equal(model.capabilities.supportsStreaming, true);
        assert.equal(model.capabilities.supportsEditMask, true);
        assert.equal(model.capabilities.maxInputImages, 16);
      }
      assert.equal(wireCatalog.options.openAIImage.supportsInputFidelity, false);
      assert.deepEqual(wireCatalog.options.inputFidelity, ['low', 'high'], 'The legacy provider-level array remains available');
      assert.deepEqual(wireCatalog.options.openAIImage.inputFidelity, ['low', 'high'], 'Older Expo catalog parsing still has its required array');
      assert.deepEqual(wireCatalog.options.qualities, ['auto', 'low', 'medium', 'high']);
      assert.deepEqual(wireCatalog.options.openAIImage.qualities, ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
      assert.equal(wireCatalog.options.openAIImage.maxOutputCount, 10);
      assert.equal(wireCatalog.options.openAIImage.supportsStreaming, true);
      assert.equal(wireCatalog.actions.canCreate, true);
      assert.equal(wireCatalog.actions.canDeleteAssets, false);
    }

    for (const model of models) {
      for (const inputFidelity of [undefined, 'low', 'high'] as const) {
        const serialized = serializeMobileStudioGeneration({
          id: 'fixture-generation', mode: 'image', prompt: 'Create a poster.', rawPrompt: 'Create a poster.',
          studioPresetId: null, studioPresetName: null, aspectRatio: '1:1', provider: 'openai', model,
          status: 'completed', metadata: JSON.stringify({ count: 1, quality: 'high', outputFormat: 'png',
            imageSize: '1024x1024', inputFidelity }), product_ids: [], persona_ids: [], style_ids: [], outputs: [],
          createdAt: new Date('2026-10-14T00:00:00.000Z'), updatedAt: new Date('2026-10-14T00:00:01.000Z'),
        } as never);
        const wireGeneration = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
        assert.ok(wireGeneration.settings.openAIImage);
        assert.equal(Object.hasOwn(wireGeneration.settings.openAIImage, 'inputFidelity'), true,
          'Older Expo requires this generation-settings field even though it is no longer sent to OpenAI');
        assert.equal(wireGeneration.settings.openAIImage.inputFidelity, inputFidelity ?? 'low');
        assert.equal(wireGeneration.settings.openAIImage.outputFormat, 'png');
        assert.equal(wireGeneration.settings.openAIImage.imageSize, '1024x1024');
        assert.equal(wireGeneration.model, model);
      }
    }
    console.log('mobile-studio-capabilities-test: actual catalog capabilities and older Expo response compatibility passed');
  } finally {
    globalThis.fetch = previousFetch;
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
