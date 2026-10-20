import assert from 'node:assert/strict';
import referenceMatcherFixtures from '../tests/fixtures/chat/composer-reference-matcher.json';

import {
  findActiveComposerReference,
  replaceComposerReference,
} from '../app/lib/chat/composer-references';
import { filterSkillsForAgent } from '../app/lib/chat/reference-capabilities';

assert.equal(referenceMatcherFixtures.schemaVersion, 1);
assert.ok(referenceMatcherFixtures.cases.length > 0);
assert.equal(new Set(referenceMatcherFixtures.cases.map(fixture => fixture.id)).size, referenceMatcherFixtures.cases.length);
for (const fixture of referenceMatcherFixtures.cases) {
  assert.deepEqual(findActiveComposerReference(fixture.value, fixture.cursorPosition), fixture.expected, `Shared reference matcher fixture: ${fixture.id}`);
}

assert.deepEqual(
  replaceComposerReference('Use +annual report now', {
    kind: 'all',
    trigger: '+',
    query: 'annual report',
    startIndex: 4,
    endIndex: 18,
  }, '@"reports/annual report.md" '),
  {
    nextValue: 'Use @"reports/annual report.md"  now',
    nextCursorPosition: 32,
  },
);

const skills = [
  { name: 'core', enabled: true, core: true },
  { name: 'selected', enabled: true },
  { name: 'other', enabled: true },
  { name: 'disabled', enabled: false },
];

assert.deepEqual(
  filterSkillsForAgent(skills, {
    agentId: 'canvas-agent',
    defaultAgentId: 'canvas-agent',
    relevantSkillNames: [],
  }).map((skill) => skill.name),
  ['core', 'selected', 'other'],
);
assert.deepEqual(
  filterSkillsForAgent(skills, {
    agentId: 'specialist',
    defaultAgentId: 'canvas-agent',
    relevantSkillNames: [],
  }).map((skill) => skill.name),
  ['core'],
);
assert.deepEqual(
  filterSkillsForAgent(skills, {
    agentId: 'specialist',
    defaultAgentId: 'canvas-agent',
    relevantSkillNames: ['selected'],
  }).map((skill) => skill.name),
  ['core', 'selected'],
);

console.log(`chat composer references test passed (${referenceMatcherFixtures.cases.length} shared matcher fixtures)`);
