import assert from 'node:assert/strict';

import {
  findActiveComposerReference,
  replaceComposerReference,
} from '../app/lib/chat/composer-references';
import { filterSkillsForAgent } from '../app/lib/chat/reference-capabilities';

assert.deepEqual(findActiveComposerReference('+', 1), {
  kind: 'all',
  trigger: '+',
  query: '',
  startIndex: 0,
  endIndex: 1,
});
assert.equal(findActiveComposerReference('+annual report', 14)?.query, 'annual report');
assert.equal(findActiveComposerReference('@annual', 7)?.kind, 'file');
assert.equal(findActiveComposerReference('/pdf', 4)?.kind, 'capability');
assert.equal(findActiveComposerReference('person@example.com', 18), null);
assert.equal(findActiveComposerReference('https://example.com', 19), null);
assert.equal(findActiveComposerReference('2 + 2', 5), null);
assert.equal(findActiveComposerReference('C++', 3), null);

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

console.log('chat composer references test passed');
