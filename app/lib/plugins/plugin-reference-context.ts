import 'server-only';

import { listCanvasPlugins, type CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';

const PLUGIN_REFERENCE_PATTERN = /(^|[\s([{"'`,;])\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s)\]}",.;:!?])/g;
const MAX_REFERENCED_PLUGINS = 5;
const MAX_DEFAULT_PROMPTS = 5;
const MAX_LINE_LENGTH = 420;

function extractSlashReferenceNames(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(PLUGIN_REFERENCE_PATTERN)) {
    const name = match[2];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

function compactLine(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= MAX_LINE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_LINE_LENGTH - 1).trimEnd()}...`;
}

function formatPluginContext(plugin: CanvasPluginInstallRecord): string {
  const displayName = plugin.interface?.displayName || plugin.name;
  const lines = [
    `### /${plugin.name} (${displayName}, v${plugin.version})`,
    compactLine(plugin.interface?.shortDescription || plugin.description) || plugin.description,
  ];

  if (plugin.interface?.category) {
    lines.push(`Category: ${plugin.interface.category}`);
  }

  if (plugin.interface?.defaultPrompt?.length) {
    lines.push('Default prompts:');
    for (const prompt of plugin.interface.defaultPrompt.slice(0, MAX_DEFAULT_PROMPTS)) {
      const compactPrompt = compactLine(prompt);
      if (compactPrompt) {
        lines.push(`- ${compactPrompt}`);
      }
    }
  }

  if (plugin.skills.length > 0) {
    lines.push('Bundled skills and workflows:');
    for (const skill of plugin.skills) {
      const description = compactLine(skill.description);
      lines.push(`- /${skill.name}: ${skill.title}${description ? ` - ${description}` : ''}`);
    }
  }

  const composioToolkits = plugin.connectors?.composioToolkits || [];
  const mcpServers = plugin.connectors?.mcpServers;
  if (mcpServers || composioToolkits.length > 0) {
    lines.push('Connector hints:');
    if (mcpServers) {
      lines.push(`- MCP servers manifest path inside plugin: ${mcpServers}`);
    }
    if (composioToolkits.length > 0) {
      lines.push(`- Composio toolkits: ${composioToolkits.join(', ')}`);
    }
  }

  return lines.join('\n');
}

export async function buildReferencedPluginRuntimeContext(content: string): Promise<string | null> {
  const referenceNames = extractSlashReferenceNames(content);
  if (referenceNames.length === 0) {
    return null;
  }

  const plugins = await listCanvasPlugins();
  const enabledPluginsByName = new Map(
    plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => [plugin.name, plugin] as const),
  );
  const referencedPlugins = referenceNames
    .map((name) => enabledPluginsByName.get(name))
    .filter((plugin): plugin is CanvasPluginInstallRecord => Boolean(plugin))
    .slice(0, MAX_REFERENCED_PLUGINS);

  if (referencedPlugins.length === 0) {
    return null;
  }

  return [
    '## Referenced Canvas Plugins',
    'The user explicitly referenced these installed Canvas Plugins in the latest message. Treat them as strong workflow and connector hints for this turn.',
    ...referencedPlugins.map(formatPluginContext),
  ].join('\n\n');
}
