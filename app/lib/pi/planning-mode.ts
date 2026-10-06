import { type AgentTool } from '@earendil-works/pi-agent-core';

/**
 * Tools allowed in Planning Mode (read-only, no side effects).
 * Whitelist approach: new tools are blocked by default until explicitly added here.
 */
export const PLANNING_MODE_ALLOWED_TOOLS = new Set([
  'list_canvas_skill_scripts',
  'describe_canvas_skill_script',
  'inspect_canvas_package',
  'list_canvas_package_scopes',
  'inspect_canvas_package_draft',
  'list_canvas_package_draft_files',
  'read_canvas_package_draft_file',
  'list_canvas_package_files',
  'read_canvas_package_file',
  'validate_canvas_package_draft',
  'web_search',
  'web_fetch',
  'rg',
  'ls',
  'read',
  'inspect_document_relations',
  'list_file_snapshots',
  'glob',
  'grep',
  'session_search',
  'qmd',
  'list_automation_jobs',
  'inspect_automation_job',
  'inspect_automation_job_options',
  'list_agents',
  'inspect_agent',
  'inspect_agent_workflow',
  'list_agent_workflow_options',
  'list_human_todos',
  'inspect_human_todo',
]);

export function filterToolsForPlanningMode(tools: AgentTool[]): AgentTool[] {
  return tools.filter((tool) => PLANNING_MODE_ALLOWED_TOOLS.has(tool.name));
}
