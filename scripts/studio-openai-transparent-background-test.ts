import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  OPENAI_IMAGE_MODEL_ID,
  OPENAI_FLARE_IMAGE_MODEL_ID,
  OPENAI_ASPECT_RATIOS,
  OPENAI_IMAGE_FORMAT_PRESETS,
  OPENAI_MODELS,
  QUALITY_OPTIONS,
  getMaxImageCountForProvider,
  getOpenAIImageRequestValidationError,
  getOpenAIImageAspectRatio,
  getOpenAIImageFormatPreset,
  getOpenAIImageSizeValidationError,
  normalizeOpenAIImageSizeInput,
  normalizeOpenAIImageModelId,
  normalizeOpenAIImageOutputFormat,
} from '../app/lib/integrations/image-generation-constants';

assert.equal(OPENAI_IMAGE_MODEL_ID, 'gpt-image-2.5-sunburst');
assert.equal(OPENAI_FLARE_IMAGE_MODEL_ID, 'gpt-image-2.5-flare');
assert.deepEqual(OPENAI_MODELS.map((model) => model.id), [OPENAI_IMAGE_MODEL_ID, OPENAI_FLARE_IMAGE_MODEL_ID]);
assert.equal(normalizeOpenAIImageModelId('gpt-image-2'), OPENAI_IMAGE_MODEL_ID);
assert.equal(normalizeOpenAIImageModelId('gpt-image-2-2026-04-21'), OPENAI_IMAGE_MODEL_ID);
assert.deepEqual(QUALITY_OPTIONS, ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.equal(getMaxImageCountForProvider('image', 'openai'), 10);
assert.deepEqual(OPENAI_ASPECT_RATIOS, ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '4:5', 'auto']);
assert.equal(OPENAI_IMAGE_FORMAT_PRESETS.length, 9);
assert.equal(getOpenAIImageFormatPreset('1536 × 1024')?.aspectRatio, '3:2');
assert.equal(getOpenAIImageAspectRatio('1280x1024'), '5:4');
assert.equal(getOpenAIImageAspectRatio('auto'), 'auto');
assert.equal(normalizeOpenAIImageSizeInput(' 1536 × 864 '), '1536x864');
assert.equal(normalizeOpenAIImageSizeInput('01024 X 01536'), '1024x1536');

assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'jpeg'), 'png');
assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'png'), 'png');
assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'webp'), 'webp');
assert.equal(normalizeOpenAIImageOutputFormat('opaque', 'jpeg'), 'jpeg');
assert.equal(normalizeOpenAIImageOutputFormat('auto', undefined), undefined);

assert.equal(getOpenAIImageSizeValidationError('auto'), null);
assert.equal(getOpenAIImageSizeValidationError('1536x864'), null);
assert.equal(getOpenAIImageSizeValidationError('1536 × 864'), null);
assert.equal(getOpenAIImageSizeValidationError('2160x3840'), null);
assert.match(getOpenAIImageSizeValidationError('1537x864') || '', /divisible by 16/);
assert.match(getOpenAIImageSizeValidationError('4096x1024') || '', /3840/);
assert.match(getOpenAIImageSizeValidationError('3840x1024') || '', /1:3/);
assert.match(getOpenAIImageSizeValidationError('512x512') || '', /655,360/);

assert.equal(getOpenAIImageRequestValidationError({
  model: OPENAI_IMAGE_MODEL_ID,
  count: 10,
  quality: 'max',
  outputFormat: 'webp',
  background: 'transparent',
  moderation: 'low',
  outputCompression: 80,
  inputFidelity: 'high',
  imageSize: '1536x864',
  stream: true,
  partialImages: 3,
}), null);
assert.equal(getOpenAIImageRequestValidationError({
  model: OPENAI_FLARE_IMAGE_MODEL_ID,
  quality: 'xhigh',
  imageSize: '1536x864',
  background: 'transparent',
  outputFormat: 'png',
}), null);
assert.match(getOpenAIImageRequestValidationError({ quality: 'ultra' }) || '', /Quality/);
assert.match(getOpenAIImageRequestValidationError({ outputCompression: 101, outputFormat: 'jpeg' }) || '', /0 and 100/);
assert.match(getOpenAIImageRequestValidationError({ outputCompression: 80, outputFormat: 'png' }) || '', /JPEG or WebP/);
assert.match(getOpenAIImageRequestValidationError({ imageSize: '1537x864' }) || '', /divisible by 16/);
assert.match(getOpenAIImageRequestValidationError({ stream: false, partialImages: 1 }) || '', /streaming/);
assert.match(getOpenAIImageRequestValidationError({ count: 11 }) || '', /between 1 and 10/);
assert.match(getOpenAIImageRequestValidationError({ model: 'gpt-image-2.5-unknown' }) || '', /Model/);

const studioToolSource = readFileSync(path.join(process.cwd(), 'app/lib/pi/studio-tools.ts'), 'utf8');
assert.match(studioToolSource, /For a transparent background, use png \(recommended\) or webp; jpeg does not support transparency\./);
assert.match(studioToolSource, /set this to transparent and set output_format to png \(recommended\) or webp\./);
assert.match(studioToolSource, /gpt-image-2\.5-sunburst/);
assert.match(studioToolSource, /gpt-image-2\.5-flare/);
assert.doesNotMatch(studioToolSource, /gpt-image-2(?!\.5|-2026)/);
assert.match(studioToolSource, /Type\.Literal\('xhigh'\)/);
assert.match(studioToolSource, /Type\.Literal\('max'\)/);
assert.match(studioToolSource, /output_compression/);
assert.match(studioToolSource, /input_fidelity/);
assert.match(studioToolSource, /partial_images/);

const providerSource = readFileSync(path.join(process.cwd(), 'app/lib/integrations/image-generation-providers.ts'), 'utf8');
for (const apiParameter of [
  'background',
  'input_fidelity',
  'moderation',
  'output_compression',
  'output_format',
  'partial_images',
  'quality',
  'size',
  'stream',
  'user',
]) {
  assert.match(providerSource, new RegExp(apiParameter), `Provider must pass ${apiParameter}`);
}

const studioGenerationHookSource = readFileSync(path.join(process.cwd(), 'app/apps/studio/hooks/useStudioGeneration.ts'), 'utf8');
assert.match(studioGenerationHookSource, /image_size: imageFormat\.imageSize/u);

const generationServiceSource = readFileSync(path.join(process.cwd(), 'app/lib/integrations/studio-generation-service.ts'), 'utf8');
const validationPosition = generationServiceSource.indexOf('getOpenAIImageRequestValidationError({');
const persistencePosition = generationServiceSource.indexOf('const requestMetadata = JSON.stringify({');
assert.ok(validationPosition >= 0 && validationPosition < persistencePosition, 'OpenAI options must be validated before persistence');
assert.match(generationServiceSource, /getOpenAIImageAspectRatio\(openAIImageSize, requestedAspectRatio\)/u);
assert.match(generationServiceSource, /!provider\.supportedAspectRatios\.includes\(aspectRatio\) && !hasValidOpenAIImageSize/u);

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

async function testPersistedOpenAIMigration() {
  const localStorage = new MemoryStorage();
  localStorage.setItem('studio-generation-options', JSON.stringify({
    mode: 'image',
    provider: 'openai',
    model: 'gpt-image-2',
    aspectRatio: '16:9',
    imageSize: '1K',
  }));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });
  const { createStudioGenerationStore } = await import('../app/store/studio-generation-store');
  const migratedState = createStudioGenerationStore().getState();
  assert.equal(migratedState.model, OPENAI_IMAGE_MODEL_ID);
  assert.equal(migratedState.imageSize, '1536x864');

  localStorage.setItem('studio-generation-options', JSON.stringify({
    mode: 'image',
    provider: 'openai',
    model: OPENAI_IMAGE_MODEL_ID,
    aspectRatio: '1:1',
    imageSize: '1280 × 1024',
  }));
  const restoredCustomState = createStudioGenerationStore().getState();
  assert.equal(restoredCustomState.imageSize, '1280x1024');
  assert.equal(restoredCustomState.aspectRatio, '5:4');

  localStorage.setItem('studio-generation-options', JSON.stringify({
    mode: 'image',
    provider: 'openai',
    model: OPENAI_FLARE_IMAGE_MODEL_ID,
  }));
  assert.equal(createStudioGenerationStore().getState().model, OPENAI_FLARE_IMAGE_MODEL_ID);

  restoredCustomState.setOpenAIImageFormat({ aspectRatio: '4:5', imageSize: '1024x1280' });
  const updatedCustomState = createStudioGenerationStore().getState();
  assert.equal(updatedCustomState.imageSize, '1024x1280');
  assert.equal(updatedCustomState.aspectRatio, '4:5');
}

testPersistedOpenAIMigration()
  .then(() => console.log('Studio OpenAI GPT Image 2.5 API contract test passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
