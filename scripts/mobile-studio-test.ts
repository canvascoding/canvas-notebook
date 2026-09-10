import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  parseMobileStudioGenerationRequest,
  serializeMobileStudioGeneration,
} from '../app/lib/mobile/studio';

const prompt = 'p'.repeat(32_000);
const request = parseMobileStudioGenerationRequest({
  mode: 'image',
  provider: 'openai',
  model: 'gpt-image-2.5-sunburst',
  prompt,
  aspectRatio: '16:9',
  count: 10,
  quality: 'max',
  outputFormat: 'webp',
  background: 'transparent',
  moderation: 'low',
  outputCompression: 42,
  inputFidelity: 'high',
  stream: true,
  partialImages: 3,
  imageSize: '3840x2160',
});

assert.equal(request.prompt, prompt);
assert.equal(request.model, 'gpt-image-2.5-sunburst');
assert.equal(request.count, 10);
assert.equal(request.quality, 'max');
assert.equal(request.output_format, 'webp');
assert.equal(request.background, 'transparent');
assert.equal(request.moderation, 'low');
assert.equal(request.output_compression, 42);
assert.equal(request.input_fidelity, 'high');
assert.equal(request.stream, true);
assert.equal(request.partial_images, 3);
assert.equal(request.image_size, '3840x2160');

assert.throws(() => parseMobileStudioGenerationRequest({
  mode: 'image',
  provider: 'openai',
  prompt: 'invalid streaming options',
  stream: false,
  partialImages: 1,
}), /Partial images require streaming mode/u);

const generation = serializeMobileStudioGeneration({
  id: 'generation-1',
  mode: 'image',
  prompt,
  rawPrompt: prompt,
  studioPresetId: null,
  studioPresetName: null,
  aspectRatio: '16:9',
  provider: 'openai',
  model: 'gpt-image-2.5-sunburst',
  status: 'completed',
  metadata: JSON.stringify({
    count: 10,
    quality: 'max',
    outputFormat: 'webp',
    background: 'transparent',
    imageSize: '3840x2160',
    moderation: 'low',
    outputCompression: 42,
    inputFidelity: 'high',
    stream: true,
    partialImages: 3,
  }),
  product_ids: [],
  persona_ids: [],
  style_ids: [],
  outputs: [],
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
  updatedAt: new Date('2026-09-10T10:00:01.000Z'),
} as never);

assert.equal(generation.prompt.length, 4_000);
assert.equal(generation.fullPrompt, prompt);
assert.equal(generation.settings.count, 4);
assert.equal(generation.settings.quality, 'high');
assert.deepEqual(generation.settings.openAIImage, {
  count: 10,
  quality: 'max',
  outputFormat: 'webp',
  background: 'transparent',
  imageSize: '3840x2160',
  moderation: 'low',
  outputCompression: 42,
  inputFidelity: 'high',
  stream: true,
  partialImages: 3,
});

const mobileStudioSource = readFileSync(path.join(process.cwd(), 'app/lib/mobile/studio.ts'), 'utf8');
assert.match(mobileStudioSource, /qualities: \[\.\.\.LEGACY_MOBILE_QUALITY_OPTIONS\]/u);
assert.match(mobileStudioSource, /maxPromptLength: 32_000/u);
assert.match(mobileStudioSource, /maxOutputCount: getMaxImageCountForProvider\('image', 'openai'\)/u);

console.log('mobile-studio-test: ok');
