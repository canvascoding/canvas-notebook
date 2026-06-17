import 'server-only';

import { listCanvasPlugins, type CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import type { CanvasPluginComposioConnector, CanvasPluginMcpConnector } from '@/app/lib/plugins/canvas-plugin-manifest';

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

function getComposioConnectorHints(plugin: CanvasPluginInstallRecord): string[] {
  const modern = plugin.connectors?.composio || [];
  const legacy: CanvasPluginComposioConnector[] = (plugin.connectors?.composioToolkits || []).map((toolkit) => ({ toolkit, recommended: true }));
  const seen = new Set<string>();
  return [...modern, ...legacy].flatMap((connector) => {
    if (!connector.toolkit || seen.has(connector.toolkit)) return [];
    seen.add(connector.toolkit);
    const label = connector.label ? `${connector.label} (${connector.toolkit})` : connector.toolkit;
    const flags = [
      connector.required ? 'required' : 'recommended',
      connector.tools?.length ? `tools: ${connector.tools.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    const reason = compactLine(connector.reason);
    return [`- Composio ${label}: ${flags}${reason ? ` - ${reason}` : ''}`];
  });
}

function getEmailConnectorHints(plugin: CanvasPluginInstallRecord): string[] {
  return (plugin.connectors?.email || []).map((connector, index) => {
    const label = connector.label || `Email account ${index + 1}`;
    const providers = connector.providers?.length ? connector.providers.join(', ') : 'gmail, imap-smtp';
    const reason = compactLine(connector.reason);
    return `- Canvas Email ${label}: ${connector.required ? 'required' : 'recommended'}; providers: ${providers}${reason ? ` - ${reason}` : ''}`;
  });
}

function getMcpConnectorHints(plugin: CanvasPluginInstallRecord): string[] {
  const modern = plugin.connectors?.mcp || [];
  const legacy: CanvasPluginMcpConnector[] = plugin.connectors?.mcpServers
    ? [{ name: 'mcp', label: 'MCP servers', configPath: plugin.connectors.mcpServers, recommended: true }]
    : [];
  const seen = new Set<string>();
  return [...modern, ...legacy].flatMap((connector) => {
    if (!connector.name || seen.has(connector.name)) return [];
    seen.add(connector.name);
    const label = connector.label ? `${connector.label} (${connector.name})` : connector.name;
    const details = [
      connector.required ? 'required' : 'recommended',
      connector.configPath ? `example config: ${connector.configPath}` : null,
      connector.env?.length ? `env: ${connector.env.join(', ')}` : null,
      connector.oauth ? 'OAuth may be required' : null,
    ].filter(Boolean).join('; ');
    const reason = compactLine(connector.reason);
    return [`- MCP ${label}: ${details}${reason ? ` - ${reason}` : ''}`];
  });
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

  const connectorHints = [
    ...getComposioConnectorHints(plugin),
    ...getEmailConnectorHints(plugin),
    ...getMcpConnectorHints(plugin),
  ];
  if (connectorHints.length > 0) {
    lines.push('Recommended connector hints (not automatically installed):');
    lines.push(...connectorHints);
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
