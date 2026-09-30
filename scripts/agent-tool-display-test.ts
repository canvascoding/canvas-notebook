import assert from 'node:assert/strict';
import { getToolDisplayInfo } from '../app/lib/pi/tool-display';

for (const name of ['list_agents', 'inspect_agent', 'agent_manage', 'create_agent', 'update_agent_profile',
  'update_agent_runtime', 'update_agent_capabilities', 'update_agent_file', 'set_agent_grant', 'remove_agent_grant',
  'preview_agent_deletion', 'delete_agent']) {
  for (const locale of ['en', 'de']) {
    const display = getToolDisplayInfo(name, locale);
    assert.equal(display.tone, 'agents', `${name} has an agent icon in ${locale}`);
    assert.notEqual(display.label, 'Completed an action');
    assert.notEqual(display.label, 'Aktion ausgeführt');
  }
}
assert.equal(getToolDisplayInfo('agent_manage', 'en', undefined, '{"action":"call","operation":"create_agent"}').label, 'Create agent');
assert.equal(getToolDisplayInfo('agent_manage', 'de', { action: 'call', operation: 'create_agent' }).label, 'Agent erstellen');
assert.equal(getToolDisplayInfo('agent_manage', 'en', { action: 'describe', operation: 'create_agent' }).label, 'Inspect agent action');
assert.equal(getToolDisplayInfo('agent_manage', 'en', undefined, '{"action":"search"}').label, 'Find agent actions');
assert.equal(getToolDisplayInfo('agent_manage', 'en', undefined, '{partial').label, 'Manage agents');
assert.equal(getToolDisplayInfo('read', 'en').label, 'Read a file');
assert.equal(getToolDisplayInfo('write', 'en', { beforeSha256: null }).label, 'Created a file');
console.log('agent tool display tests passed');
