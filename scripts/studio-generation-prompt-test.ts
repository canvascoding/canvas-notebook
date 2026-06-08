import assert from 'node:assert/strict';

import {
  extractStudioUserPrompt,
  getStudioUserPrompt,
} from '../app/apps/studio/utils/studio-generation-prompt';

const userPrompt = 'A clean product photo on a white pedestal';
const presetPrompt = [
  '## Preset - Visual Setting',
  'softbox key light, 85mm lens, muted studio backdrop',
  '',
  '## Instructions',
  '',
  userPrompt,
].join('\n');

assert.equal(extractStudioUserPrompt(userPrompt), userPrompt);
assert.equal(extractStudioUserPrompt(presetPrompt), userPrompt);
assert.equal(
  getStudioUserPrompt({
    prompt: presetPrompt,
    rawPrompt: 'Original user input',
  }),
  'Original user input',
);
assert.equal(
  getStudioUserPrompt({
    prompt: presetPrompt,
    rawPrompt: null,
  }),
  userPrompt,
);
assert.equal(
  getStudioUserPrompt({
    prompt: null,
    rawPrompt: null,
  }, 'No prompt'),
  'No prompt',
);

console.log('Studio generation prompt display test passed');
