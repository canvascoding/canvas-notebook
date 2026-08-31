import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeOpenAIImageOutputFormat } from '../app/lib/integrations/image-generation-constants';

assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'jpeg'), 'png');
assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'png'), 'png');
assert.equal(normalizeOpenAIImageOutputFormat('transparent', 'webp'), 'webp');
assert.equal(normalizeOpenAIImageOutputFormat('opaque', 'jpeg'), 'jpeg');
assert.equal(normalizeOpenAIImageOutputFormat('auto', undefined), undefined);

const studioToolSource = readFileSync(path.join(process.cwd(), 'app/lib/pi/studio-tools.ts'), 'utf8');
assert.match(studioToolSource, /For a transparent background, use png \(recommended\) or webp; jpeg does not support transparency\./);
assert.match(studioToolSource, /set this to transparent and set output_format to png \(recommended\) or webp\./);

console.log('Studio OpenAI transparent background output format test passed');
