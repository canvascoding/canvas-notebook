import 'server-only';

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import JSZip from 'jszip';

import { createCapabilityResourceId } from '@/app/lib/capabilities/reference';
import {
  createAtomicTempPath,
  resolveReadableScopedSkillsDataDir,
  resolveScopedSkillBackupsDir,
  resolveScopedSkillRegistryPath,
  resolveScopedSkillsDataDir,
  resolveDataStorageScope,
  shouldUseLegacyScopedSkillsFallback,
  type DataStorageScopeType,
  type UserScopedDataStorageScope,
} from '@/app/lib/runtime-data-paths';
import { computeCanvasPluginChecksum } from '@/app/lib/plugins/canvas-plugin-registry';
import {
  findSensitiveCanvasPackageFiles,
  isValidCanvasPluginName,
  isValidCanvasPluginVersion,
} from '@/app/lib/plugins/canvas-plugin-manifest';
import { requirePathInside } from '@/app/lib/security/safe-paths';
import {
  isValidAgentSkillName,
  loadCanvasSkillInterface,
  parseSkillFile,
  type CanvasSkillInterface,
} from '@/app/lib/skills/canvas-skill-manifest';
import { coreSkillInstallError, isCoreSkillName } from '@/app/lib/skills/core-skills';
import { loadCoreSkillByName } from '@/app/lib/skills/core-skill-loader';
import { loadSkillByName, getSkillNames } from '@/app/lib/skills/skill-loader';
import { loadSkillSummaries, type SkillSummary } from '@/app/lib/skills/skill-summaries';
import { DISABLED_ALL_SKILLS_SENTINEL, enableSkillInConfig } from '@/app/lib/skills/enabled-skills';
import { adoptLegacyStandaloneSkillsForScope } from '@/app/lib/skills/legacy-skill-adoption';
import { readEnabledSkillsForScope, writeEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';

export const DEFAULT_CANVAS_SKILL_STORE_REGISTRY_URL =
  'https://raw.githubusercontent.com/canvascoding/canvas-notebook-plugin-marketplace/main/registry.json';

export interface CanvasSkillStorePublisher {
  name?: string;
  url?: string;
}

export interface CanvasSkillStoreSourcePlugin {
  name: string;
  displayName?: string;
  version?: string;
}

export interface CanvasSkillStoreVersion {
  version: string;
  downloadUrl: string;
  packagePath?: string;
  checksum: string;
  releasedAt?: string;
  minCanvasVersion?: string;
  notes?: string;
}

export interface CanvasSkillStoreSkill {
  name: string;
  displayName: string;
  description: string;
  category?: string;
  publisher?: CanvasSkillStorePublisher;
  latestVersion: string;
  icon?: string;
  iconUrl?: string;
  brandColor?: string;
  license?: string;
  sourcePlugin?: CanvasSkillStoreSourcePlugin;
  versions: Record<string, CanvasSkillStoreVersion>;
}

export interface CanvasSkillStoreRegistry {
  schemaVersion: 1;
  id: string;
  name: string;
  publisher?: CanvasSkillStorePublisher;
  homepage?: string;
  updatedAt: string;
  registryUrl: string;
  skills: CanvasSkillStoreSkill[];
}

export interface CanvasSkillInstallRecord {
  resourceId?: string;
  scopeType?: DataStorageScopeType;
  organizationId?: string | null;
  ownerUserId?: string | null;
  revision?: number;
  name: string;
  version: string;
  description: string;
  license?: string;
  sourceType: 'store' | 'seed' | 'local' | 'plugin';
  sourcePath?: string;
  sourceRegistryId?: string;
  sourceRegistryUrl?: string;
  sourcePluginName?: string;
  sourcePluginVersion?: string;
  installedAt: string;
  updatedAt: string;
  checksum: string;
  installDir: string;
  skillPath: string;
  interface?: CanvasSkillInterface;
}

export interface CanvasSkillRegistry {
  version: 1;
  updatedAt: string;
  skills: Record<string, CanvasSkillInstallRecord>;
}

export interface CanvasSkillStoreInstalledState {
  installed: boolean;
  enabled: boolean;
  version?: string;
  updateAvailable: boolean;
  modified: boolean;
  restoreAvailable: boolean;
  installedSkill?: CanvasSkillInstallRecord;
}

export type CanvasSkillStoreSkillWithState = CanvasSkillStoreSkill & {
  installed: CanvasSkillStoreInstalledState;
};

export type CanvasSkillStoreStateFilter = 'all' | 'available' | 'installed' | 'updates';

export interface CanvasSkillStoreListOptions {
  page?: number;
  pageSize?: number;
  query?: string;
  state?: CanvasSkillStoreStateFilter;
  scope?: CanvasSkillStoreScope | null;
}

export interface CanvasSkillStorePagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface CanvasSkillStoreStats {
  total: number;
  installed: number;
  available: number;
  updates: number;
  filteredTotal: number;
}

export interface CanvasSkillStoreList {
  registry: Omit<CanvasSkillStoreRegistry, 'skills'>;
  skills: CanvasSkillStoreSkillWithState[];
  pagination: CanvasSkillStorePagination;
  stats: CanvasSkillStoreStats;
}

export interface CanvasSkillStoreInstallResult {
  success: boolean;
  error?: string;
  skill?: CanvasSkillInstallRecord;
  storeSkill?: CanvasSkillStoreSkill;
  storeVersion?: CanvasSkillStoreVersion;
  backupPath?: string;
}

export type CanvasSkillStoreScope = UserScopedDataStorageScope;

export interface CanvasSkillsResetResult {
  success: boolean;
  skillsDir: string;
  deletedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePublisher(value: unknown): CanvasSkillStorePublisher | undefined {
  if (!isRecord(value)) return undefined;
  const publisher = {
    name: stringValue(value.name),
    url: stringValue(value.url),
  };
  return publisher.name || publisher.url ? publisher : undefined;
}

function normalizeSourcePlugin(value: unknown): CanvasSkillStoreSourcePlugin | undefined {
  if (!isRecord(value)) return undefined;
  const name = stringValue(value.name);
  if (!name || !isValidCanvasPluginName(name)) return undefined;
  return {
    name,
    displayName: stringValue(value.displayName ?? value.display_name),
    version: stringValue(value.version),
  };
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

function getRegistryUrl(): string {
  return process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL?.trim()
    || DEFAULT_CANVAS_SKILL_STORE_REGISTRY_URL;
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
  if (!['https:', 'http:', 'file:'].includes(url.protocol)) {
    throw new Error('Skill store registry URL must use https, http, or file protocol.');
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

function normalizeStoreVersion(value: unknown): CanvasSkillStoreVersion | null {
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
    releasedAt: stringValue(value.releasedAt ?? value.released_at),
    minCanvasVersion: stringValue(value.minCanvasVersion ?? value.min_canvas_version),
    notes: stringValue(value.notes),
  };
}

function normalizeStoreSkill(value: unknown, registryUrl: string): CanvasSkillStoreSkill | null {
  if (!isRecord(value)) return null;
  const name = stringValue(value.name);
  const latestVersion = stringValue(value.latestVersion ?? value.latest_version);
  if (!name || !latestVersion || !isValidAgentSkillName(name) || !isValidCanvasPluginVersion(latestVersion)) {
    return null;
  }

  const rawVersions = isRecord(value.versions) ? value.versions : {};
  const versions: Record<string, CanvasSkillStoreVersion> = {};
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
    license: stringValue(value.license),
    sourcePlugin: normalizeSourcePlugin(value.sourcePlugin ?? value.source_plugin),
    versions,
  };
}

export async function readCanvasSkillStoreRegistry(): Promise<CanvasSkillStoreRegistry> {
  const registryUrl = getRegistryUrl();
  const parsed = await readJsonUrl(registryUrl);
  if (!isRecord(parsed)) {
    throw new Error('Skill store registry must be a JSON object.');
  }

  const id = stringValue(parsed.id);
  const name = stringValue(parsed.name);
  const schemaVersion = parsed.schemaVersion;
  const updatedAt = stringValue(parsed.updatedAt);
  if (schemaVersion !== 1 || !id || !name || !updatedAt) {
    throw new Error('Skill store registry is missing required metadata.');
  }

  const skills = Array.isArray(parsed.skills)
    ? parsed.skills
      .map((entry) => normalizeStoreSkill(entry, registryUrl))
      .filter((entry): entry is CanvasSkillStoreSkill => Boolean(entry))
    : [];

  return {
    schemaVersion: 1,
    id,
    name,
    publisher: normalizePublisher(parsed.publisher),
    homepage: stringValue(parsed.homepage),
    updatedAt,
    registryUrl,
    skills: skills.sort((left, right) => left.displayName.localeCompare(right.displayName)),
  };
}

function createEmptySkillRegistry(): CanvasSkillRegistry {
  return {
    version: 1,
    updatedAt: nowIso(),
    skills: {},
  };
}

async function ensureSkillRoot(scope?: CanvasSkillStoreScope | null): Promise<void> {
  await fs.mkdir(resolveScopedSkillsDataDir(scope), { recursive: true });
}

async function readCanvasSkillRegistryFile(registryPath: string): Promise<CanvasSkillRegistry | null> {
  try {
    const raw = await fs.readFile(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as CanvasSkillRegistry;
    if (!parsed || parsed.version !== 1 || !parsed.skills || typeof parsed.skills !== 'object') {
      return createEmptySkillRegistry();
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.warn('[CanvasSkillRegistry] Failed to read registry, using empty registry:', error);
    return createEmptySkillRegistry();
  }
}

async function migrateOrganizationSkillLayout(
  registry: CanvasSkillRegistry,
  scope?: CanvasSkillStoreScope | null,
): Promise<CanvasSkillRegistry> {
  if (resolveDataStorageScope(scope).scopeType !== 'organization') {
    return registry;
  }

  const installedRoot = requirePathInside(resolveScopedSkillsDataDir(scope), 'installed');
  let changed = false;

  for (const [registryName, record] of Object.entries(registry.skills)) {
    if (
      !record
      || typeof record.name !== 'string'
      || typeof record.version !== 'string'
      || typeof record.installDir !== 'string'
      || !isValidAgentSkillName(record.name)
      || record.name !== registryName
      || !isValidCanvasPluginVersion(record.version)
    ) {
      continue;
    }

    const legacyDir = requirePathInside(installedRoot, record.name, record.version);
    if (path.resolve(record.installDir) !== path.resolve(legacyDir)) {
      continue;
    }

    const canonicalDir = requirePathInside(legacyDir, record.name);
    const canonicalSkillPath = requirePathInside(canonicalDir, 'SKILL.md');
    const legacySkillPath = requirePathInside(legacyDir, 'SKILL.md');
    const stagingDir = requirePathInside(
      path.dirname(legacyDir),
      `${path.basename(legacyDir)}.agent-skills-migration`,
    );
    let canonicalExists = await fs.stat(canonicalSkillPath).then((stat) => stat.isFile()).catch(() => false);
    const legacyExists = await fs.stat(legacySkillPath).then((stat) => stat.isFile()).catch(() => false);
    const stagingExists = await fs.stat(requirePathInside(stagingDir, 'SKILL.md'))
      .then((stat) => stat.isFile())
      .catch(() => false);

    try {
      if (!canonicalExists && stagingExists) {
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.rename(stagingDir, canonicalDir);
        canonicalExists = true;
      } else if (!canonicalExists && legacyExists && !stagingExists) {
        await fs.rename(legacyDir, stagingDir);
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.rename(stagingDir, canonicalDir);
        canonicalExists = true;
      }
    } catch (error) {
      const recoverableStaging = await fs.stat(requirePathInside(stagingDir, 'SKILL.md'))
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (recoverableStaging) {
        await fs.rmdir(legacyDir).catch(() => undefined);
        await fs.rename(stagingDir, legacyDir).catch(() => undefined);
      }
      console.warn('[CanvasSkillRegistry] Failed to migrate organization skill layout.', {
        skill: record.name,
        version: record.version,
        error,
      });
      continue;
    }

    if (!canonicalExists) {
      continue;
    }

    registry.skills[registryName] = {
      ...record,
      installDir: canonicalDir,
      skillPath: canonicalSkillPath,
    };
    changed = true;
  }

  if (changed) {
    await writeCanvasSkillRegistry(registry, scope);
  }
  return registry;
}

export async function readCanvasSkillRegistry(scope?: CanvasSkillStoreScope | null): Promise<CanvasSkillRegistry> {
  const registryPath = resolveScopedSkillRegistryPath(scope);
  const registry = await readCanvasSkillRegistryFile(registryPath);
  if (registry) {
    return migrateOrganizationSkillLayout(registry, scope);
  }

  if (await shouldUseLegacyScopedSkillsFallback(scope)) {
    const legacyRegistry = await readCanvasSkillRegistryFile(resolveScopedSkillRegistryPath());
    if (legacyRegistry) {
      return legacyRegistry;
    }
  }

  return createEmptySkillRegistry();
}

export async function writeCanvasSkillRegistry(
  registry: CanvasSkillRegistry,
  scope?: CanvasSkillStoreScope | null,
): Promise<void> {
  await ensureSkillRoot(scope);
  const registryPath = resolveScopedSkillRegistryPath(scope);
  const tmpPath = createAtomicTempPath(registryPath);
  const nextRegistry: CanvasSkillRegistry = {
    ...registry,
    version: 1,
    updatedAt: nowIso(),
  };
  await fs.writeFile(tmpPath, `${JSON.stringify(nextRegistry, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, registryPath);
}

export async function removeCanvasSkillRegistryRecord(
  skillName: string,
  scope?: CanvasSkillStoreScope | null,
): Promise<void> {
  const registry = await readCanvasSkillRegistry(scope);
  if (!registry.skills[skillName]) {
    return;
  }
  delete registry.skills[skillName];
  await writeCanvasSkillRegistry(registry, scope);
}

export async function resetCanvasSkillsDirectory(
  updatedBy = 'unknown',
  scope?: CanvasSkillStoreScope | null,
): Promise<CanvasSkillsResetResult> {
  const skillsDir = resolveScopedSkillsDataDir(scope);
  const deletedAt = nowIso();

  await fs.rm(skillsDir, { recursive: true, force: true });
  await fs.mkdir(skillsDir, { recursive: true });
  await writeCanvasSkillRegistry(createEmptySkillRegistry(), scope);

  await writeEnabledSkillsForScope([DISABLED_ALL_SKILLS_SENTINEL], { scope, updatedBy });

  return {
    success: true,
    skillsDir,
    deletedAt,
  };
}

async function listStandaloneSkillSummaries(
  enabledSkills?: string[],
  scope?: CanvasSkillStoreScope | null,
): Promise<SkillSummary[]> {
  const summaries = await loadSkillSummaries(enabledSkills, scope);
  return summaries.filter((skill) => !skill.plugin);
}

async function seedSkillExists(skillName: string): Promise<boolean> {
  const seedPath = path.join(process.cwd(), 'seed_skills', skillName, 'SKILL.md');
  const stat = await fs.stat(seedPath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function enrichStoreSkillsWithInstalledState(
  registry: CanvasSkillStoreRegistry,
  scope?: CanvasSkillStoreScope | null,
): Promise<{ registry: Omit<CanvasSkillStoreRegistry, 'skills'>; skills: CanvasSkillStoreSkillWithState[]; stats: Omit<CanvasSkillStoreStats, 'filteredTotal'> }> {
  const [localRegistry, enabledSkills] = await Promise.all([
    readCanvasSkillRegistry(scope),
    readEnabledSkillsForScope(scope),
  ]);
  const standaloneSkills = await listStandaloneSkillSummaries(enabledSkills, scope);
  const standaloneByName = new Map(standaloneSkills.map((skill) => [skill.name, skill]));

  const skills = registry.skills.map((skill) => {
    const installedSummary = standaloneByName.get(skill.name);
    const installedSkill = localRegistry.skills[skill.name];
    const installedVersion = installedSkill?.version || installedSummary?.version;
    const updateAvailable = Boolean(
      installedSummary && installedVersion && compareVersions(skill.latestVersion, installedVersion) > 0,
    );

    return {
      ...skill,
      installed: {
        installed: Boolean(installedSkill || installedSummary),
        enabled: installedSummary?.enabled ?? Boolean(installedSkill),
        version: installedVersion,
        updateAvailable,
        modified: false,
        restoreAvailable: Boolean(installedSkill || installedSummary),
        installedSkill,
      },
    };
  });

  const { skills: _skills, ...registryMetadata } = registry;
  return {
    registry: registryMetadata,
    skills,
    stats: {
      total: skills.length,
      installed: skills.filter((skill) => skill.installed.installed).length,
      available: skills.filter((skill) => !skill.installed.installed).length,
      updates: skills.filter((skill) => skill.installed.updateAvailable).length,
    },
  };
}

function matchesStoreQuery(skill: CanvasSkillStoreSkillWithState, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    skill.name,
    skill.displayName,
    skill.description,
    skill.category,
  ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
}

function matchesState(skill: CanvasSkillStoreSkillWithState, state: CanvasSkillStoreStateFilter): boolean {
  if (state === 'available') return !skill.installed.installed;
  if (state === 'installed') return skill.installed.installed;
  if (state === 'updates') return skill.installed.updateAvailable;
  return true;
}

async function addPageStateDetails(
  skill: CanvasSkillStoreSkillWithState,
  scope?: CanvasSkillStoreScope | null,
): Promise<CanvasSkillStoreSkillWithState> {
  if (!skill.installed.installed) return skill;

  const record = skill.installed.installedSkill;
  const installDir = record?.installDir || path.join(await resolveReadableScopedSkillsDataDir(scope), skill.name);
  const [seedAvailable, currentChecksum] = await Promise.all([
    seedSkillExists(skill.name),
    record?.checksum ? computeCanvasPluginChecksum(installDir).catch(() => '') : Promise.resolve(''),
  ]);

  return {
    ...skill,
    installed: {
      ...skill.installed,
      modified: Boolean(record?.checksum && currentChecksum && currentChecksum !== record.checksum),
      restoreAvailable: seedAvailable || Boolean(skill.versions[skill.latestVersion]),
    },
  };
}

export async function listCanvasSkillStore(options: CanvasSkillStoreListOptions = {}): Promise<CanvasSkillStoreList> {
  const registry = await readCanvasSkillStoreRegistry();
  const enriched = await enrichStoreSkillsWithInstalledState(registry, options.scope);
  const pageSize = clampPositiveInteger(options.pageSize, 12, 50);
  const page = clampPositiveInteger(options.page, 1, 100000);
  const state = options.state || 'all';
  const filtered = enriched.skills.filter((skill) => (
    matchesState(skill, state) && matchesStoreQuery(skill, options.query || '')
  ));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const offset = (normalizedPage - 1) * pageSize;
  const pageSkills = await Promise.all(filtered.slice(offset, offset + pageSize).map((skill) => addPageStateDetails(skill, options.scope)));

  return {
    registry: enriched.registry,
    skills: pageSkills,
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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-store-'));
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

    const targetPath = requirePathInside(packageRoot, relativePath);

    const bytes = await entry.async('nodebuffer');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, bytes);
    extractedCount += 1;
  }

  if (extractedCount === 0) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw new Error('Skill package path was not found in the downloaded archive.');
  }

  return { tempRoot, packageRoot };
}

async function verifyPackageChecksum(packageRoot: string, expectedChecksum: string): Promise<void> {
  const actual = await computeCanvasPluginChecksum(packageRoot);
  const expected = normalizeChecksum(expectedChecksum);
  if (actual !== expected) {
    throw new Error(`Skill checksum mismatch (${actual.slice(0, 12)}).`);
  }
}

async function validateSkillPackage(
  packageRoot: string,
  expectedName: string,
  options: { validateDirectoryName?: boolean } = {},
) {
  const sensitiveFiles = await findSensitiveCanvasPackageFiles(packageRoot);
  if (sensitiveFiles.length > 0) {
    throw new Error(`Skill packages must reference environment variable names instead of bundling secret files: ${sensitiveFiles.slice(0, 5).join(', ')}${sensitiveFiles.length > 5 ? ', ...' : ''}`);
  }
  const skillPath = requirePathInside(packageRoot, 'SKILL.md');
  const stat = await fs.stat(skillPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error('Skill package must contain SKILL.md at its root.');
  }

  const skill = await parseSkillFile(skillPath, {
    validateDirectoryName: options.validateDirectoryName ?? false,
  });
  if (!skill) {
    throw new Error('Skill package contains an invalid SKILL.md.');
  }
  if (skill.name !== expectedName) {
    throw new Error(`Skill package name mismatch: expected "${expectedName}", got "${skill.name}".`);
  }
  return skill;
}

async function backupExistingSkill(
  skillName: string,
  scope?: CanvasSkillStoreScope | null,
): Promise<string | undefined> {
  if (resolveDataStorageScope(scope).scopeType === 'organization') {
    return undefined;
  }
  const skillsDir = await resolveReadableScopedSkillsDataDir(scope);
  const skillDir = requirePathInside(skillsDir, skillName);
  const stat = await fs.stat(skillDir).catch(() => null);
  if (!stat?.isDirectory()) return undefined;

  const backupRoot = requirePathInside(resolveScopedSkillBackupsDir(scope), skillName);
  const backupDir = requirePathInside(backupRoot, nowIso().replace(/[:.]/g, '-'));
  await fs.mkdir(path.dirname(backupDir), { recursive: true });
  await fs.cp(skillDir, backupDir, { recursive: true, preserveTimestamps: true });
  return backupDir;
}

async function copySkillPackage(
  packageRoot: string,
  skillName: string,
  version: string,
  scope?: CanvasSkillStoreScope | null,
): Promise<string> {
  const skillsDir = resolveScopedSkillsDataDir(scope);
  const storageScope = resolveDataStorageScope(scope);
  const targetDir = storageScope.scopeType === 'organization'
    ? requirePathInside(skillsDir, 'installed', skillName, version, skillName)
    : requirePathInside(skillsDir, skillName);
  const resolvedTarget = path.resolve(/*turbopackIgnore: true*/ targetDir);
  const resolvedSkillsDir = path.resolve(/*turbopackIgnore: true*/ skillsDir);
  if (!resolvedTarget.startsWith(`${resolvedSkillsDir}${path.sep}`)) {
    throw new Error('Invalid skill name: path traversal detected.');
  }

  const existingTarget = await fs.stat(targetDir).catch(() => null);
  if (existingTarget && storageScope.scopeType === 'organization') {
    const [existingChecksum, incomingChecksum] = await Promise.all([
      computeCanvasPluginChecksum(targetDir),
      computeCanvasPluginChecksum(packageRoot),
    ]);
    if (existingChecksum !== incomingChecksum) {
      throw new Error('Organization skill package contents changed without a version bump. Publish a new version.');
    }
    return targetDir;
  }

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(requirePathInside(packageRoot, '.'), targetDir, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => !['.git', 'node_modules', '.DS_Store'].includes(path.basename(source)),
  });
  return targetDir;
}

async function enableInstalledSkill(
  skillName: string,
  scope?: CanvasSkillStoreScope | null,
  updatedBy?: string,
): Promise<void> {
  const enabledSkills = await readEnabledSkillsForScope(scope);
  const registry = await readCanvasSkillRegistry(scope);
  const allSkillNames = Array.from(new Set([
    ...await getSkillNames(scope),
    ...Object.keys(registry.skills),
    skillName,
  ]));
  const nextEnabledSkills = enableSkillInConfig(skillName, enabledSkills, allSkillNames);
  await writeEnabledSkillsForScope(nextEnabledSkills, { scope, updatedBy });
}

async function writeInstalledSkillRecord(
  skillName: string,
  version: string,
  sourceType: CanvasSkillInstallRecord['sourceType'],
  sourcePath: string,
  sourceRegistry: { id?: string; url?: string } | undefined,
  installDir: string,
  scope?: CanvasSkillStoreScope | null,
): Promise<CanvasSkillInstallRecord> {
  const skill = await validateSkillPackage(installDir, skillName, { validateDirectoryName: true });
  const checksum = await computeCanvasPluginChecksum(installDir);
  const registry = await readCanvasSkillRegistry(scope);
  const existing = registry.skills[skillName];
  const storageScope = resolveDataStorageScope(scope);
  const record: CanvasSkillInstallRecord = {
    resourceId: createCapabilityResourceId({
      resourceType: 'skill',
      scopeType: storageScope.scopeType === 'legacy' ? 'system' : storageScope.scopeType,
      name: skill.name,
      sourceType: 'standalone',
      organizationId: storageScope.organizationId,
      ownerUserId: storageScope.userId,
    }),
    scopeType: storageScope.scopeType,
    organizationId: storageScope.organizationId,
    ownerUserId: storageScope.userId,
    revision: (existing?.revision || 0) + 1,
    name: skill.name,
    version,
    description: skill.description,
    license: skill.license,
    sourceType,
    sourcePath,
    sourceRegistryId: sourceRegistry?.id,
    sourceRegistryUrl: sourceRegistry?.url,
    installedAt: existing?.installedAt || nowIso(),
    updatedAt: nowIso(),
    checksum,
    installDir,
    skillPath: requirePathInside(installDir, 'SKILL.md'),
    interface: await loadCanvasSkillInterface(installDir),
  };
  registry.skills[skillName] = record;
  await writeCanvasSkillRegistry(registry, scope);
  return record;
}

async function ensureStandaloneSkillInstallAllowed(
  skillName: string,
  replace: boolean,
  scope?: CanvasSkillStoreScope | null,
): Promise<void> {
  if (isCoreSkillName(skillName)) {
    throw new Error(coreSkillInstallError(skillName));
  }

  const registered = (await readCanvasSkillRegistry(scope)).skills[skillName];
  const existing = await loadSkillByName(skillName, scope, { legacyFallback: false });
  const standalonePath = requirePathInside(resolveScopedSkillsDataDir(scope), skillName, 'SKILL.md');
  const hasStandalone = await fs.stat(standalonePath).then((stat) => stat.isFile()).catch(() => false);
  if (existing?.plugin) {
    throw new Error(`Skill "${skillName}" is managed by plugin "${existing.plugin.name}". Remove or disable that plugin first.`);
  }
  if (existing && !hasStandalone) {
    throw new Error(`Skill "${skillName}" already exists and is not a standalone skill.`);
  }
  if ((hasStandalone || registered) && !replace) {
    throw new Error(`Skill "${skillName}" is already installed. Use replace to reinstall it.`);
  }
}

export async function installCanvasSkillFromStore(
  skillName: string,
  version?: string,
  options: {
    enable?: boolean;
    replace?: boolean;
    scope?: CanvasSkillStoreScope | null;
    updatedBy?: string;
  } = {},
): Promise<CanvasSkillStoreInstallResult> {
  if (!isValidAgentSkillName(skillName)) {
    return { success: false, error: 'Invalid skill name' };
  }
  if (isCoreSkillName(skillName)) {
    return { success: false, error: coreSkillInstallError(skillName) };
  }
  if (version && !isValidCanvasPluginVersion(version)) {
    return { success: false, error: 'Invalid skill version' };
  }

  let tempRoot: string | null = null;
  try {
    await adoptLegacyStandaloneSkillsForScope(options.scope);

    const registry = await readCanvasSkillStoreRegistry();
    const storeSkill = registry.skills.find((skill) => skill.name === skillName);
    if (!storeSkill) {
      return { success: false, error: `Skill "${skillName}" not found in the Canvas Skill Library.` };
    }
    const selectedVersion = version || storeSkill.latestVersion;
    const storeVersion = storeSkill.versions[selectedVersion];
    if (!storeVersion) {
      return { success: false, error: `Version ${selectedVersion} is not available for skill "${skillName}".`, storeSkill };
    }

    await ensureStandaloneSkillInstallAllowed(skillName, options.replace ?? true, options.scope);
    const archiveBytes = await readUrlBytes(storeVersion.downloadUrl);
    const extracted = await extractPackageFromArchive(archiveBytes, storeVersion.packagePath);
    tempRoot = extracted.tempRoot;
    await verifyPackageChecksum(extracted.packageRoot, storeVersion.checksum);
    await validateSkillPackage(extracted.packageRoot, skillName);
    const backupPath = await backupExistingSkill(skillName, options.scope);
    const installDir = await copySkillPackage(extracted.packageRoot, skillName, selectedVersion, options.scope);
    const record = await writeInstalledSkillRecord(
      skillName,
      selectedVersion,
      'store',
      storeVersion.downloadUrl,
      { id: registry.id, url: registry.registryUrl },
      installDir,
      options.scope,
    );

    if (options.enable !== false) {
      await enableInstalledSkill(skillName, options.scope, options.updatedBy).catch((error) => {
        console.warn('[CanvasSkillStore] Failed to auto-enable skill:', error);
      });
    }

    return { success: true, skill: record, storeSkill, storeVersion, backupPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install skill from store',
    };
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function restoreSeedSkill(
  skillName: string,
  options: {
    enable?: boolean;
    replace?: boolean;
    scope?: CanvasSkillStoreScope | null;
    updatedBy?: string;
  } = {},
): Promise<CanvasSkillStoreInstallResult> {
  const seedRoot = path.join(process.cwd(), 'seed_skills', skillName);
  const skillPath = path.join(seedRoot, 'SKILL.md');
  const stat = await fs.stat(skillPath).catch(() => null);
  if (!stat?.isFile()) {
    return { success: false, error: `No seed skill named "${skillName}" is available.` };
  }

  try {
    await adoptLegacyStandaloneSkillsForScope(options.scope);

    await ensureStandaloneSkillInstallAllowed(skillName, options.replace ?? true, options.scope);
    await validateSkillPackage(seedRoot, skillName);
    const backupPath = await backupExistingSkill(skillName, options.scope);
    const sourceSkill = await validateSkillPackage(seedRoot, skillName);
    const installDir = await copySkillPackage(seedRoot, skillName, sourceSkill.version || 'seed', options.scope);
    const skill = await validateSkillPackage(installDir, skillName);
    const record = await writeInstalledSkillRecord(
      skillName,
      skill.version || 'seed',
      'seed',
      seedRoot,
      undefined,
      installDir,
      options.scope,
    );

    if (options.enable !== false) {
      await enableInstalledSkill(skillName, options.scope, options.updatedBy).catch((error) => {
        console.warn('[CanvasSkillStore] Failed to auto-enable restored seed skill:', error);
      });
    }

    return { success: true, skill: record, backupPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to restore seed skill',
    };
  }
}

export async function restoreCanvasSkill(
  skillName: string,
  options: {
    enable?: boolean;
    prefer?: 'store' | 'seed';
    version?: string;
    scope?: CanvasSkillStoreScope | null;
    updatedBy?: string;
  } = {},
): Promise<CanvasSkillStoreInstallResult> {
  if (!isValidAgentSkillName(skillName)) {
    return { success: false, error: 'Invalid skill name' };
  }
  if (isCoreSkillName(skillName)) {
    const coreSkill = await loadCoreSkillByName(skillName);
    return coreSkill
      ? { success: true }
      : { success: false, error: `Core skill "${skillName}" is missing from the Canvas application bundle.` };
  }

  if (options.prefer !== 'seed') {
    const storeResult = await installCanvasSkillFromStore(skillName, options.version, {
      enable: options.enable,
      replace: true,
      scope: options.scope,
      updatedBy: options.updatedBy,
    });
    if (storeResult.success || options.prefer === 'store') {
      return storeResult;
    }
  }

  return restoreSeedSkill(skillName, {
    enable: options.enable,
    replace: true,
    scope: options.scope,
    updatedBy: options.updatedBy,
  });
}
