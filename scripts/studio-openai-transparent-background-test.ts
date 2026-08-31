import assert from 'node:assert/strict';

import { normalizeOpenAIImageOutputFormat } from '../app/lib/integrations/image-generation-constants';

assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'jpeg'), 'png');
assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'png'), 'png');
assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'webp'), 'webp');
assert.equal(normalizeOpenAIImageOutputFormat('opaque', 'jpeg'), 'jpeg');
assert.equal(normalizeOpenAIImageOutputFormat('auto', undefined), undefined);

console.log('Studio OpenAI transparent background output format test passed');
