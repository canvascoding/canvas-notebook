import assert from 'node:assert/strict';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  EMAIL_AGENT_ALLOWED_TOOL_NAMES,
  emailAgentDisallowedToolNames,
  filterToolsToAllowedNames,
} from '../app/lib/pi/email-agent-policy';

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  } as AgentTool;
}

assert.deepEqual(EMAIL_AGENT_ALLOWED_TOOL_NAMES.slice(-6), [
  'ls', 'read', 'rg', 'grep', 'glob', 'inspect_document_relations',
]);
assert.deepEqual(
  filterToolsToAllowedNames([
    tool('email_read_message'), tool('read'), tool('write'), tool('bash'), tool('session_search'), tool('list_file_snapshots'),
  ], new Set(EMAIL_AGENT_ALLOWED_TOOL_NAMES)).map((entry) => entry.name),
  ['email_read_message', 'read'],
);
assert.deepEqual(emailAgentDisallowedToolNames(['read', 'write', 'bash']), ['write', 'bash']);

console.log('email-agent-policy-test: ok');
