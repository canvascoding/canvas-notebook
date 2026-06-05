export type PiToolset =
  | 'audio'
  | 'automation'
  | 'browser'
  | 'composio'
  | 'delegation'
  | 'email'
  | 'file'
  | 'memory'
  | 'mcp'
  | 'session_search'
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
    description: 'Delegate focused tasks to another managed Canvas Agent session.',
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
  session_search: {
    name: 'session_search',
    label: 'Session Search',
    description: 'Browse, search, and read previous Canvas Agent sessions.',
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

const TOOLSET_TOOL_NAMES: Record<PiToolset, Set<string>> = {
  audio: new Set(['transcribe_audio']),
  automation: new Set([
    'create_automation_job',
    'delete_automation_job',
    'list_automation_jobs',
    'trigger_automation_job',
    'update_automation_job',
  ]),
  browser: new Set(['browser']),
  composio: new Set(['composio_execute']),
  delegation: new Set(['delegate_task']),
  email: new Set([
    'email_create_draft',
    'email_list_accounts',
    'email_read',
    'email_search',
    'email_send_draft',
    'email_update_draft',
  ]),
  file: new Set(['apply_patch', 'copy_path', 'delete_path', 'edit_file', 'glob', 'grep', 'list_file_snapshots', 'ls', 'move_path', 'public_share_file', 'read', 'restore_file_snapshot', 'rg', 'write']),
  memory: new Set(['memory']),
  mcp: new Set(['mcp']),
  session_search: new Set(['session_search']),
  studio: new Set([
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
