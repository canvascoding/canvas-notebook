import 'server-only';

import type { CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import type {
  CanvasPluginStorePluginWithState,
  CanvasPluginStorePreflight,
} from '@/app/lib/plugins/canvas-plugin-store';
import {
  normalizeComposioConnectors,
  normalizeEmailConnectors,
  normalizeMcpConnectors,
} from '@/app/lib/plugins/plugin-connection-readiness';
import { readCanvasSkillStoreRegistry } from '@/app/lib/skills/canvas-skill-store';

export type MobileExtensionIcon = {
  url?: string;
  brandColor?: string;
  initials: string;
};

export type MobilePluginContentSummary = {
  skills: number;
  apps: number;
  mcpServers: number;
  emailConnections: number;
  total: number;
};

export type MobilePluginSummary = {
  name: string;
  displayName: string;
  description: string;
  category?: string;
  icon: MobileExtensionIcon;
  contents: MobilePluginContentSummary;
  state: {
    installed: boolean;
    enabled: boolean;
    installedVersion?: string;
    latestVersion: string;
    updateAvailable: boolean;
    repairAvailable: boolean;
    readiness?: CanvasPluginInstallRecord['readiness'];
    scope?: CanvasPluginInstallRecord['scopeType'];
  };
};

export type MobilePluginDetail = MobilePluginSummary & {
  publisher?: {
    name?: string;
    url?: string;
  };
  release: {
    version: string;
    releasedAt?: string;
    minCanvasVersion?: string;
    notes?: string;
  };
  skills: Array<{
    name: string;
    displayName: string;
    description: string;
    icon: MobileExtensionIcon;
    installed: boolean;
    enabled?: boolean;
    status: CanvasPluginStorePluginWithState['installed']['skills'][number]['status'];
    updateAvailable: boolean;
    repairable: boolean;
  }>;
  connections: Array<{
    type: 'composio' | 'email' | 'mcp';
    key: string;
    label: string;
    description?: string;
    required: boolean;
    icon: MobileExtensionIcon;
  }>;
};

export type MobilePluginPreflight = {
  pluginName: string;
  version: string;
  ready: boolean;
  hasRequiredMissing: boolean;
  hasSkillIssues: boolean;
  items: Array<{
    type: 'composio' | 'email' | 'mcp';
    key: string;
    label: string;
    required: boolean;
    ready: boolean;
    available?: boolean;
    connected?: boolean;
    configured?: boolean;
    reason?: string;
    details?: string[];
    action: 'none' | 'configure-composio' | 'connect-composio' | 'configure-email' | 'configure-mcp';
    icon: MobileExtensionIcon;
  }>;
  summary: CanvasPluginStorePreflight['summary'];
  skillSummary: CanvasPluginStorePreflight['skillSummary'];
};

function installedPluginScopePriority(plugin: CanvasPluginInstallRecord): number {
  // A personal workspace opens the personal plugin detail route, so keep that
  // installation when both scopes contain the same package.
  if (plugin.scopeType === 'user') return 0;
  if (plugin.scopeType === 'organization') return 1;
  return 2;
}

/**
 * The effective capability snapshot can include a personal and organization
 * installation of the same package. Mobile presents packages, not their
 * per-scope installation records, so expose one stable entry per name.
 */
export function deduplicateMobileInstalledPlugins(
  plugins: CanvasPluginInstallRecord[],
): CanvasPluginInstallRecord[] {
  const byName = new Map<string, CanvasPluginInstallRecord>();
  for (const plugin of plugins) {
    const key = plugin.name.toLowerCase();
    const current = byName.get(key);
    if (!current || installedPluginScopePriority(plugin) < installedPluginScopePriority(current)) {
      byName.set(key, plugin);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function initialsFor(value: string): string {
  const words = value
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
}

function marketplaceIcon(plugin: CanvasPluginStorePluginWithState): MobileExtensionIcon {
  return {
    url: plugin.iconUrl
      ? `/api/mobile/v1/extensions/plugins/store/${encodeURIComponent(plugin.name)}/icon`
      : undefined,
    brandColor: plugin.brandColor,
    initials: initialsFor(plugin.displayName),
  };
}

function installedIcon(plugin: CanvasPluginInstallRecord): MobileExtensionIcon {
  const iconPath = plugin.interface?.icon || plugin.interface?.logo;
  const scopeQuery = plugin.scopeType ? `&scope=${encodeURIComponent(plugin.scopeType)}` : '';
  return {
    url: iconPath
      ? `/api/mobile/v1/extensions/plugins/asset?plugin=${encodeURIComponent(plugin.name)}&path=${encodeURIComponent(iconPath)}${scopeQuery}`
      : undefined,
    brandColor: plugin.interface?.brandColor,
    initials: initialsFor(plugin.interface?.displayName || plugin.name),
  };
}

function contentSummary(plugin: Pick<CanvasPluginStorePluginWithState, 'skills' | 'connectors'>): MobilePluginContentSummary {
  const skills = plugin.skills?.length || 0;
  const apps = normalizeComposioConnectors(plugin.connectors).length;
  const mcpServers = normalizeMcpConnectors(plugin.connectors).length;
  const emailConnections = normalizeEmailConnectors(plugin.connectors).length;
  return {
    skills,
    apps,
    mcpServers,
    emailConnections,
    total: skills + apps + mcpServers + emailConnections,
  };
}

export function serializeMobilePluginSummary(
  plugin: CanvasPluginStorePluginWithState,
): MobilePluginSummary {
  const installed = plugin.installed.installedPlugin;
  return {
    name: plugin.name,
    displayName: plugin.displayName,
    description: plugin.description,
    category: plugin.category,
    icon: marketplaceIcon(plugin),
    contents: contentSummary(plugin),
    state: {
      installed: plugin.installed.installed,
      enabled: plugin.installed.enabled,
      installedVersion: plugin.installed.version,
      latestVersion: plugin.latestVersion,
      updateAvailable: plugin.installed.updateAvailable,
      repairAvailable: plugin.installed.skillSummary.repairable > 0,
      readiness: installed?.readiness,
      scope: installed?.scopeType,
    },
  };
}

export async function serializeMobilePluginDetail(
  plugin: CanvasPluginStorePluginWithState,
): Promise<MobilePluginDetail> {
  const skillRegistry = await readCanvasSkillStoreRegistry().catch(() => null);
  const skillByName = new Map((skillRegistry?.skills || []).map((skill) => [skill.name, skill]));
  const installedSkillByName = new Map(plugin.installed.skills.map((skill) => [skill.name, skill]));
  const composio = normalizeComposioConnectors(plugin.connectors);
  const email = normalizeEmailConnectors(plugin.connectors);
  const mcp = normalizeMcpConnectors(plugin.connectors);
  const latestRelease = plugin.versions[plugin.latestVersion];

  return {
    ...serializeMobilePluginSummary(plugin),
    publisher: plugin.publisher,
    release: {
      version: plugin.latestVersion,
      releasedAt: latestRelease?.releasedAt,
      minCanvasVersion: latestRelease?.minCanvasVersion,
      notes: latestRelease?.notes,
    },
    skills: (plugin.skills || []).map((name) => {
      const storeSkill = skillByName.get(name);
      const installedSkill = installedSkillByName.get(name);
      const displayName = storeSkill?.displayName || installedSkill?.title || name;
      return {
        name,
        displayName,
        description: storeSkill?.description || '',
        icon: {
          brandColor: storeSkill?.brandColor || plugin.brandColor,
          initials: initialsFor(displayName),
        },
        installed: installedSkill?.installed || false,
        enabled: installedSkill?.enabled,
        status: installedSkill?.status || 'missing',
        updateAvailable: installedSkill?.updateAvailable || false,
        repairable: installedSkill?.repairable || false,
      };
    }),
    connections: [
      ...composio.map((connector) => ({
        type: 'composio' as const,
        key: connector.toolkit,
        label: connector.label || connector.toolkit,
        description: connector.reason,
        required: connector.required === true,
        icon: { initials: initialsFor(connector.label || connector.toolkit) },
      })),
      ...email.map((connector, index) => ({
        type: 'email' as const,
        key: connector.label || `email-${index}`,
        label: connector.label || 'Email account',
        description: connector.reason,
        required: connector.required === true,
        icon: { initials: initialsFor(connector.label || 'Email account') },
      })),
      ...mcp.map((connector) => ({
        type: 'mcp' as const,
        key: connector.name,
        label: connector.label || connector.name,
        description: connector.reason,
        required: connector.required === true,
        icon: {
          url: `/api/mobile/v1/integrations/mcp-icon/${encodeURIComponent(connector.name)}`,
          initials: initialsFor(connector.label || connector.name),
        },
      })),
    ],
  };
}

export function serializeMobilePluginPreflight(
  preflight: CanvasPluginStorePreflight,
): MobilePluginPreflight {
  return {
    pluginName: preflight.pluginName,
    version: preflight.version,
    ready: preflight.ready,
    hasRequiredMissing: preflight.hasRequiredMissing,
    hasSkillIssues: preflight.hasSkillIssues,
    items: preflight.items.map((item) => ({
      type: item.type,
      key: item.key,
      label: item.label,
      required: item.required,
      ready: item.ready,
      available: item.available,
      connected: item.connected,
      configured: item.configured,
      reason: item.reason,
      details: item.details,
      action: item.action,
      icon: {
        url: item.logo || (item.type === 'mcp'
          ? `/api/mobile/v1/integrations/mcp-icon/${encodeURIComponent(item.key)}`
          : undefined),
        initials: initialsFor(item.label),
      },
    })),
    summary: preflight.summary,
    skillSummary: preflight.skillSummary,
  };
}

export function serializeMobileInstalledPlugin(
  plugin: CanvasPluginInstallRecord,
): MobilePluginSummary {
  const skills = plugin.skills.length;
  const apps = normalizeComposioConnectors(plugin.connectors).length;
  const mcpServers = normalizeMcpConnectors(plugin.connectors).length;
  const emailConnections = normalizeEmailConnectors(plugin.connectors).length;
  return {
    name: plugin.name,
    displayName: plugin.interface?.displayName || plugin.name,
    description: plugin.interface?.shortDescription || plugin.description,
    category: plugin.interface?.category,
    icon: installedIcon(plugin),
    contents: {
      skills,
      apps,
      mcpServers,
      emailConnections,
      total: skills + apps + mcpServers + emailConnections,
    },
    state: {
      installed: true,
      enabled: plugin.enabled,
      installedVersion: plugin.version,
      latestVersion: plugin.version,
      updateAvailable: false,
      repairAvailable: false,
      readiness: plugin.readiness,
      scope: plugin.scopeType,
    },
  };
}

export function serializeMobileInstalledPluginDetail(
  plugin: CanvasPluginInstallRecord,
): MobilePluginDetail {
  const summary = serializeMobileInstalledPlugin(plugin);
  return {
    ...summary,
    publisher: plugin.author,
    release: {
      version: plugin.version,
    },
    skills: plugin.skills.map((skill) => ({
      name: skill.name,
      displayName: skill.title || skill.name,
      description: skill.description,
      icon: {
        brandColor: plugin.interface?.brandColor,
        initials: initialsFor(skill.title || skill.name),
      },
      installed: true,
      enabled: plugin.enabled,
      status: 'ok',
      updateAvailable: false,
      repairable: false,
    })),
    connections: [
      ...normalizeComposioConnectors(plugin.connectors).map((connector) => ({
        type: 'composio' as const,
        key: connector.toolkit,
        label: connector.label || connector.toolkit,
        description: connector.reason,
        required: connector.required === true,
        icon: { initials: initialsFor(connector.label || connector.toolkit) },
      })),
      ...normalizeEmailConnectors(plugin.connectors).map((connector, index) => ({
        type: 'email' as const,
        key: connector.label || `email-${index}`,
        label: connector.label || 'Email account',
        description: connector.reason,
        required: connector.required === true,
        icon: { initials: initialsFor(connector.label || 'Email account') },
      })),
      ...normalizeMcpConnectors(plugin.connectors).map((connector) => ({
        type: 'mcp' as const,
        key: connector.name,
        label: connector.label || connector.name,
        description: connector.reason,
        required: connector.required === true,
        icon: {
          url: `/api/mobile/v1/integrations/mcp-icon/${encodeURIComponent(connector.name)}`,
          initials: initialsFor(connector.label || connector.name),
        },
      })),
    ],
  };
}
