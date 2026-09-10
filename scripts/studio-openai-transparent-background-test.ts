import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  OPENAI_IMAGE_MODEL_ID,
  OPENAI_MODELS,
  QUALITY_OPTIONS,
  getMaxImageCountForProvider,
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
