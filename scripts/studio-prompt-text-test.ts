import assert from 'node:assert/strict';
import { normalizeStudioPrompt } from '../app/lib/integrations/studio-prompt';
import {
  MobileStudioError,
  parseMobileStudioGenerationRequest,
  serializeMobileStudioGeneration,
} from '../app/lib/mobile/studio';

const expected = 'Überblick 🖼️\n\n\t- Licht: weich\n- Hintergrund: blau';
const inputs = [expected, expected.replace(/\n/gu, '\r\n'), expected.replace(/\n/gu, '\r')];
for (const input of inputs) {
  assert.equal(normalizeStudioPrompt(`  \t${input}\n `), expected);
  for (const mode of ['image', 'video', 'sound'] as const) {
    const provider = mode === 'video' ? 'veo' : 'gemini';
    assert.equal(parseMobileStudioGenerationRequest({ mode, provider, prompt: input }).prompt, expected);
  }
}
for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
  if ([9, 10, 13].includes(code)) continue;
  for (const input of [`a${String.fromCharCode(code)}b`, `${String.fromCharCode(code)}text`, `text${String.fromCharCode(code)}`]) {
    assert.equal(normalizeStudioPrompt(input), null, `Control character ${code} must fail before trim`);
    assert.throws(() => parseMobileStudioGenerationRequest({ prompt: input }), (error: unknown) => (
      error instanceof MobileStudioError && error.status === 400 && error.code === 'INVALID_STUDIO_REQUEST'
    ));
  }
}
for (const input of [false, 3, {}, []]) {
  assert.equal(normalizeStudioPrompt(input), null);
  assert.throws(() => parseMobileStudioGenerationRequest({ prompt: input }), /Prompt is invalid/);
}
assert.equal(normalizeStudioPrompt(' \r\n\t '), '');
assert.throws(() => parseMobileStudioGenerationRequest({ prompt: ' \r\n\t ' }), /prompt or at least one reference/i);
assert.throws(() => parseMobileStudioGenerationRequest({
  mode: 'sound', prompt: '', references: [{ kind: 'image', path: 'studio/fixture.png' }],
}), /Sound generation requires a prompt/);
assert.equal(parseMobileStudioGenerationRequest({
  prompt: '', references: [{ kind: 'image', path: 'studio/fixture.png' }],
}).prompt, '');
assert.equal(parseMobileStudioGenerationRequest({ productIds: ['product-1'] }).prompt, '');
assert.throws(() => parseMobileStudioGenerationRequest({ prompt: 'Valid', presetId: 'preset\ninvalid' }), /Preset is invalid/);
assert.throws(() => parseMobileStudioGenerationRequest({
  prompt: 'Valid', references: [{ kind: 'image', path: 'studio/invalid\tpath.png' }],
}), /Reference path is invalid/);

const windowsBoundary = `${'p'.repeat(3_998)}\r\nb`;
assert.equal(parseMobileStudioGenerationRequest({ prompt: windowsBoundary }).prompt.length, 4_000);
assert.throws(() => parseMobileStudioGenerationRequest({ prompt: windowsBoundary + 'x' }), /Prompt is invalid/);
const longPrompt = `${expected}\n${'p'.repeat(32_000 - expected.length - 1)}`;
assert.equal(parseMobileStudioGenerationRequest({ provider: 'openai', prompt: longPrompt }).prompt, longPrompt);
assert.throws(() => parseMobileStudioGenerationRequest({ provider: 'openai', prompt: longPrompt + 'x' }), /Prompt is invalid/);
const serialized = serializeMobileStudioGeneration({
  id: 'prompt-fixture', mode: 'image', prompt: `Preset instructions\n\n${longPrompt}`, rawPrompt: longPrompt,
  studioPresetId: null, studioPresetName: null, aspectRatio: '1:1', provider: 'openai', model: 'gpt-image-2.5-sunburst',
  status: 'completed', metadata: '{}', product_ids: [], persona_ids: [], style_ids: [], outputs: [],
  createdAt: new Date('2026-10-16T12:00:00Z'), updatedAt: new Date('2026-10-16T12:00:00Z'),
} as never);
assert.equal(serialized.fullPrompt, longPrompt);
assert.equal(serialized.prompt, longPrompt.slice(0, 4_000));
console.log('Studio prompt text normalization, mobile request and response checks passed.');
