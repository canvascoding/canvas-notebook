import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import JSZip from 'jszip';
import packageMetadata from '@/package.json';

import {
  computeCanvasPluginChecksum,
  installCanvasPluginFromPath,
  listCanvasPlugins,
  type CanvasPluginStorageScope,
  type CanvasPluginInstallRecord,
  type CanvasPluginInstallResult,
} from '@/app/lib/plugins/canvas-plugin-registry';
import {
  isPathInside,
  isValidCanvasVersion,
  isValidCanvasPluginName,
  isValidCanvasPluginVersion,
  validateCanvasPluginPackage,
  type CanvasPluginConnectorManifest,
  type CanvasPluginMcpConnector,
} from '@/app/lib/plugins/canvas-plugin-manifest';
import {
  normalizeComposioConnectors,
  normalizeMcpConnectors,
  resolvePluginConnectionReadiness,
} from '@/app/lib/plugins/plugin-connection-readiness';
import { readPluginMcpTemplateFile } from '@/app/lib/plugins/plugin-mcp-template-service';
import { readCanvasSkillRegistry, type CanvasSkillInstallRecord } from '@/app/lib/skills/canvas-skill-store';
import { resolveReadableScopedSkillsDataDir } from '@/app/lib/runtime-data-paths';

export const DEFAULT_CANVAS_PLUGIN_STORE_REGISTRY_URL =
  'https://raw.githubusercontent.com/canvascoding/canvas-notebook-plugin-marketplace/main/registry.json';

const MAX_STORE_REGISTRY_BYTES = 5 * 1024 * 1024;
const MAX_STORE_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_STORE_ARCHIVE_FILES = 2_000;
const MAX_STORE_EXTRACTED_BYTES = 250 * 1024 * 1024;
const STORE_FETCH_TIMEOUT_MS = 20_000;
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
}

export type CanvasPluginStorePluginWithState = CanvasPluginStorePlugin & {
  installed: CanvasPluginStoreInstalledState;
};

export interface CanvasPluginStoreList {
  registry: Omit<CanvasPluginStoreRegistry, 'plugins'>;
  plugins: CanvasPluginStorePluginWithState[];
  pagination: CanvasPluginStorePagination;
  stats: CanvasPluginStoreStats;
}

export interface CanvasPluginStoreInstallResult extends CanvasPluginInstallResult {
  storePlugin?: CanvasPluginStorePlugin;
  storeVersion?: CanvasPluginStoreVersion;
}

export type CanvasPluginStoreStateFilter = 'all' | 'available' | 'installed' | 'updates';

export interface CanvasPluginStoreListOptions {
  page?: number;
  pageSize?: number;
  query?: string;
  state?: CanvasPluginStoreStateFilter;
  scope?: CanvasPluginStorageScope | null;
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
  const url = validateRegistryUrl(rawUrl);
  if (url.protocol === 'file:') {
    const filePath = fileURLToPath(url);
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) {
      throw new Error(`Plugin store file exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
    }
    return fs.readFile(filePath);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STORE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} ${response.statusText}`);
  }
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Plugin store response exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Plugin store response exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  }
  return bytes;
}

async function readJsonUrl(rawUrl: string): Promise<unknown> {
  const bytes = await readUrlBytes(rawUrl, MAX_STORE_REGISTRY_BYTES);
  return JSON.parse(bytes.toString('utf-8')) as unknown;
}

function normalizeStoreVersion(value: unknown): CanvasPluginStoreVersion | null {
  if (!isRecord(value)) return null;
  const version = stringValue(value.version);
  const downloadUrl = stringValue(value.downloadUrl ?? value.download_url);
  const checksum = stringValue(value.checksum);
  if (!version || !downloadUrl || !checksum || !isValidCanvasPluginVersion(version)) {
    return null;
  }

  return {
    version,
    downloadUrl,
    packagePath: stringValue(value.packagePath ?? value.package_path),
    checksum,
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
    if (!version || versionKey !== version.version) continue;
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

async function enrichStorePluginsWithInstalledState(
  registry: CanvasPluginStoreRegistry,
  installedPlugins: CanvasPluginInstallRecord[],
  scope?: CanvasPluginStorageScope | null,
): Promise<{ registry: Omit<CanvasPluginStoreRegistry, 'plugins'>; plugins: CanvasPluginStorePluginWithState[]; stats: Omit<CanvasPluginStoreStats, 'filteredTotal'> }> {
  const installedByName = new Map(installedPlugins.map((plugin) => [plugin.name, plugin]));
  const skillRegistry = await readCanvasSkillRegistry(scope);
  const plugins = await Promise.all(registry.plugins.map(async (plugin) => {
    const installedPlugin = installedByName.get(plugin.name);
    const updateAvailable = Boolean(
      installedPlugin && compareVersions(plugin.latestVersion, installedPlugin.version) > 0,
    );
    const skillState = await buildInstalledPluginSkillState(
      plugin,
      installedPlugin,
      plugin.latestVersion,
      skillRegistry,
      scope,
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

export async function listCanvasPluginStore(options: CanvasPluginStoreListOptions = {}): Promise<CanvasPluginStoreList> {
  const [registry, installedPlugins] = await Promise.all([
    readCanvasPluginStoreRegistry(),
    listCanvasPlugins(options.scope),
  ]);
  const enriched = await enrichStorePluginsWithInstalledState(registry, installedPlugins, options.scope);
  const pageSize = clampPositiveInteger(options.pageSize, 12, 50);
  const page = clampPositiveInteger(options.page, 1, 100000);
  const state = options.state || 'all';
  const filtered = enriched.plugins.filter((plugin) => (
    matchesState(plugin, state) && matchesStoreQuery(plugin, options.query || '')
  ));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const offset = (normalizedPage - 1) * pageSize;
  return {
    registry: enriched.registry,
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

function sanitizeArchivePath(archivePath: string): string {
  return archivePath
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

async function extractPackageFromArchive(
  archiveBytes: Buffer,
  packagePath: string | undefined,
): Promise<{ tempRoot: string; packageRoot: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-store-'));
  const packageRoot = path.join(tempRoot, 'package');
  await fs.mkdir(packageRoot, { recursive: true });

  const zip = await JSZip.loadAsync(archiveBytes);
  const normalizedPackagePath = packagePath ? sanitizeArchivePath(packagePath) : '';
  let extractedCount = 0;
  let extractedBytes = 0;

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;

    const entryPath = sanitizeArchivePath(entry.name);
    if (!entryPath || entryPath.includes('../')) {
      continue;
    }

    let relativePath = entryPath;
    if (normalizedPackagePath) {
      const prefix = `${normalizedPackagePath}/`;
      if (!entryPath.startsWith(prefix)) {
        continue;
      }
      relativePath = entryPath.slice(prefix.length);
    }

    if (!relativePath || relativePath.includes('../')) {
      continue;
    }

    const targetPath = path.join(packageRoot, relativePath);
    if (!isPathInside(packageRoot, targetPath)) {
      throw new Error('Plugin archive contains an invalid path.');
    }

    const bytes = await entry.async('nodebuffer');
    extractedCount += 1;
    extractedBytes += bytes.byteLength;
    if (extractedCount > MAX_STORE_ARCHIVE_FILES) {
      throw new Error(`Plugin archive contains too many files. Maximum is ${MAX_STORE_ARCHIVE_FILES}.`);
    }
    if (extractedBytes > MAX_STORE_EXTRACTED_BYTES) {
      throw new Error('Plugin archive expands beyond the 250 MB package limit.');
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, bytes);
  }

  if (extractedCount === 0) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw new Error('Plugin package path was not found in the downloaded archive.');
  }

  return { tempRoot, packageRoot };
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
    const archiveBytes = await readUrlBytes(storeVersion.downloadUrl);
    const extracted = await extractPackageFromArchive(archiveBytes, storeVersion.packagePath);
    tempRoot = extracted.tempRoot;
    await verifyPackageChecksum(extracted.packageRoot, storeVersion.checksum);
    await assertStorePackageIdentity(extracted.packageRoot, pluginName, selectedVersion);

    const installResult = await installCanvasPluginFromPath(extracted.packageRoot, {
      enable: options.enable,
      replace: options.replace ?? true,
      installedBy: options.installedBy,
      sourcePathLabel: storeVersion.downloadUrl,
      sourceRegistryId: registry.id,
      sourceRegistryUrl: registry.registryUrl,
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
