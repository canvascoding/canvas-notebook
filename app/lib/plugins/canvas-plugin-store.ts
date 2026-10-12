import { promises as fs } from 'fs';
import path from 'path';

import packageMetadata from '@/package.json';
import { listVisibleInstalledCanvasPlugins } from '@/app/lib/plugins/visible-installed-plugins';
import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { createCapabilityResourceId } from '@/app/lib/capabilities/reference';
import { issueVerifiedCapabilityStoreOrigin, capabilityStoreRegistryIdentity } from '@/app/lib/capabilities/packages/store-origin';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import type { CapabilityPackageStoreSelection } from '@/app/lib/capabilities/packages/store-contracts';
import { readBoundedStorePackageBytes, normalizeStoreArchivePath, extractBoundedStorePackageArchive } from './store-package-archive';
import type { CapabilityStoreComparison } from './store-installed-resource';
import type { SafeActorSkillStoreResource } from '@/app/lib/skills/actor-skill-store-state';

import {
  computeCanvasPluginChecksum,
  installCanvasPluginFromPath,
  listCanvasPlugins,
  type CanvasPluginStorageScope,
  type CanvasPluginInstallRecord,
  type CanvasPluginInstallResult,
} from '@/app/lib/plugins/canvas-plugin-registry';
import {
  isValidCanvasVersion,
  isValidCanvasPluginName,
  isValidCanvasPluginVersion,
  validateCanvasPluginPackage,
  type CanvasPluginConnectorManifest,
  type CanvasPluginMcpConnector,
} from '@/app/lib/plugins/canvas-plugin-manifest';
import {
  normalizeComposioConnectors,
  normalizeEmailConnectors,
  normalizeMcpConnectors,
  resolvePluginConnectionReadiness,
} from '@/app/lib/plugins/plugin-connection-readiness';
import { readPluginMcpTemplateFile } from '@/app/lib/plugins/plugin-mcp-template-service';
import { readCanvasSkillRegistry, type CanvasSkillInstallRecord } from '@/app/lib/skills/canvas-skill-store';
import { resolveReadableScopedSkillsDataDir, resolveDataStorageScope } from '@/app/lib/runtime-data-paths';

export const DEFAULT_CANVAS_PLUGIN_STORE_REGISTRY_URL =
  'https://raw.githubusercontent.com/canvascoding/canvas-notebook-plugin-marketplace/main/registry.json';

const MAX_STORE_ICON_BYTES = 2 * 1024 * 1024;
const MAX_STORE_ARCHIVE_BYTES = 250 * 1024 * 1024;
const CANVAS_VERSION = packageMetadata.version;

export interface CanvasPluginStorePublisher {
  name?: string;
  url?: string;
}

export interface CanvasPluginStoreVersion {
  version: string;
  downloadUrl: string;
  packagePath?: string;
  checksum: string;
  manifestPath?: string;
  releasedAt?: string;
  minCanvasVersion?: string;
  notes?: string;
}

export interface CanvasPluginStorePlugin {
  name: string;
  displayName: string;
  description: string;
  category?: string;
  publisher?: CanvasPluginStorePublisher;
  latestVersion: string;
  icon?: string;
  iconUrl?: string;
  brandColor?: string;
  connectors?: CanvasPluginConnectorManifest;
  skills?: string[];
  versions: Record<string, CanvasPluginStoreVersion>;
}

export interface CanvasPluginStoreRegistry {
  schemaVersion: 1;
  id: string;
  name: string;
  publisher?: CanvasPluginStorePublisher;
  homepage?: string;
  updatedAt: string;
  registryUrl: string;
  plugins: CanvasPluginStorePlugin[];
}

export interface CanvasPluginStoreInstalledState {
  installed: boolean;
  enabled: boolean;
  version?: string;
  updateAvailable: boolean;
  installedPlugin?: CanvasPluginInstallRecord;
  skills: CanvasPluginStoreSkillState[];
  skillSummary: CanvasPluginStoreSkillSummary;
  resources?: SafeActorSkillStoreResource[];
  comparison?: CapabilityStoreComparison;
}

export type CanvasPluginStorePluginWithState = CanvasPluginStorePlugin & {
  installed: CanvasPluginStoreInstalledState;
};

export interface CanvasPluginStoreList {
  registry: Omit<CanvasPluginStoreRegistry, 'plugins'>;
  plugins: CanvasPluginStorePluginWithState[];
  pagination: CanvasPluginStorePagination;
  stats: CanvasPluginStoreStats;
  facets: { categories: string[]; connectionTypes: CanvasPluginStoreConnectionType[] };
  installedPlugins: CanvasPluginStorePluginWithState[];
  installedResources?: SafeActorSkillStoreResource[];
  comparison?: CapabilityStoreComparison;
  availability?: 'available' | 'unavailable';
}

export interface CanvasPluginStoreInstallResult extends CanvasPluginInstallResult {
  storePlugin?: CanvasPluginStorePlugin;
  storeVersion?: CanvasPluginStoreVersion;
}

export interface CanvasPluginStoreIcon {
  bytes: Buffer;
  contentType: string;
}

export type CanvasPluginStoreStateFilter = 'all' | 'available' | 'installed' | 'updates';
export type CanvasPluginStoreConnectionType = 'composio' | 'email' | 'mcp' | 'none';

export interface CanvasPluginStoreListOptions {
  name?: string;
  page?: number;
  pageSize?: number;
  query?: string;
  category?: string;
  connection?: CanvasPluginStoreConnectionType;
  state?: CanvasPluginStoreStateFilter;
  scope?: CanvasPluginStorageScope | null;
  /** Authenticated server actor; never accepted from a model or request body. */
  actor?: CapabilityResourceActor;
}

export interface CanvasPluginStorePagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface CanvasPluginStoreStats {
  total: number;
  installed: number;
  available: number;
  updates: number;
  filteredTotal: number;
}

export interface CanvasPluginStorePreflightItem {
  type: 'composio' | 'email' | 'mcp';
  key: string;
  label: string;
  required: boolean;
  ready: boolean;
  available?: boolean;
  connected?: boolean;
  configured?: boolean;
  logo?: string;
  reason?: string;
  details?: string[];
  action: 'none' | 'configure-composio' | 'connect-composio' | 'configure-email' | 'configure-mcp';
}

export type CanvasPluginStoreSkillStatus =
  | 'ok'
  | 'missing'
  | 'plugin-update-available'
  | 'skill-update-available'
  | 'modified'
  | 'standalone'
  | 'untracked';

export interface CanvasPluginStoreSkillState {
  name: string;
  title?: string;
  expectedVersion?: string;
  installed: boolean;
  enabled?: boolean;
  version?: string;
  sourceType?: CanvasSkillInstallRecord['sourceType'];
  sourcePluginName?: string;
  status: CanvasPluginStoreSkillStatus;
  updateAvailable: boolean;
  modified: boolean;
  repairable: boolean;
}

export interface CanvasPluginStoreSkillSummary {
  total: number;
  installed: number;
  missing: number;
  updateAvailable: number;
  modified: number;
  repairable: number;
}

export interface CanvasPluginStorePreflight {
  pluginName: string;
  version: string;
  ready: boolean;
  hasRequiredMissing: boolean;
  hasSkillIssues: boolean;
  items: CanvasPluginStorePreflightItem[];
  skills: CanvasPluginStoreSkillState[];
  summary: {
    total: number;
    ready: number;
    requiredMissing: number;
    recommendedMissing: number;
  };
  skillSummary: CanvasPluginStoreSkillSummary;
}

export interface CanvasPluginStoreMcpTemplate {
  pluginName: string;
  version: string;
  connector: CanvasPluginMcpConnector;
  rawContent?: string;
  config?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
  return values.length > 0 ? values : undefined;
}

function normalizePublisher(value: unknown): CanvasPluginStorePublisher | undefined {
  if (!isRecord(value)) return undefined;
  const publisher = {
    name: stringValue(value.name),
    url: stringValue(value.url),
  };
  return publisher.name || publisher.url ? publisher : undefined;
}

function normalizeChecksum(value: string): string {
  return value.trim().replace(/^sha256:/i, '').toLowerCase();
}

function compareVersions(left: string | undefined, right: string | undefined): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  const parse = (version: string) => version
    .split(/[+-]/, 1)[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }

  return left.localeCompare(right);
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function emptySkillSummary(): CanvasPluginStoreSkillSummary {
  return {
    total: 0,
    installed: 0,
    missing: 0,
    updateAvailable: 0,
    modified: 0,
    repairable: 0,
  };
}

function summarizeSkillStates(skills: CanvasPluginStoreSkillState[]): CanvasPluginStoreSkillSummary {
  return {
    total: skills.length,
    installed: skills.filter((skill) => skill.installed).length,
    missing: skills.filter((skill) => skill.status === 'missing').length,
    updateAvailable: skills.filter((skill) => skill.updateAvailable).length,
    modified: skills.filter((skill) => skill.modified).length,
    repairable: skills.filter((skill) => skill.repairable).length,
  };
}

async function skillFileExists(skillName: string, scope?: CanvasPluginStorageScope | null): Promise<boolean> {
  const skillsDir = await resolveReadableScopedSkillsDataDir(scope);
  const stat = await fs.stat(path.join(skillsDir, skillName, 'SKILL.md')).catch(() => null);
  return Boolean(stat?.isFile());
}

async function computeInstalledSkillModified(
  skillName: string,
  installedSkill: CanvasSkillInstallRecord | undefined,
  scope?: CanvasPluginStorageScope | null,
): Promise<boolean> {
  if (!installedSkill?.checksum) return false;
  const installDir = path.join(await resolveReadableScopedSkillsDataDir(scope), skillName);
  const currentChecksum = await computeCanvasPluginChecksum(installDir).catch(() => '');
  return Boolean(currentChecksum && currentChecksum !== installedSkill.checksum);
}

async function buildInstalledPluginSkillState(
  storePlugin: CanvasPluginStorePlugin,
  installedPlugin: CanvasPluginInstallRecord | undefined,
  targetVersion: string | undefined,
  skillRegistry: Awaited<ReturnType<typeof readCanvasSkillRegistry>>,
  scope?: CanvasPluginStorageScope | null,
): Promise<{ skills: CanvasPluginStoreSkillState[]; summary: CanvasPluginStoreSkillSummary }> {
  if (!installedPlugin) {
    return { skills: [], summary: emptySkillSummary() };
  }

  const expectedByName = new Map(
    installedPlugin.skills.map((skill) => [skill.name, {
      name: skill.name,
      title: skill.title,
      version: skill.version || installedPlugin.version,
    }]),
  );

  for (const skillName of storePlugin.skills || []) {
    if (!expectedByName.has(skillName)) {
      expectedByName.set(skillName, {
        name: skillName,
        title: skillName,
        version: targetVersion || storePlugin.latestVersion,
      });
    }
  }

  const pluginUpdateAvailable = Boolean(
    targetVersion && compareVersions(targetVersion, installedPlugin.version) > 0,
  );

  const skills = await Promise.all(Array.from(expectedByName.values()).map(async (skill) => {
    const installedSkill = skillRegistry.skills[skill.name];
    const installed = await skillFileExists(skill.name, scope);
    const pluginOwned = Boolean(
      installedSkill?.sourceType === 'plugin'
      && installedSkill.sourcePluginName === installedPlugin.name,
    );
    const expectedVersion = skill.version || installedPlugin.version;
    const skillVersionUpdateAvailable = Boolean(
      installed
      && expectedVersion
      && installedSkill?.version
      && compareVersions(expectedVersion, installedSkill.version) > 0,
    );
    const updateAvailable = pluginUpdateAvailable || skillVersionUpdateAvailable;
    const modified = installed && pluginOwned
      ? await computeInstalledSkillModified(skill.name, installedSkill, scope)
      : false;
    let status: CanvasPluginStoreSkillStatus = 'ok';

    if (!installed) {
      status = pluginUpdateAvailable ? 'plugin-update-available' : 'missing';
    } else if (pluginUpdateAvailable) {
      status = 'plugin-update-available';
    } else if (skillVersionUpdateAvailable) {
      status = 'skill-update-available';
    } else if (modified) {
      status = 'modified';
    } else if (!installedSkill) {
      status = 'untracked';
    } else if (!pluginOwned) {
      status = 'standalone';
    }

    const repairable = !installed || (pluginOwned && (updateAvailable || modified));

    return {
      name: skill.name,
      title: skill.title,
      expectedVersion,
      installed,
      version: installedSkill?.version,
      sourceType: installedSkill?.sourceType,
      sourcePluginName: installedSkill?.sourcePluginName,
      status,
      updateAvailable,
      modified,
      repairable,
    };
  }));

  return { skills, summary: summarizeSkillStates(skills) };
}

function getRegistryUrl(): string {
  return process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL?.trim()
    || DEFAULT_CANVAS_PLUGIN_STORE_REGISTRY_URL;
}

function resolveRegistryRelativeUrl(registryUrl: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, registryUrl).toString();
  } catch {
    return value;
  }
}

function validateRegistryUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol === 'https:') return url;
  if (process.env.NODE_ENV !== 'production' && ['http:', 'file:'].includes(url.protocol)) {
    return url;
  }
  throw new Error('Plugin store URLs must use HTTPS. HTTP and file URLs are only available outside production.');
}

async function readUrlBytes(rawUrl: string, maxBytes = MAX_STORE_ARCHIVE_BYTES): Promise<Buffer> {
  return readBoundedStorePackageBytes(validateRegistryUrl(rawUrl), maxBytes);
}

async function readJsonUrl(rawUrl: string): Promise<unknown> {
  const { readBoundedStoreRegistryJson } = await import('./store-registry-reader');
  return readBoundedStoreRegistryJson(rawUrl);
}

function normalizeStoreVersion(value: unknown): CanvasPluginStoreVersion | null {
  if (!isRecord(value)) return null;
  const version = stringValue(value.version);
  const downloadUrl = stringValue(value.downloadUrl ?? value.download_url);
  const checksum = stringValue(value.checksum);
  if (!version || !downloadUrl || !checksum || !isValidCanvasPluginVersion(version) || !/^[a-f0-9]{64}$/u.test(normalizeChecksum(checksum))) {
    return null;
  }

  return {
    version,
    downloadUrl,
    packagePath: stringValue(value.packagePath ?? value.package_path),
    checksum: normalizeChecksum(checksum),
    manifestPath: stringValue(value.manifestPath ?? value.manifest_path),
    releasedAt: stringValue(value.releasedAt ?? value.released_at),
    minCanvasVersion: stringValue(value.minCanvasVersion ?? value.min_canvas_version),
    notes: stringValue(value.notes),
  };
}

function normalizeStorePlugin(value: unknown, registryUrl: string): CanvasPluginStorePlugin | null {
  if (!isRecord(value)) return null;
  const name = stringValue(value.name);
  const latestVersion = stringValue(value.latestVersion ?? value.latest_version);
  if (!name || !latestVersion || !isValidCanvasPluginName(name) || !isValidCanvasPluginVersion(latestVersion)) {
    return null;
  }

  const rawVersions = isRecord(value.versions) ? value.versions : {};
  const versions: Record<string, CanvasPluginStoreVersion> = {};
  for (const [versionKey, versionValue] of Object.entries(rawVersions)) {
    const version = normalizeStoreVersion(versionValue);
    if (!version || versionKey !== version.version) throw new Error('The plugin store contains an invalid version entry.');
    versions[version.version] = {
      ...version,
      downloadUrl: resolveRegistryRelativeUrl(registryUrl, version.downloadUrl) || version.downloadUrl,
    };
  }

  if (!versions[latestVersion]) {
    return null;
  }

  const icon = stringValue(value.icon);
  return {
    name,
    displayName: stringValue(value.displayName ?? value.display_name) || name,
    description: stringValue(value.description) || '',
    category: stringValue(value.category),
    publisher: normalizePublisher(value.publisher),
    latestVersion,
    icon,
    iconUrl: resolveRegistryRelativeUrl(registryUrl, icon),
    brandColor: stringValue(value.brandColor ?? value.brand_color),
    connectors: isRecord(value.connectors) ? value.connectors as CanvasPluginConnectorManifest : undefined,
    skills: stringArrayValue(value.skills),
    versions,
  };
}

export async function readCanvasPluginStoreRegistry(): Promise<CanvasPluginStoreRegistry> {
  const registryUrl = getRegistryUrl();
  const parsed = await readJsonUrl(registryUrl);
  if (!isRecord(parsed)) {
    throw new Error('Plugin store registry must be a JSON object.');
  }

  const id = stringValue(parsed.id);
  const name = stringValue(parsed.name);
  const schemaVersion = parsed.schemaVersion;
  const updatedAt = stringValue(parsed.updatedAt);
  if (schemaVersion !== 1 || !id || !name || !updatedAt) {
    throw new Error('Plugin store registry is missing required metadata.');
  }

  const plugins = Array.isArray(parsed.plugins)
    ? parsed.plugins
      .map((entry) => normalizeStorePlugin(entry, registryUrl))
      .filter((entry): entry is CanvasPluginStorePlugin => Boolean(entry))
    : [];
  if (!Array.isArray(parsed.plugins) || plugins.length !== parsed.plugins.length || new Set(plugins.map(plugin => plugin.name)).size !== plugins.length) {
    throw new Error('The plugin store contains invalid or duplicate entries.');
  }

  return {
    schemaVersion: 1,
    id,
    name,
    publisher: normalizePublisher(parsed.publisher),
    homepage: stringValue(parsed.homepage),
    updatedAt,
    registryUrl,
    plugins: plugins.sort((left, right) => left.displayName.localeCompare(right.displayName)),
  };
}

export async function readCanvasPluginStoreIcon(pluginName: string): Promise<CanvasPluginStoreIcon | null> {
  if (!isValidCanvasPluginName(pluginName)) return null;
  const registry = await readCanvasPluginStoreRegistry();
  const plugin = registry.plugins.find((entry) => entry.name === pluginName);
  if (!plugin?.iconUrl) return null;

  let pathname: string;
  try {
    pathname = new URL(plugin.iconUrl).pathname;
  } catch {
    return null;
  }

  const contentTypes: Record<string, string> = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  const contentType = contentTypes[path.extname(pathname).toLowerCase()];
  if (!contentType) return null;

  return {
    bytes: await readUrlBytes(plugin.iconUrl, MAX_STORE_ICON_BYTES),
    contentType,
  };
}

async function enrichStorePluginsWithInstalledState(
  registry: CanvasPluginStoreRegistry,
  installedPlugins: CanvasPluginInstallRecord[],
  scope?: CanvasPluginStorageScope | null,
): Promise<{ registry: Omit<CanvasPluginStoreRegistry, 'plugins'>; plugins: CanvasPluginStorePluginWithState[]; stats: Omit<CanvasPluginStoreStats, 'filteredTotal'> }> {
  const installedByName = new Map(installedPlugins.map((plugin) => [plugin.name.toLowerCase(), plugin]));
  const personalSkillRegistry = await readCanvasSkillRegistry(scope);
  const scopedSkillRegistries = new Map<string, ReturnType<typeof readCanvasSkillRegistry>>();
  const plugins = await Promise.all(registry.plugins.map(async (plugin) => {
    const installedPlugin = installedByName.get(plugin.name.toLowerCase());
    const installedScope = installedPlugin?.scopeType === 'organization' && installedPlugin.organizationId
      ? { scopeType: 'organization' as const, organizationId: installedPlugin.organizationId }
      : installedPlugin?.scopeType === 'user' && installedPlugin.ownerUserId
        ? { scopeType: 'user' as const, userId: installedPlugin.ownerUserId } : scope;
    let skillRegistry = personalSkillRegistry;
    if (installedPlugin && (installedPlugin.scopeType === 'organization' || installedPlugin.ownerUserId)) {
      const storageKey = installedPlugin.scopeType === 'organization'
        ? `organization:${installedPlugin.organizationId}` : `user:${installedPlugin.ownerUserId}`;
      if (!scopedSkillRegistries.has(storageKey)) {
        scopedSkillRegistries.set(storageKey, readCanvasSkillRegistry(installedScope));
      }
      skillRegistry = await scopedSkillRegistries.get(storageKey)!;
    }
    const updateAvailable = Boolean(
      installedPlugin && compareVersions(plugin.latestVersion, installedPlugin.version) > 0,
    );
    const skillState = await buildInstalledPluginSkillState(
      plugin,
      installedPlugin,
      plugin.latestVersion,
      skillRegistry,
      installedScope,
    );

    return {
      ...plugin,
      installed: {
        installed: Boolean(installedPlugin),
        enabled: Boolean(installedPlugin?.enabled),
        version: installedPlugin?.version,
        updateAvailable,
        installedPlugin,
        skills: skillState.skills,
        skillSummary: skillState.summary,
      },
    };
  }));

  const { plugins: _plugins, ...registryMetadata } = registry;
  return {
    registry: registryMetadata,
    plugins,
    stats: {
      total: plugins.length,
      installed: plugins.filter((plugin) => plugin.installed.installed).length,
      available: plugins.filter((plugin) => !plugin.installed.installed).length,
      updates: plugins.filter((plugin) => plugin.installed.updateAvailable).length,
    },
  };
}

function matchesStoreQuery(plugin: CanvasPluginStorePluginWithState, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    plugin.name,
    plugin.displayName,
    plugin.description,
    plugin.category,
    plugin.skills?.join(' '),
    normalizeComposioConnectors(plugin.connectors).map((connector) => connector.toolkit).join(' '),
    normalizeMcpConnectors(plugin.connectors).map((connector) => connector.name).join(' '),
  ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
}

function matchesState(plugin: CanvasPluginStorePluginWithState, state: CanvasPluginStoreStateFilter): boolean {
  if (state === 'available') return !plugin.installed.installed;
  if (state === 'installed') return plugin.installed.installed;
  if (state === 'updates') return plugin.installed.updateAvailable;
  return true;
}

export function parseCanvasPluginStoreConnectionType(value: unknown): CanvasPluginStoreConnectionType | undefined {
  return value === 'composio' || value === 'email' || value === 'mcp' || value === 'none' ? value : undefined;
}

function storeConnectionTypes(plugin: CanvasPluginStorePlugin): CanvasPluginStoreConnectionType[] {
  const types: CanvasPluginStoreConnectionType[] = [];
  if (normalizeComposioConnectors(plugin.connectors).length) types.push('composio');
  if (normalizeEmailConnectors(plugin.connectors).length) types.push('email');
  if (normalizeMcpConnectors(plugin.connectors).length) types.push('mcp');
  return types.length ? types : ['none'];
}

export async function listCanvasPluginStore(options: CanvasPluginStoreListOptions = {}): Promise<CanvasPluginStoreList> {
  if (options.actor) {
    const { listActorCanvasPluginStore } = await import('./actor-plugin-store-state');
    return listActorCanvasPluginStore({ ...options, actor: options.actor }, readCanvasPluginStoreRegistry);
  }
  const [registry, installedPlugins] = await Promise.all([
    readCanvasPluginStoreRegistry(),
    listVisibleInstalledCanvasPlugins(options.scope, options.actor),
  ]);
  const enriched = await enrichStorePluginsWithInstalledState(registry, installedPlugins, options.scope);
  const pageSize = clampPositiveInteger(options.pageSize, 12, 50);
  const page = clampPositiveInteger(options.page, 1, 100000);
  const state = options.state || 'all';
  const category = options.category?.trim().toLowerCase();
  const filtered = enriched.plugins.filter((plugin) => (
    (!options.name || plugin.name === options.name)
    && (!category || plugin.category?.trim().toLowerCase() === category)
    && (!options.connection || storeConnectionTypes(plugin).includes(options.connection))
    && matchesState(plugin, state) && matchesStoreQuery(plugin, options.query || '')
  ));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const offset = (normalizedPage - 1) * pageSize;
  return {
    registry: enriched.registry,
    facets: {
      categories: [...new Set(enriched.plugins.map((plugin) => plugin.category).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b)),
      connectionTypes: [...new Set(enriched.plugins.flatMap(storeConnectionTypes))].sort(),
    },
    installedPlugins: enriched.plugins.filter((plugin) => plugin.installed.installed),
    plugins: filtered.slice(offset, offset + pageSize),
    pagination: {
      page: normalizedPage,
      pageSize,
      totalItems: filtered.length,
      totalPages,
      hasNextPage: normalizedPage < totalPages,
      hasPreviousPage: normalizedPage > 1,
    },
    stats: {
      ...enriched.stats,
      filteredTotal: filtered.length,
    },
  };
}

export async function getCanvasPluginStorePlugin(
  pluginName: string,
  scope?: CanvasPluginStorageScope | null,
  actor?: CapabilityResourceActor,
): Promise<{
  registry: Omit<CanvasPluginStoreRegistry, 'plugins'>;
  plugin: CanvasPluginStorePluginWithState;
} | null> {
  if (!isValidCanvasPluginName(pluginName)) return null;
  if (actor) {
    const store = await listCanvasPluginStore({ name: pluginName, scope, actor });
    return store.plugins[0] ? { registry: store.registry, plugin: store.plugins[0] } : null;
  }
  const [registry, installedPlugins] = await Promise.all([
    readCanvasPluginStoreRegistry(),
    listVisibleInstalledCanvasPlugins(scope, actor),
  ]);
  const plugin = registry.plugins.find((entry) => entry.name === pluginName);
  if (!plugin) return null;
  const enriched = await enrichStorePluginsWithInstalledState(
    { ...registry, plugins: [plugin] },
    installedPlugins,
    scope,
  );
  return enriched.plugins[0]
    ? { registry: enriched.registry, plugin: enriched.plugins[0] }
    : null;
}

function sanitizeArchivePath(archivePath: string): string {
  return normalizeStoreArchivePath(archivePath);
}

async function extractPackageFromArchive(archiveBytes: Buffer, packagePath: string | undefined): Promise<{ tempRoot: string; packageRoot: string }> {
  return extractBoundedStorePackageArchive(archiveBytes, packagePath ? sanitizeArchivePath(packagePath) : undefined, 'plugin');
}

async function verifyPackageChecksum(packageRoot: string, expectedChecksum: string): Promise<void> {
  const actual = await computeCanvasPluginChecksum(packageRoot);
  const expected = normalizeChecksum(expectedChecksum);
  if (actual !== expected) {
    throw new Error(`Plugin checksum mismatch (${actual.slice(0, 12)}).`);
  }
}

function assertStorePackageIdentity(
  packageRoot: string,
  expectedName: string,
  expectedVersion: string,
): Promise<void> {
  return validateCanvasPluginPackage(packageRoot).then((validation) => {
    if (!validation.valid || !validation.manifest) {
      throw new Error(`Downloaded plugin package is invalid: ${validation.errors.join(' ')}`);
    }
    if (validation.manifest.name !== expectedName || validation.manifest.version !== expectedVersion) {
      throw new Error(`Downloaded plugin package identity mismatch. Expected ${expectedName}@${expectedVersion}.`);
    }
  });
}

function assertMinimumCanvasVersion(minCanvasVersion: string | undefined): void {
  if (!minCanvasVersion) return;
  if (!isValidCanvasVersion(minCanvasVersion)) {
    throw new Error(`Plugin declares an invalid minimum Canvas version: ${minCanvasVersion}.`);
  }
  if (compareVersions(CANVAS_VERSION, minCanvasVersion) < 0) {
    throw new Error(`Plugin requires Canvas ${minCanvasVersion} or later. This Canvas installation is ${CANVAS_VERSION}.`);
  }
}

/** Private configured-source intake; no installed registry or resource is mutated. */
export async function prepareCanvasPluginStoreArchive(input: CapabilityPackageStoreSelection & {resourceId: string;
  expectedOrigin?: {registryIdentity: string; version: string; upstreamChecksum: string}}) {
  const registry = await readCanvasPluginStoreRegistry();
  const storePlugin = registry.plugins.find(plugin => plugin.name === input.entryKey);
  const storeVersion = storePlugin?.versions[input.version];
  if (input.kind !== 'plugin' || registry.id !== input.registryId || !storePlugin || !storeVersion
    || storeVersion.checksum !== input.checksum) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The Store offering changed. Reload the Store.', 409);
  const identity = capabilityStoreRegistryIdentity(registry.registryUrl);
  if (input.expectedOrigin && (input.expectedOrigin.registryIdentity !== identity
    || storePlugin.versions[input.expectedOrigin.version]?.checksum !== input.expectedOrigin.upstreamChecksum)) {
    throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The original Store offering changed. Reload the Store.', 409);
  }
  return preparePluginArchive(registry, storePlugin, storeVersion, input.resourceId, input.expectedOrigin);
}

async function preparePluginArchive(registry: CanvasPluginStoreRegistry, storePlugin: CanvasPluginStorePlugin,
  storeVersion: CanvasPluginStoreVersion, resourceId: string,
  expectedOrigin?: {registryIdentity: string; version: string; upstreamChecksum: string}) {
  const baseline = expectedOrigin ? Object.freeze({...expectedOrigin}) : undefined;
  assertMinimumCanvasVersion(storeVersion.minCanvasVersion);
  const archiveBytes = await readUrlBytes(storeVersion.downloadUrl);
  const extracted = await extractPackageFromArchive(archiveBytes, storeVersion.packagePath);
  try {
    await verifyPackageChecksum(extracted.packageRoot, storeVersion.checksum);
    await assertStorePackageIdentity(extracted.packageRoot, storePlugin.name, storeVersion.version);
    const storeOrigin = await issueVerifiedCapabilityStoreOrigin({ resourceId, registryId: registry.id, registryUrl: registry.registryUrl,
      kind: 'plugin', entryKey: storePlugin.name, version: storeVersion.version, upstreamChecksum: storeVersion.checksum, packageRoot: extracted.packageRoot });
    const verifyCurrent = async (options: {verifyRegistry?: boolean} = {}) => {
      const assertConfiguredSource = () => {
        if (capabilityStoreRegistryIdentity(getRegistryUrl()) !== storeOrigin.registryIdentity) {
          throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The configured Store source changed.', 409);
        }
      };
      assertConfiguredSource();
      if (!options.verifyRegistry) return;
      let current: CanvasPluginStoreRegistry;
      try { current = await readCanvasPluginStoreRegistry(); }
      catch { throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The configured Store is unavailable.', 503); }
      assertConfiguredSource();
      const offering = current.plugins.find(value => value.name === storeOrigin.entryKey);
      if (current.id !== storeOrigin.registryId || capabilityStoreRegistryIdentity(current.registryUrl) !== storeOrigin.registryIdentity
        || offering?.versions[storeOrigin.version]?.checksum !== storeOrigin.upstreamChecksum
        || baseline && (baseline.registryIdentity !== storeOrigin.registryIdentity
          || offering?.versions[baseline.version]?.checksum !== baseline.upstreamChecksum)) {
        throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The Store offering changed. Reload the Store.', 409);
      }
    };
    await verifyCurrent();
    return { ...extracted, registry, storePlugin, storeVersion, storeOrigin, verifyCurrent };
  } catch (error) { await fs.rm(extracted.tempRoot, { recursive: true, force: true }); throw error; }
}

export async function installCanvasPluginFromStore(
  pluginName: string,
  version?: string,
  options: {
    enable?: boolean;
    replace?: boolean;
    installedBy?: string;
    scope?: CanvasPluginStorageScope | null;
  } = {},
): Promise<CanvasPluginStoreInstallResult> {
  if (!isValidCanvasPluginName(pluginName)) {
    return { success: false, error: 'Invalid plugin name' };
  }
  if (version && !isValidCanvasPluginVersion(version)) {
    return { success: false, error: 'Invalid plugin version' };
  }

  const registry = await readCanvasPluginStoreRegistry();
  const storePlugin = registry.plugins.find((plugin) => plugin.name === pluginName);
  if (!storePlugin) {
    return { success: false, error: `Plugin "${pluginName}" not found in the Canvas Plugin Store.` };
  }

  const selectedVersion = version || storePlugin.latestVersion;
  const storeVersion = storePlugin.versions[selectedVersion];
  if (!storeVersion) {
    return { success: false, error: `Version ${selectedVersion} is not available for plugin "${pluginName}".`, storePlugin };
  }
  try {
    assertMinimumCanvasVersion(storeVersion.minCanvasVersion);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Plugin is incompatible with this Canvas version.',
      storePlugin,
      storeVersion,
    };
  }

  let tempRoot: string | null = null;
  try {
    const storage = resolveDataStorageScope(options.scope);
    const resourceId = createCapabilityResourceId({ resourceType: 'plugin', scopeType: storage.scopeType === 'legacy' ? 'system' : storage.scopeType,
      name: pluginName, sourceType: 'standalone', organizationId: storage.organizationId, ownerUserId: storage.userId });
    const extracted = await preparePluginArchive(registry, storePlugin, storeVersion, resourceId);
    tempRoot = extracted.tempRoot;
    const storeOrigin = extracted.storeOrigin;

    const installResult = await installCanvasPluginFromPath(extracted.packageRoot, {
      enable: options.enable,
      replace: options.replace ?? true,
      installedBy: options.installedBy,
      sourcePathLabel: storeVersion.downloadUrl,
      sourceRegistryId: registry.id,
      sourceRegistryUrl: registry.registryUrl,
      storeOrigin,
      scope: options.scope,
    });

    return {
      ...installResult,
      storePlugin,
      storeVersion,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install plugin from store',
      storePlugin,
      storeVersion,
    };
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function getStorePluginOrThrow(registry: CanvasPluginStoreRegistry, pluginName: string, version?: string) {
  const plugin = registry.plugins.find((entry) => entry.name === pluginName);
  if (!plugin) {
    throw new Error(`Plugin "${pluginName}" not found in the Canvas Plugin Store.`);
  }
  const selectedVersion = version || plugin.latestVersion;
  if (!plugin.versions[selectedVersion]) {
    throw new Error(`Version ${selectedVersion} is not available for plugin "${pluginName}".`);
  }
  return { plugin, version: selectedVersion };
}

export async function readCanvasPluginStoreMcpTemplate(
  pluginName: string,
  version: string | undefined,
  connectorName: string,
): Promise<CanvasPluginStoreMcpTemplate> {
  if (!isValidCanvasPluginName(pluginName)) {
    throw new Error('Invalid plugin name');
  }
  if (version && !isValidCanvasPluginVersion(version)) {
    throw new Error('Invalid plugin version');
  }
  if (!connectorName.trim()) {
    throw new Error('MCP connector name is required.');
  }

  const registry = await readCanvasPluginStoreRegistry();
  const { plugin, version: selectedVersion } = getStorePluginOrThrow(registry, pluginName, version);
  const connector = normalizeMcpConnectors(plugin.connectors).find((entry) => entry.name === connectorName);
  if (!connector) {
    throw new Error(`MCP connector "${connectorName}" was not found for plugin "${pluginName}".`);
  }

  if (!connector.configPath) {
    return {
      pluginName: plugin.name,
      version: selectedVersion,
      connector,
    };
  }

  const storeVersion = plugin.versions[selectedVersion];
  let tempRoot: string | null = null;
  try {
    assertMinimumCanvasVersion(storeVersion.minCanvasVersion);
    const archiveBytes = await readUrlBytes(storeVersion.downloadUrl);
    const extracted = await extractPackageFromArchive(archiveBytes, storeVersion.packagePath);
    tempRoot = extracted.tempRoot;
    await verifyPackageChecksum(extracted.packageRoot, storeVersion.checksum);
    await assertStorePackageIdentity(extracted.packageRoot, pluginName, selectedVersion);
    const templateFile = await readPluginMcpTemplateFile({
      rootDir: extracted.packageRoot,
      configPath: connector.configPath,
    });

    return {
      pluginName: plugin.name,
      version: selectedVersion,
      connector,
      rawContent: templateFile.rawContent,
      config: templateFile.config,
    };
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function preflightCanvasPluginFromStore(
  pluginName: string,
  version: string | undefined,
  userId: string,
  scope?: CanvasPluginStorageScope | null,
  workspaceId?: string | null,
): Promise<CanvasPluginStorePreflight> {
  if (!isValidCanvasPluginName(pluginName)) {
    throw new Error('Invalid plugin name');
  }
  if (version && !isValidCanvasPluginVersion(version)) {
    throw new Error('Invalid plugin version');
  }

  const registry = await readCanvasPluginStoreRegistry();
  const { plugin, version: selectedVersion } = getStorePluginOrThrow(registry, pluginName, version);
  const installedPlugin = (await listCanvasPlugins(scope)).find((entry) => entry.name === plugin.name);
  const skillRegistry = await readCanvasSkillRegistry(scope);
  const skillState = await buildInstalledPluginSkillState(plugin, installedPlugin, selectedVersion, skillRegistry, scope);
  const connectionReadiness = await resolvePluginConnectionReadiness({
    connectors: plugin.connectors,
    userId,
    workspaceId,
    fresh: true,
  });
  return {
    pluginName: plugin.name,
    version: selectedVersion,
    ready: connectionReadiness.ready,
    hasRequiredMissing: connectionReadiness.summary.requiredMissing > 0,
    hasSkillIssues: skillState.summary.repairable > 0 || skillState.summary.modified > 0,
    items: connectionReadiness.items,
    skills: skillState.skills,
    summary: connectionReadiness.summary,
    skillSummary: skillState.summary,
  };
}
