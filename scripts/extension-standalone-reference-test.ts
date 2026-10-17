import assert from 'node:assert/strict';
import {
  createStandaloneExtensionSlotRef,
  isStandaloneExtensionSlotRef,
  type StandaloneExtensionSlot,
} from '../app/lib/capabilities/extensions/standalone-reference';

const sharedSlot: StandaloneExtensionSlot = {
  configurationId: 'marketing-linkedin', source: 'composio', toolkit: 'linkedin',
};
const reference = createStandaloneExtensionSlotRef(sharedSlot);
assert.equal(isStandaloneExtensionSlotRef(reference), true);
assert.equal(createStandaloneExtensionSlotRef({ ...sharedSlot }), reference,
  'A reconstructed configuration keeps its user preference slot.');
assert.notEqual(createStandaloneExtensionSlotRef({ ...sharedSlot, toolkit: 'canva' }), reference,
  'Another application must not reuse the old account preference slot.');
assert.notEqual(createStandaloneExtensionSlotRef({ ...sharedSlot, configurationId: 'private-linkedin' }), reference,
  'Two explicitly configured instances of one app remain separate slots.');
assert.notEqual(createStandaloneExtensionSlotRef({ configurationId: sharedSlot.configurationId, source: 'mcp' }), reference,
  'A direct server cannot reuse a managed app slot.');
assert.equal(isStandaloneExtensionSlotRef('agent-capability:' + 'a'.repeat(43)), false,
  'Standalone choices do not masquerade as package-declared capabilities.');
assert.equal(isStandaloneExtensionSlotRef(reference + '\n'), false);
assert.equal(isStandaloneExtensionSlotRef(null), false);

for (const invalid of [
  { ...sharedSlot, accountId: 'first-account' },
  { ...sharedSlot, providerRef: 'composio:v1:anything' },
  { ...sharedSlot, toolkit: 'LinkedIn' },
  { ...sharedSlot, toolkit: 'linkedin\n' },
  { ...sharedSlot, configurationId: ' marketing-linkedin' },
  { ...sharedSlot, configurationId: '' },
  { ...sharedSlot, configurationId: 'marketing\u200blinkedin' },
  { ...sharedSlot, configurationId: 'x'.repeat(257) },
  { configurationId: 'mcp', source: 'mcp', toolkit: 'linkedin' },
  { configurationId: 'mcp', source: 'unknown' },
]) {
  assert.throws(() => createStandaloneExtensionSlotRef(invalid as StandaloneExtensionSlot));
}
console.log('EXTENSION_STANDALONE_REFERENCE_PASS');
