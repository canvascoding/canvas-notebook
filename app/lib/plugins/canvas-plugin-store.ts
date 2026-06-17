import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import JSZip from 'jszip';

import {
  computeCanvasPluginChecksum,
  installCanvasPluginFromPath,
  listCanvasPlugins,
  type CanvasPluginInstallRecord,
  type CanvasPluginInstallResult,
} from '@/app/lib/plugins/canvas-plugin-registry';
import {
  isPathInside,
  isValidCanvasPluginName,
  isValidCanvasPluginVersion,
  type CanvasPluginConnectorManifest,
} from '@/app/lib/plugins/canvas-plugin-manifest';

export const DEFAULT_CANVAS_PLUGIN_STORE_REGISTRY_URL =
  'https://raw.githubusercontent.com/canvascoding/canvas-notebook-plugin-marketplace/main/registry.json';

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
}

export type CanvasPluginStorePluginWithState = CanvasPluginStorePlugin & {
  installed: CanvasPluginStoreInstalledState;
};

export interface CanvasPluginStoreList {
  registry: Omit<CanvasPluginStoreRegistry, 'plugins'>;
  plugins: CanvasPluginStorePluginWithState[];
}

export interface CanvasPluginStoreInstallResult extends CanvasPluginInstallResult {
  storePlugin?: CanvasPluginStorePlugin;
  storeVersion?: CanvasPluginStoreVersion;
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
  const url = rawUrl.startsWith('file://')
    ? new URL(rawUrl)
    : new URL(rawUrl);
  if (!['https:', 'http:', 'file:'].includes(url.protocol)) {
    throw new Error('Plugin store registry URL must use https, http, or file protocol.');
  }
  return url;
}

async function readUrlBytes(rawUrl: string): Promise<Buffer> {
  const url = validateRegistryUrl(rawUrl);
  if (url.protocol === 'file:') {
    return fs.readFile(fileURLToPath(url));
  }

  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function readJsonUrl(rawUrl: string): Promise<unknown> {
  const bytes = await readUrlBytes(rawUrl);
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
    if (!version) continue;
    versions[versionKey] = {
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

function enrichStorePluginsWithInstalledState(
  registry: CanvasPluginStoreRegistry,
  installedPlugins: CanvasPluginInstallRecord[],
): CanvasPluginStoreList {
  const installedByName = new Map(installedPlugins.map((plugin) => [plugin.name, plugin]));
  const plugins = registry.plugins.map((plugin) => {
    const installedPlugin = installedByName.get(plugin.name);
    const updateAvailable = Boolean(
      installedPlugin && compareVersions(plugin.latestVersion, installedPlugin.version) > 0,
    );

    return {
      ...plugin,
      installed: {
        installed: Boolean(installedPlugin),
        enabled: Boolean(installedPlugin?.enabled),
        version: installedPlugin?.version,
        updateAvailable,
        installedPlugin,
      },
    };
  });

  const { plugins: _plugins, ...registryMetadata } = registry;
  return {
    registry: registryMetadata,
    plugins,
  };
}

export async function listCanvasPluginStore(): Promise<CanvasPluginStoreList> {
  const [registry, installedPlugins] = await Promise.all([
    readCanvasPluginStoreRegistry(),
    listCanvasPlugins(),
  ]);
  return enrichStorePluginsWithInstalledState(registry, installedPlugins);
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
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, bytes);
    extractedCount += 1;
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

export async function installCanvasPluginFromStore(
  pluginName: string,
  version?: string,
  options: { enable?: boolean; replace?: boolean; installedBy?: string } = {},
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

  let tempRoot: string | null = null;
  try {
    const archiveBytes = await readUrlBytes(storeVersion.downloadUrl);
    const extracted = await extractPackageFromArchive(archiveBytes, storeVersion.packagePath);
    tempRoot = extracted.tempRoot;
    await verifyPackageChecksum(extracted.packageRoot, storeVersion.checksum);

    const installResult = await installCanvasPluginFromPath(extracted.packageRoot, {
      enable: options.enable,
      replace: options.replace ?? true,
      installedBy: options.installedBy,
      sourcePathLabel: storeVersion.downloadUrl,
      sourceRegistryId: registry.id,
      sourceRegistryUrl: registry.registryUrl,
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
