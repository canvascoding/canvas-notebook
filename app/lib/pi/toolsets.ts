export type PiToolset =
  | 'agents'
  | 'audio'
  | 'automation'
  | 'browser'
  | 'composio'
  | 'delegation'
  | 'email'
  | 'file'
  | 'memory'
  | 'mcp'
  | 'pdf'
  | 'session_search'
  | 'skills'
  | 'studio'
  | 'terminal'
  | 'todo'
  | 'web';

export type PiToolsetInfo = {
  name: PiToolset;
  label: string;
  description: string;
};

export const PI_TOOLSETS: Record<PiToolset, PiToolsetInfo> = {
  agents: {
    name: 'agents',
    label: 'Agents',
    description: 'Inspect, create, configure, share, and delete managed personal or organization agents.',
  },
  audio: {
    name: 'audio',
    label: 'Audio',
    description: 'Transcribe local audio files into text.',
  },
  automation: {
    name: 'automation',
    label: 'Automation',
    description: 'Create, update, inspect, and trigger scheduled automation jobs.',
  },
  browser: {
    name: 'browser',
    label: 'Browser',
    description: 'Control a managed headless Chromium browser for JavaScript-rendered pages and UI verification.',
  },
  composio: {
    name: 'composio',
    label: 'Composio',
    description: 'Call connected third-party application tools through Composio.',
  },
  delegation: {
    name: 'delegation',
    label: 'Delegation',
    description: 'Delegate focused tasks to another managed agent session.',
  },
  email: {
    name: 'email',
    label: 'Email',
    description: 'Read, search, draft, update, and send managed email.',
  },
  file: {
    name: 'file',
    label: 'File',
    description: 'Read, write, list, and search local workspace or agent files.',
  },
  memory: {
    name: 'memory',
    label: 'Memory',
    description: 'Read and maintain durable agent or user memory.',
  },
  mcp: {
    name: 'mcp',
    label: 'MCP',
    description: 'Discover and call tools exposed by configured MCP servers.',
  },
  pdf: {
    name: 'pdf',
    label: 'PDF',
    description: 'Create PDFs from Markdown, convert PDFs to semantic Markdown, split PDFs, and edit PDF pages.',
  },
  session_search: {
    name: 'session_search',
    label: 'Session Search',
    description: 'Browse, search, and read previous agent sessions.',
  },
  skills: {
    name: 'skills',
    label: 'Plugins & Skills',
    description: 'Create, inspect, install, update, activate, and remove personal Canvas plugins and skills.',
  },
  studio: {
    name: 'studio',
    label: 'Studio',
    description: 'Generate media and inspect Studio products, personas, styles, and presets.',
  },
  terminal: {
    name: 'terminal',
    label: 'Terminal',
    description: 'Execute shell commands in the agent runtime environment.',
  },
  todo: {
    name: 'todo',
    label: 'To-do',
    description: 'Create human-visible to-dos for review, approval, follow-up, or offline work.',
  },
  web: {
    name: 'web',
    label: 'Web',
    description: 'Search the public web and fetch readable web content.',
  },
};

/** Toolsets that may be granted to a delegated worker. */
export const DELEGATABLE_PI_TOOLSETS = new Set<PiToolset>([
  'audio', 'automation', 'browser', 'composio', 'email', 'file', 'memory',
  'mcp', 'pdf', 'session_search', 'skills', 'studio', 'terminal', 'todo', 'web',
]);

export const SKILL_TOOL_NAMES = [
  'create_canvas_plugin_draft',
  'inspect_canvas_plugin',
  'install_canvas_plugin_from_workspace',
  'remove_canvas_plugin',
  'set_canvas_plugin_enabled',
  'update_canvas_plugin_from_workspace',
  'create_canvas_skill_draft',
  'discard_canvas_skill_draft',
  'inspect_canvas_skill',
  'install_canvas_skill_from_workspace',
  'update_canvas_skill_from_workspace',
] as const;

const TOOLSET_TOOL_NAMES: Record<PiToolset, Set<string>> = {
  agents: new Set([
    'agent_manage',
    'list_agents',
    'inspect_agent',
    'create_agent',
    'update_agent_profile',
    'update_agent_runtime',
    'update_agent_capabilities',
    'update_agent_file',
    'set_agent_grant',
    'remove_agent_grant',
    'preview_agent_deletion',
    'delete_agent',
  ]),
  audio: new Set(['transcribe_audio']),
  automation: new Set([
    'automation_manage',
    'create_automation_job',
    'delete_automation_job',
    'inspect_automation_job',
    'list_automation_jobs',
    'trigger_automation_job',
    'update_automation_job',
  ]),
  browser: new Set(['browser']),
  composio: new Set(['composio', 'composio_execute']),
  delegation: new Set(['delegate_task']),
  email: new Set([
    'email_create_or_update_case',
    'email_create_outbox_draft',
    'email_list_cases',
    'email_list_mailboxes',
    'email_list_outbox_drafts',
    'email_list_thread_messages',
    'email_read_message',
    'email_search_messages',
    'email_update_outbox_draft',
  ]),
  file: new Set(['apply_patch', 'copy_path', 'delete_path', 'edit_excalidraw_scene', 'edit_file', 'glob', 'grep', 'inspect_document_relations', 'list_file_snapshots', 'ls', 'move_path', 'public_share_file', 'read', 'restore_file_snapshot', 'rg', 'write']),
  memory: new Set(['memory']),
  mcp: new Set(['mcp']),
  pdf: new Set(['create_pdf', 'pdf_to_markdown', 'split_pdf', 'edit_pdf_pages']),
  session_search: new Set(['session_search']),
  skills: new Set([...SKILL_TOOL_NAMES, 'canvas_extensions']),
  studio: new Set([
    'studio',
    'studio_bulk_generate',
    'studio_generate_image',
    'studio_generate_sound',
    'studio_generate_video',
    'studio_list_personas',
    'studio_list_presets',
    'studio_list_products',
    'studio_list_styles',
  ]),
  terminal: new Set(['bash']),
  todo: new Set(['create_human_todo']),
  web: new Set(['web_search', 'web_fetch']),
};

export function getPiToolsetsForTool(toolName: string): PiToolset[] {
  const toolsets = Object.entries(TOOLSET_TOOL_NAMES)
    .filter(([, names]) => names.has(toolName))
    .map(([toolset]) => toolset as PiToolset);

  if (toolName.startsWith('mcp_') && !toolsets.includes('mcp')) {
    toolsets.push('mcp');
  }
  if (toolName.startsWith('COMPOSIO_') && !toolsets.includes('composio')) {
    toolsets.push('composio');
  }

  return toolsets;
}

export function resolvePiToolsetTools(toolsets: Iterable<string>, allToolNames: Iterable<string>): Set<string> {
  const allToolNameSet = new Set(allToolNames);
  const resolved = new Set<string>();

  for (const rawToolset of toolsets) {
    const toolset = rawToolset.trim() as PiToolset;
    const names = TOOLSET_TOOL_NAMES[toolset];
    if (!names) {
      continue;
    }
    for (const name of names) {
      if (allToolNameSet.has(name)) {
        resolved.add(name);
      }
    }
  }

  return resolved;
}

export function resolveDelegatedWorkerToolNames(
  toolsets: Iterable<string>,
  allToolNames: Iterable<string>,
): Set<string> {
  return resolvePiToolsetTools(
    [...toolsets].filter((toolset): toolset is PiToolset => DELEGATABLE_PI_TOOLSETS.has(toolset as PiToolset)),
    allToolNames,
  );
}
