import { type AgentTool } from '@mariozechner/pi-agent-core';

/**
 * Tools allowed in Planning Mode (read-only, no side effects).
 * Whitelist approach: new tools are blocked by default until explicitly added here.
 */
export const PLANNING_MODE_ALLOWED_TOOLS = new Set([
  'web_fetch',
  'rg',
  'ls',
  'read',
  'glob',
  'grep',
  'qmd',
  'list_automation_jobs',
]);

export function filterToolsForPlanningMode(tools: AgentTool[]): AgentTool[] {
  return tools.filter((tool) => PLANNING_MODE_ALLOWED_TOOLS.has(tool.name));
}
