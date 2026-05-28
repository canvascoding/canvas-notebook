export type PiToolset =
  | 'automation'
  | 'composio'
  | 'email'
  | 'file'
  | 'mcp'
  | 'session_search'
  | 'studio'
  | 'terminal'
  | 'web';

export type PiToolsetInfo = {
  name: PiToolset;
  label: string;
  description: string;
};

export const PI_TOOLSETS: Record<PiToolset, PiToolsetInfo> = {
  automation: {
    name: 'automation',
    label: 'Automation',
    description: 'Create, update, inspect, and trigger scheduled automation jobs.',
  },
  composio: {
    name: 'composio',
    label: 'Composio',
    description: 'Call connected third-party application tools through Composio.',
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
  web: {
    name: 'web',
    label: 'Web',
    description: 'Fetch and extract public web content.',
  },
};

const TOOLSET_TOOL_NAMES: Record<PiToolset, Set<string>> = {
  automation: new Set([
    'create_automation_job',
    'delete_automation_job',
    'list_automation_jobs',
    'trigger_automation_job',
    'update_automation_job',
  ]),
  composio: new Set(['composio_execute']),
  email: new Set([
    'email_create_draft',
    'email_list_accounts',
    'email_read',
    'email_search',
    'email_send_draft',
    'email_update_draft',
  ]),
  file: new Set(['glob', 'grep', 'ls', 'read', 'rg', 'write']),
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
  web: new Set(['web_fetch']),
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
