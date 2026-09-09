import assert from 'node:assert/strict';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  EMAIL_AGENT_ALLOWED_TOOL_NAMES,
  filterToolsToAllowedNames,
} from '../app/lib/pi/email-agent-policy';
import fs from 'node:fs';
import path from 'node:path';

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  } as AgentTool;
}

assert.deepEqual(EMAIL_AGENT_ALLOWED_TOOL_NAMES.slice(-6), [
  'ls', 'read', 'rg', 'grep', 'glob', 'inspect_document_relations',
]);
assert.deepEqual(
  filterToolsToAllowedNames([
    tool('email_read_message'), tool('email_download_attachment'), tool('read'), tool('write'), tool('bash'), tool('session_search'), tool('list_file_snapshots'),
  ], new Set(EMAIL_AGENT_ALLOWED_TOOL_NAMES)).map((entry) => entry.name),
  ['email_read_message', 'email_download_attachment', 'read'],
);

const emailToolsSource = fs.readFileSync(
  path.join(process.cwd(), 'app', 'lib', 'pi', 'workspace-email-tools.ts'),
  'utf8',
);
assert.match(emailToolsSource, /if \(!context\.workspaceId\)/u);
assert.match(emailToolsSource, /workspaceId: context\.workspaceId/u);
assert.doesNotMatch(emailToolsSource, /workspaceId: mailbox\.workspaceId \|\| context\.workspaceId/u);
assert.match(emailToolsSource, /allAttachments: Type\.Optional\(Type\.Boolean/u);
assert.match(emailToolsSource, /downloadEmailAttachmentBatch/u);
assert.match(emailToolsSource, /saveDownloadedEmailAttachmentsToWorkspace/u);
console.log('email-agent-policy-test: ok');
