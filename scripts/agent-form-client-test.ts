import assert from 'node:assert/strict';

import {
  getExplicitEnabledToolsFromConfig,
  isExactAgentDeleteConfirmation,
} from '../app/components/agents/agent-form-client';

const tools = [
  { name: 'read_file' },
  { name: 'browser' },
  { name: 'write_file' },
];

assert.equal(getExplicitEnabledToolsFromConfig(tools, null), null);
assert.deepEqual(getExplicitEnabledToolsFromConfig(tools, []), []);
assert.deepEqual(getExplicitEnabledToolsFromConfig(tools, ['write_file']), ['write_file']);
assert.deepEqual(getExplicitEnabledToolsFromConfig(tools, ['__none__']), ['__none__']);

assert.equal(isExactAgentDeleteConfirmation('Marketing Agent', 'Marketing Agent'), true);
assert.equal(isExactAgentDeleteConfirmation('marketing agent', 'Marketing Agent'), false);
assert.equal(isExactAgentDeleteConfirmation(' Marketing Agent ', 'Marketing Agent'), false);
assert.equal(isExactAgentDeleteConfirmation('', 'Marketing Agent'), false);

console.log('agent form client tests passed');
