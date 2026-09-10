import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  OPENAI_IMAGE_MODEL_ID,
  OPENAI_MODELS,
  QUALITY_OPTIONS,
  getMaxImageCountForProvider,
  getOpenAIImageRequestValidationError,
  getOpenAIImageSizeValidationError,
  normalizeOpenAIImageModelId,
  normalizeOpenAIImageOutputFormat,
} from '../app/lib/integrations/image-generation-constants';

assert.equal(OPENAI_IMAGE_MODEL_ID, 'gpt-image-2.5-sunburst');
assert.deepEqual(OPENAI_MODELS.map((model) => model.id), ['gpt-image-2.5-sunburst']);
assert.equal(normalizeOpenAIImageModelId('gpt-image-2'), OPENAI_IMAGE_MODEL_ID);
assert.equal(normalizeOpenAIImageModelId('gpt-image-2-2026-04-21'), OPENAI_IMAGE_MODEL_ID);
assert.deepEqual(QUALITY_OPTIONS, ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.equal(getMaxImageCountForProvider('image', 'openai'), 10);

assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'jpeg'), 'png');
assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'png'), 'png');
assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'webp'), 'webp');
assert.equal(normalizeOpenAIImageOutputFormat('opaque', 'jpeg'), 'jpeg');
assert.equal(normalizeOpenAIImageOutputFormat('auto', undefined), undefined);

assert.equal(getOpenAIImageSizeValidationError('auto'), null);
assert.equal(getOpenAIImageSizeValidationError('1536x864'), null);
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

const generationServiceSource = readFileSync(path.join(process.cwd(), 'app/lib/integrations/studio-generation-service.ts'), 'utf8');
const validationPosition = generationServiceSource.indexOf('getOpenAIImageRequestValidationError({');
const persistencePosition = generationServiceSource.indexOf('const requestMetadata = JSON.stringify({');
assert.ok(validationPosition >= 0 && validationPosition < persistencePosition, 'OpenAI options must be validated before persistence');

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
}

testPersistedOpenAIMigration()
  .then(() => console.log('Studio OpenAI GPT Image 2.5 API contract test passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
