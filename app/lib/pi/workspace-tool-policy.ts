import type { AgentTool } from '@earendil-works/pi-agent-core';

import type { AgentExecutionContext } from './agent-execution-context';
import { filterToolsToAllowedNames } from './email-agent-policy';
import { isProgressiveGatewayTool } from './progressive-tool-gateway';

const WRITE_WORKSPACE_TOOL_NAMES = new Set([
  'write',
  'edit_file',
  'apply_patch',
  'restore_file_snapshot',
  'copy_path',
  'move_path',
  'create_pdf',
  'pdf_to_markdown',
  'split_pdf',
  'edit_pdf_pages',
]);
const DELETE_WORKSPACE_TOOL_NAMES = new Set(['delete_path', 'move_path']);
const SHARE_WORKSPACE_TOOL_NAMES = new Set(['public_share_file']);

/**
 * Hide workspace-mutating schemas when the session's resolved permission
 * context cannot authorize them. Individual tools still revalidate at call
 * time to protect against a permission change after the turn starts.
 */
export function filterToolsForWorkspacePermissions(
  tools: AgentTool[],
  context: Pick<AgentExecutionContext, 'canWrite' | 'canDelete' | 'canShare'>,
): AgentTool[] {
  const disallowed = new Set<string>();
  if (!context.canWrite) {
    for (const name of WRITE_WORKSPACE_TOOL_NAMES) disallowed.add(name);
  }
  if (!context.canDelete) {
    for (const name of DELETE_WORKSPACE_TOOL_NAMES) disallowed.add(name);
  }
  if (!context.canShare) {
    for (const name of SHARE_WORKSPACE_TOOL_NAMES) disallowed.add(name);
  }
  if (disallowed.size === 0) return tools;
  return filterToolsToAllowedNames(tools, new Set(
    tools
      .flatMap((tool) => isProgressiveGatewayTool(tool)
        ? tool.progressiveGateway.operations.map((operation) => operation.name)
        : [tool.name])
      .filter((name) => !disallowed.has(name)),
  ));
}
