import assert from 'node:assert/strict';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { filterToolsForWorkspacePermissions } from '../app/lib/pi/workspace-tool-policy';

function tool(name: string): AgentTool {
  return { name, label: name, description: name, parameters: {}, execute: async () => ({ content: [], details: {} }) } as AgentTool;
}

const readOnly = filterToolsForWorkspacePermissions(
  [
    'read',
    'write',
    'edit_file',
    'delete_path',
    'move_path',
    'public_share_file',
    'create_pdf',
    'create_human_todo',
    'list_human_todos',
    'inspect_human_todo',
    'update_human_todo',
  ].map(tool),
  { canWrite: false, canDelete: false, canShare: false },
).map((entry) => entry.name);
assert.deepEqual(readOnly, ['read', 'list_human_todos', 'inspect_human_todo']);

const writableNoDelete = filterToolsForWorkspacePermissions(
  ['read', 'write', 'delete_path', 'move_path', 'public_share_file'].map(tool),
  { canWrite: true, canDelete: false, canShare: false },
).map((entry) => entry.name);
assert.deepEqual(writableNoDelete, ['read', 'write']);

console.log('workspace-tool-policy-test: ok');
