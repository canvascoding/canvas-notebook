import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import {
  createAtomicTempPath,
  resolveReadableScopedSkillsDataDir,
  resolveScopedInstalledPluginsDir,
  resolveScopedPluginRegistryPath,
  resolveScopedPluginsDataDir,
  resolveScopedSkillRegistryPath,
  resolveScopedSkillsDataDir,
  shouldUseLegacyScopedPluginsFallback,
  type UserScopedDataStorageScope,
} from '@/app/lib/runtime-data-paths';
import {
  disableSkillInConfig,
  enableSkillInConfig,
  resolveEnabledSkillNames,
} from '@/app/lib/skills/enabled-skills';
import {
  parseSkillFile,
  type CanvasSkill,
} from '@/app/lib/skills/canvas-skill-manifest';
import { adoptLegacyStandaloneSkillsForScope } from '@/app/lib/skills/legacy-skill-adoption';
import { readEnabledSkillsForScope, writeEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';
import {
  isPathInside,
  isValidCanvasPluginName,
  validateCanvasPluginPackage,
  type CanvasPluginConnectorManifest,
  type CanvasPluginInterface,
  type CanvasPluginManifest,
  type CanvasPluginValidationResult,
} from '@/app/lib/plugins/canvas-plugin-manifest';

export interface CanvasPluginSkillRecord {
  name: string;
  title: string;
  description: string;
  version?: string;
  path: string;
  directory: string;
  sourceType?: 'bundled' | 'seed';
  materialized?: boolean;
  preexistingStandalone?: boolean;
  standaloneDir?: string;
}

export interface CanvasPluginInstallRecord {
  name: string;
  version: string;
  description: string;
  license?: string;
  author?: CanvasPluginManifest['author'];
  source?: string;
  sourcePath?: string;
  installedAt: string;
  updatedAt: string;
  enabled: boolean;
  checksum: string;
  sourceRegistryId?: string;
  sourceRegistryUrl?: string;
  installDir: string;
  manifestPath: string;
  skillsDir?: string;
  skills: CanvasPluginSkillRecord[];
  interface?: CanvasPluginInterface;
  connectors?: CanvasPluginConnectorManifest;
}

export interface CanvasPluginRegistry {
  version: 1;
  updatedAt: string;
  plugins: Record<string, CanvasPluginInstallRecord>;
}

interface StandaloneSkillRegistryRecord {
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
  interface?: CanvasSkill['interface'];
}

interface StandaloneSkillRegistry {
  version: 1;
  updatedAt: string;
  skills: Record<string, StandaloneSkillRegistryRecord>;
}

export interface CanvasPluginInstallOptions {
  enable?: boolean;
  replace?: boolean;
  installedBy?: string;
  sourcePathLabel?: string;
  sourceRegistryId?: string;
  sourceRegistryUrl?: string;
  scope?: CanvasPluginStorageScope | null;
}

export interface CanvasPluginInstallResult {
  success: boolean;
  error?: string;
  validation?: CanvasPluginValidationResult;
  plugin?: CanvasPluginInstallRecord;
}

export type CanvasPluginStorageScope = UserScopedDataStorageScope;

const IGNORED_CHECKSUM_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store']);
const SEED_SKILLS_DIR = path.join(process.cwd(), 'seed_skills');

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyRegistry(): CanvasPluginRegistry {
  return {
    version: 1,
    updatedAt: nowIso(),
    plugins: {},
  };
}

function createEmptyStandaloneSkillRegistry(): StandaloneSkillRegistry {
  return {
    version: 1,
    updatedAt: nowIso(),
    skills: {},
  };
}

async function ensurePluginsRoot(scope?: CanvasPluginStorageScope | null): Promise<void> {
  await fs.mkdir(resolveScopedPluginsDataDir(scope), { recursive: true });
  await fs.mkdir(resolveScopedInstalledPluginsDir(scope), { recursive: true });
}

async function readCanvasPluginRegistryFile(registryPath: string): Promise<CanvasPluginRegistry | null> {
  try {
    const raw = await fs.readFile(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as CanvasPluginRegistry;
    if (!parsed || parsed.version !== 1 || !parsed.plugins || typeof parsed.plugins !== 'object') {
      return createEmptyRegistry();
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.warn('[CanvasPluginRegistry] Failed to read registry, using empty registry:', error);
    return createEmptyRegistry();
  }
}

export async function readCanvasPluginRegistry(scope?: CanvasPluginStorageScope | null): Promise<CanvasPluginRegistry> {
  const registryPath = resolveScopedPluginRegistryPath(scope);
  const registry = await readCanvasPluginRegistryFile(registryPath);
  if (registry) {
    return registry;
  }

  if (await shouldUseLegacyScopedPluginsFallback(scope)) {
    const legacyRegistry = await readCanvasPluginRegistryFile(resolveScopedPluginRegistryPath());
    if (legacyRegistry) {
      return legacyRegistry;
    }
  }

  return createEmptyRegistry();
}

export async function writeCanvasPluginRegistry(
  registry: CanvasPluginRegistry,
  scope?: CanvasPluginStorageScope | null,
): Promise<void> {
  await ensurePluginsRoot(scope);
  const registryPath = resolveScopedPluginRegistryPath(scope);
  const tmpPath = createAtomicTempPath(registryPath);
  const nextRegistry: CanvasPluginRegistry = {
    ...registry,
    version: 1,
    updatedAt: nowIso(),
  };
  await fs.writeFile(tmpPath, `${JSON.stringify(nextRegistry, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, registryPath);
}

async function readCanvasPluginRegistryForWrite(
  scope?: CanvasPluginStorageScope | null,
): Promise<CanvasPluginRegistry> {
  const registry = await readCanvasPluginRegistryFile(resolveScopedPluginRegistryPath(scope));
  if (registry) {
    return registry;
  }

  if (await shouldUseLegacyScopedPluginsFallback(scope)) {
    const legacyRegistry = await readCanvasPluginRegistryFile(resolveScopedPluginRegistryPath());
    if (legacyRegistry) {
      return adoptLegacyPluginRegistryForScope(legacyRegistry, scope);
    }
  }

  return createEmptyRegistry();
}

async function adoptLegacyPluginRegistryForScope(
  legacyRegistry: CanvasPluginRegistry,
  scope?: CanvasPluginStorageScope | null,
): Promise<CanvasPluginRegistry> {
  const scopedRegistry = createEmptyRegistry();
  await adoptLegacyStandaloneSkillsForScope(scope);

  for (const [name, record] of Object.entries(legacyRegistry.plugins)) {
    const adopted = await adoptLegacyPluginRecordForScope(record, scope).catch((error) => {
      console.warn(`[CanvasPluginRegistry] Failed to adopt legacy plugin "${name}" for user scope:`, error);
      return null;
    });
    if (adopted) {
      scopedRegistry.plugins[name] = adopted;
    }
  }

  return scopedRegistry;
}

async function adoptLegacyPluginRecordForScope(
  record: CanvasPluginInstallRecord,
  scope?: CanvasPluginStorageScope | null,
): Promise<CanvasPluginInstallRecord> {
  const installDir = resolvePluginInstallDir(record.name, record.version, scope);
  if (path.resolve(/*turbopackIgnore: true*/ record.installDir) !== path.resolve(/*turbopackIgnore: true*/ installDir)) {
    await copyPluginPackage(record.installDir, installDir);
  }

  const validation = await validateCanvasPluginPackage(installDir);
  if (validation.valid && validation.manifest && validation.rootDir) {
    const built = await buildPluginRecordFromInstalledPackage(
      validation.manifest,
      record.sourcePath || record.installDir,
      installDir,
      record.enabled,
      {
        sourcePathLabel: record.sourcePath,
        sourceRegistryId: record.sourceRegistryId,
        sourceRegistryUrl: record.sourceRegistryUrl,
        scope,
      },
    );

    if (built.record) {
      built.record.skills = await materializePluginSkills(built.record, scope);
      return {
        ...built.record,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
      };
    }
  }

  return rebaseLegacyPluginRecordPaths(record, installDir, scope);
}

function rebaseLegacyPluginRecordPaths(
  record: CanvasPluginInstallRecord,
  installDir: string,
  scope?: CanvasPluginStorageScope | null,
): CanvasPluginInstallRecord {
  const rebasePluginPath = (value?: string): string | undefined => {
    if (!value) return undefined;
    return isPathInside(record.installDir, value)
      ? path.join(installDir, path.relative(record.installDir, value))
      : value;
  };
  const rebaseSkillPath = (value?: string): string | undefined => {
    if (!value) return undefined;
    const legacySkillsDir = resolveScopedSkillsDataDir();
    if (!isPathInside(legacySkillsDir, value)) {
      return value;
    }
    return path.join(resolveScopedSkillsDataDir(scope), path.relative(legacySkillsDir, value));
  };

  return {
    ...record,
    installDir,
    manifestPath: rebasePluginPath(record.manifestPath) || path.join(installDir, '.canvas-plugin', 'plugin.json'),
    skillsDir: rebasePluginPath(record.skillsDir),
    skills: record.skills.map((skill) => ({
      ...skill,
      path: rebasePluginPath(skill.path) || skill.path,
      directory: rebasePluginPath(skill.directory) || skill.directory,
      standaloneDir: rebaseSkillPath(skill.standaloneDir),
    })),
    updatedAt: nowIso(),
  };
}

async function readStandaloneSkillRegistry(scope?: CanvasPluginStorageScope | null): Promise<StandaloneSkillRegistry> {
  await fs.mkdir(resolveScopedSkillsDataDir(scope), { recursive: true });
  try {
    const raw = await fs.readFile(resolveScopedSkillRegistryPath(scope), 'utf-8');
    const parsed = JSON.parse(raw) as StandaloneSkillRegistry;
    if (parsed?.version === 1 && parsed.skills && typeof parsed.skills === 'object') {
      return parsed;
    }
  } catch {
    // Missing or invalid registry is recreated below.
  }
  return createEmptyStandaloneSkillRegistry();
}

async function writeStandaloneSkillRegistry(
  registry: StandaloneSkillRegistry,
  scope?: CanvasPluginStorageScope | null,
): Promise<void> {
  await fs.mkdir(resolveScopedSkillsDataDir(scope), { recursive: true });
  const registryPath = resolveScopedSkillRegistryPath(scope);
  const tmpPath = createAtomicTempPath(registryPath);
  await fs.writeFile(tmpPath, `${JSON.stringify({
    ...registry,
    version: 1,
    updatedAt: nowIso(),
  }, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, registryPath);
}

function resolvePluginInstallDir(
  name: string,
  version: string,
  scope?: CanvasPluginStorageScope | null,
): string {
  return path.join(resolveScopedInstalledPluginsDir(scope), name, version);
}

async function listFilesForChecksum(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (IGNORED_CHECKSUM_ENTRIES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesForChecksum(rootDir, fullPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export async function computeCanvasPluginChecksum(rootDir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = await listFilesForChecksum(rootDir);

  for (const relativeFile of files) {
    hash.update(relativeFile);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(rootDir, relativeFile)));
    hash.update('\0');
  }

  return hash.digest('hex');
}

export async function discoverPluginSkillFiles(skillsDir: string): Promise<string[]> {
  try {
    const rootSkillPath = path.join(skillsDir, 'SKILL.md');
    const rootSkillStat = await fs.stat(rootSkillPath).catch(() => null);
    if (rootSkillStat?.isFile()) {
      return [rootSkillPath];
    }

    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const skillFiles: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
      const stat = await fs.stat(skillPath).catch(() => null);
      if (stat?.isFile()) {
        skillFiles.push(skillPath);
      }
    }
    return skillFiles.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function parsePluginSkills(
  pluginName: string,
  pluginVersion: string,
  pluginDisplayName: string | undefined,
  pluginRoot: string,
  skillsDir: string | undefined,
): Promise<{ skills: CanvasSkill[]; records: CanvasPluginSkillRecord[]; errors: string[] }> {
  const skills: CanvasSkill[] = [];
  const records: CanvasPluginSkillRecord[] = [];
  const errors: string[] = [];
  const skillFiles = skillsDir ? await discoverPluginSkillFiles(skillsDir) : [];
  const seen = new Set<string>();

  if (skillsDir && skillFiles.length === 0) {
    errors.push('Plugin must contain at least one SKILL.md under its skills directory.');
  }

  for (const skillFile of skillFiles) {
    const skill = await parseSkillFile(skillFile);
    if (!skill) {
      errors.push(`Invalid skill file: ${skillsDir ? path.relative(skillsDir, skillFile) : skillFile}`);
      continue;
    }

    if (seen.has(skill.name)) {
      errors.push(`Duplicate skill name in plugin: ${skill.name}`);
      continue;
    }

    seen.add(skill.name);
    skill.plugin = {
      name: pluginName,
      version: pluginVersion,
      displayName: pluginDisplayName,
      skillAssetPath: path.relative(pluginRoot, skill.directory),
    };
    skills.push(skill);
    records.push({
      name: skill.name,
      title: skill.title,
      description: skill.description,
      version: skill.version,
      path: skill.path,
      directory: skill.directory,
      sourceType: 'bundled',
    });
  }

  return { skills, records, errors };
}

async function parseReferencedPluginSkills(
  pluginName: string,
  pluginVersion: string,
  pluginDisplayName: string | undefined,
  skillRefs: CanvasPluginManifest['skillRefs'],
  seen: Set<string>,
): Promise<{ skills: CanvasSkill[]; records: CanvasPluginSkillRecord[]; errors: string[] }> {
  const skills: CanvasSkill[] = [];
  const records: CanvasPluginSkillRecord[] = [];
  const errors: string[] = [];

  for (const [index, skillRef] of (skillRefs || []).entries()) {
    if (skillRef.source && skillRef.source !== 'seed') {
      errors.push(`skillRefs[${index}].source: Only "seed" is supported.`);
      continue;
    }

    const skillDir = path.join(SEED_SKILLS_DIR, skillRef.name);
    const resolvedSkillDir = path.resolve(/*turbopackIgnore: true*/ skillDir);
    if (!isPathInside(SEED_SKILLS_DIR, resolvedSkillDir)) {
      errors.push(`skillRefs[${index}].name: Invalid seed skill reference.`);
      continue;
    }

    const skillPath = path.join(skillDir, 'SKILL.md');
    const skill = await parseSkillFile(skillPath);
    if (!skill) {
      errors.push(`skillRefs[${index}]: Seed skill "${skillRef.name}" does not exist or is invalid.`);
      continue;
    }

    if (seen.has(skill.name)) {
      errors.push(`Duplicate skill name in plugin: ${skill.name}`);
      continue;
    }

    seen.add(skill.name);
    skill.plugin = {
      name: pluginName,
      version: pluginVersion,
      displayName: pluginDisplayName,
    };
    skills.push(skill);
    records.push({
      name: skill.name,
      title: skill.title,
      description: skill.description,
      version: skill.version,
      path: skill.path,
      directory: skill.directory,
      sourceType: 'seed',
    });
  }

  return { skills, records, errors };
}

async function parsePluginSkillsFromManifest(
  manifest: CanvasPluginManifest,
  pluginRoot: string,
  skillsDir?: string,
): Promise<{ skills: CanvasSkill[]; records: CanvasPluginSkillRecord[]; errors: string[] }> {
  const bundled = await parsePluginSkills(
    manifest.name,
    manifest.version,
    manifest.interface?.displayName,
    pluginRoot,
    skillsDir,
  );
  const seen = new Set(bundled.records.map((record) => record.name));
  const referenced = await parseReferencedPluginSkills(
    manifest.name,
    manifest.version,
    manifest.interface?.displayName,
    manifest.skillRefs,
    seen,
  );
  const records = [...bundled.records, ...referenced.records];
  const errors = [...bundled.errors, ...referenced.errors];

  if (records.length === 0) {
    errors.push('Plugin must contain at least one bundled skill or skillRef.');
  }

  return {
    skills: [...bundled.skills, ...referenced.skills],
    records,
    errors,
  };
}

async function getStandaloneSkillNames(scope?: CanvasPluginStorageScope | null): Promise<Set<string>> {
  const skillsDir = await resolveReadableScopedSkillsDataDir(scope);
  const names = new Set<string>();

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
      const stat = await fs.stat(skillPath).catch(() => null);
      if (stat?.isFile()) {
        const skill = await parseSkillFile(skillPath);
        names.add(skill?.name || entry.name);
      }
    }
  } catch {
    // No standalone skills directory yet.
  }

  return names;
}

async function copyPluginPackage(sourceRoot: string, targetRoot: string): Promise<void> {
  const resolvedSource = path.resolve(/*turbopackIgnore: true*/ sourceRoot);
  const resolvedTarget = path.resolve(/*turbopackIgnore: true*/ targetRoot);
  if (isPathInside(resolvedSource, resolvedTarget)) {
    throw new Error('Cannot install plugin into a subdirectory of its source.');
  }

  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetRoot), { recursive: true });
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return !IGNORED_CHECKSUM_ENTRIES.has(name);
    },
  });
}

function resolveStandaloneSkillDir(skillName: string, scope?: CanvasPluginStorageScope | null): string {
  return path.join(resolveScopedSkillsDataDir(scope), skillName);
}

async function hasStandaloneSkill(skillName: string, scope?: CanvasPluginStorageScope | null): Promise<boolean> {
  const stat = await fs.stat(path.join(resolveStandaloneSkillDir(skillName, scope), 'SKILL.md')).catch(() => null);
  return Boolean(stat?.isFile());
}

async function writeMaterializedSkillRecord(params: {
  skillName: string;
  version: string;
  sourcePath: string;
  sourceRegistryId?: string;
  sourceRegistryUrl?: string;
  pluginName: string;
  pluginVersion: string;
  installDir: string;
  scope?: CanvasPluginStorageScope | null;
}): Promise<void> {
  const skillPath = path.join(params.installDir, 'SKILL.md');
  const skill = await parseSkillFile(skillPath);
  if (!skill) {
    throw new Error(`Materialized skill "${params.skillName}" is invalid.`);
  }

  const registry = await readStandaloneSkillRegistry(params.scope);
  const existing = registry.skills[params.skillName];
  registry.skills[params.skillName] = {
    name: skill.name,
    version: skill.version || params.version,
    description: skill.description,
    license: skill.license,
    sourceType: 'plugin',
    sourcePath: params.sourcePath,
    sourceRegistryId: params.sourceRegistryId,
    sourceRegistryUrl: params.sourceRegistryUrl,
    sourcePluginName: params.pluginName,
    sourcePluginVersion: params.pluginVersion,
    installedAt: existing?.installedAt || nowIso(),
    updatedAt: nowIso(),
    checksum: await computeCanvasPluginChecksum(params.installDir),
    installDir: params.installDir,
    skillPath,
    interface: skill.interface,
  };
  await writeStandaloneSkillRegistry(registry, params.scope);
}

async function materializePluginSkills(
  record: CanvasPluginInstallRecord,
  scope?: CanvasPluginStorageScope | null,
): Promise<CanvasPluginSkillRecord[]> {
  const skillsDir = resolveScopedSkillsDataDir(scope);
  await fs.mkdir(skillsDir, { recursive: true });
  const materializedSkills: CanvasPluginSkillRecord[] = [];
  const standaloneRegistry = await readStandaloneSkillRegistry(scope);

  for (const skill of record.skills) {
    const standaloneDir = resolveStandaloneSkillDir(skill.name, scope);
    const resolvedStandaloneDir = path.resolve(/*turbopackIgnore: true*/ standaloneDir);
    if (!isPathInside(skillsDir, resolvedStandaloneDir)) {
      throw new Error(`Invalid skill name "${skill.name}": path traversal detected.`);
    }

    const standaloneRecord = standaloneRegistry.skills[skill.name];
    const pluginOwnedStandalone = Boolean(
      standaloneRecord?.sourceType === 'plugin'
      && standaloneRecord.sourcePluginName === record.name,
    );

    if (await hasStandaloneSkill(skill.name, scope) && !pluginOwnedStandalone) {
      materializedSkills.push({
        ...skill,
        materialized: false,
        preexistingStandalone: true,
        standaloneDir,
      });
      continue;
    }

    const existingTarget = await fs.stat(standaloneDir).catch(() => null);
    if (existingTarget && !pluginOwnedStandalone) {
      throw new Error(`Cannot install skill "${skill.name}" because ${standaloneDir} already exists but is not a valid skill.`);
    }

    const resolvedSourceDir = path.resolve(/*turbopackIgnore: true*/ skill.directory);
    const allowedSourceRoot = skill.sourceType === 'seed' ? SEED_SKILLS_DIR : record.installDir;
    if (!isPathInside(allowedSourceRoot, resolvedSourceDir)) {
      throw new Error(
        skill.sourceType === 'seed'
          ? `Plugin skill "${skill.name}" points outside seed_skills.`
          : `Plugin skill "${skill.name}" points outside the plugin package.`,
      );
    }

    if (pluginOwnedStandalone) {
      await fs.rm(standaloneDir, { recursive: true, force: true });
    }

    await fs.cp(skill.directory, standaloneDir, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => !IGNORED_CHECKSUM_ENTRIES.has(path.basename(source)),
    });
    await writeMaterializedSkillRecord({
      skillName: skill.name,
      version: skill.version || record.version,
      sourcePath: skill.directory,
      sourceRegistryId: record.sourceRegistryId,
      sourceRegistryUrl: record.sourceRegistryUrl,
      pluginName: record.name,
      pluginVersion: record.version,
      installDir: standaloneDir,
      scope,
    });
    materializedSkills.push({
      ...skill,
      materialized: true,
      preexistingStandalone: false,
      standaloneDir,
    });
  }

  return materializedSkills;
}

function getPluginRuntimeSkillNames(plugin: CanvasPluginInstallRecord): string[] {
  return plugin.skills
    .filter((skill) => !skill.materialized && !skill.preexistingStandalone)
    .map((skill) => skill.name);
}

function getPluginInstallEnabledSkillNames(plugin: CanvasPluginInstallRecord): string[] {
  return plugin.skills
    .filter((skill) => skill.materialized || (!skill.materialized && !skill.preexistingStandalone))
    .map((skill) => skill.name);
}

async function parseInstalledPluginRecordSkill(
  plugin: CanvasPluginInstallRecord,
  record: CanvasPluginSkillRecord,
): Promise<CanvasSkill | null> {
  const skillPath = record.path || path.join(record.directory, 'SKILL.md');
  const skill = await parseSkillFile(skillPath);
  if (!skill) return null;

  const resolvedDirectory = path.resolve(/*turbopackIgnore: true*/ skill.directory);
  const resolvedInstallDir = path.resolve(/*turbopackIgnore: true*/ plugin.installDir);
  const bundledAssetPath = isPathInside(resolvedInstallDir, resolvedDirectory)
    ? path.relative(plugin.installDir, skill.directory)
    : undefined;

  skill.plugin = {
    name: plugin.name,
    version: plugin.version,
    displayName: plugin.interface?.displayName,
    skillAssetPath: bundledAssetPath,
  };

  return skill;
}

async function buildPluginRecordFromInstalledPackage(
  manifest: CanvasPluginManifest,
  sourceRoot: string,
  installDir: string,
  enabled: boolean,
  options: CanvasPluginInstallOptions = {},
): Promise<{ record?: CanvasPluginInstallRecord; errors: string[] }> {
  const installedValidation = await validateCanvasPluginPackage(installDir);
  const errors = [...installedValidation.errors];
  if (!installedValidation.valid || !installedValidation.manifest || !installedValidation.rootDir) {
    return { errors };
  }

  const parsedSkills = await parsePluginSkillsFromManifest(
    installedValidation.manifest,
    installedValidation.rootDir,
    installedValidation.skillsDir,
  );
  errors.push(...parsedSkills.errors);
  if (errors.length > 0) {
    return { errors };
  }

  const checksum = await computeCanvasPluginChecksum(installDir);
  const timestamp = nowIso();
  const record: CanvasPluginInstallRecord = {
    name: installedValidation.manifest.name,
    version: installedValidation.manifest.version,
    description: installedValidation.manifest.description,
    license: installedValidation.manifest.license,
    author: installedValidation.manifest.author,
    source: installedValidation.manifest.source,
    sourcePath: options.sourcePathLabel || sourceRoot,
    installedAt: timestamp,
    updatedAt: timestamp,
    enabled,
    checksum,
    sourceRegistryId: options.sourceRegistryId,
    sourceRegistryUrl: options.sourceRegistryUrl,
    installDir,
    manifestPath: installedValidation.manifestPath || path.join(installDir, '.canvas-plugin', 'plugin.json'),
    skillsDir: installedValidation.skillsDir,
    skills: parsedSkills.records,
    interface: installedValidation.manifest.interface,
    connectors: installedValidation.manifest.connectors,
  };

  if (manifest.name !== record.name || manifest.version !== record.version) {
    errors.push('Installed plugin manifest changed during copy.');
    return { errors };
  }

  return { record, errors: [] };
}

async function updateRuntimeConfigForPluginSkills(
  skillNames: string[],
  enabled: boolean,
  scope?: CanvasPluginStorageScope | null,
  updatedBy?: string,
): Promise<void> {
  const enabledSkills = await readEnabledSkillsForScope(scope);
  const allSkillNames = await getAllKnownSkillNames(scope);
  let nextEnabledSkills = enabledSkills || [];

  for (const skillName of skillNames) {
    nextEnabledSkills = enabled
      ? enableSkillInConfig(skillName, nextEnabledSkills, allSkillNames)
      : disableSkillInConfig(skillName, nextEnabledSkills, allSkillNames);
  }

  await writeEnabledSkillsForScope(nextEnabledSkills, { scope, updatedBy });
}

export async function installCanvasPluginFromPath(
  sourcePath: string,
  options: CanvasPluginInstallOptions = {},
): Promise<CanvasPluginInstallResult> {
  const validation = await validateCanvasPluginPackage(sourcePath);
  if (!validation.valid || !validation.manifest || !validation.rootDir) {
    return {
      success: false,
      error: 'Plugin validation failed',
      validation,
    };
  }

  const manifest = validation.manifest;
  const installDir = resolvePluginInstallDir(manifest.name, manifest.version, options.scope);
  const registry = await readCanvasPluginRegistryForWrite(options.scope);
  const existingRecord = registry.plugins[manifest.name];

  if (existingRecord && existingRecord.version === manifest.version && !options.replace) {
    return {
      success: false,
      error: `Plugin "${manifest.name}" version ${manifest.version} is already installed. Use replace to reinstall it.`,
      validation,
      plugin: existingRecord,
    };
  }

  const candidateSkills = await parsePluginSkillsFromManifest(
    manifest,
    validation.rootDir,
    validation.skillsDir,
  );
  if (candidateSkills.errors.length > 0) {
    return {
      success: false,
      error: 'Plugin skills are invalid',
      validation: {
        ...validation,
        valid: false,
        errors: [...validation.errors, ...candidateSkills.errors],
      },
    };
  }

  try {
    await copyPluginPackage(validation.rootDir, installDir);
    const built = await buildPluginRecordFromInstalledPackage(
      manifest,
      validation.rootDir,
      installDir,
      options.enable !== false,
      options,
    );

    if (!built.record) {
      await fs.rm(installDir, { recursive: true, force: true });
      return {
        success: false,
        error: 'Installed plugin package is invalid',
        validation: {
          ...validation,
          valid: false,
          errors: built.errors,
        },
      };
    }

    built.record.skills = await materializePluginSkills(built.record, options.scope);

    if (existingRecord && existingRecord.version !== manifest.version) {
      await fs.rm(existingRecord.installDir, { recursive: true, force: true }).catch(() => undefined);
    }

    registry.plugins[manifest.name] = {
      ...built.record,
      installedAt: existingRecord?.installedAt || built.record.installedAt,
      updatedAt: nowIso(),
    };
    await writeCanvasPluginRegistry(registry, options.scope);

    if (built.record.enabled) {
      await updateRuntimeConfigForPluginSkills(
        getPluginInstallEnabledSkillNames(built.record),
        true,
        options.scope,
        options.installedBy,
      ).catch((error) => {
        console.warn('[CanvasPluginRegistry] Failed to auto-enable plugin skills:', error);
      });
    }

    return {
      success: true,
      validation,
      plugin: registry.plugins[manifest.name],
    };
  } catch (error) {
    await fs.rm(installDir, { recursive: true, force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : 'Failed to install plugin';
    return {
      success: false,
      error: message,
      validation,
    };
  }
}

export async function listCanvasPlugins(
  scope?: CanvasPluginStorageScope | null,
): Promise<CanvasPluginInstallRecord[]> {
  const registry = await readCanvasPluginRegistry(scope);
  return Object.values(registry.plugins)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function getCanvasPlugin(
  name: string,
  scope?: CanvasPluginStorageScope | null,
): Promise<CanvasPluginInstallRecord | null> {
  if (!isValidCanvasPluginName(name)) return null;
  const registry = await readCanvasPluginRegistry(scope);
  return registry.plugins[name] || null;
}

export async function setCanvasPluginEnabled(
  name: string,
  enabled: boolean,
  scope?: CanvasPluginStorageScope | null,
  updatedBy?: string,
): Promise<{ success: boolean; error?: string; plugin?: CanvasPluginInstallRecord }> {
  if (!isValidCanvasPluginName(name)) {
    return { success: false, error: 'Invalid plugin name' };
  }

  const registry = await readCanvasPluginRegistryForWrite(scope);
  const plugin = registry.plugins[name];
  if (!plugin) {
    return { success: false, error: `Plugin "${name}" not found` };
  }

  plugin.enabled = enabled;
  plugin.updatedAt = nowIso();
  await writeCanvasPluginRegistry(registry, scope);

  await updateRuntimeConfigForPluginSkills(getPluginRuntimeSkillNames(plugin), enabled, scope, updatedBy).catch((error) => {
    console.warn('[CanvasPluginRegistry] Failed to update runtime config for plugin skills:', error);
  });

  return { success: true, plugin };
}

export async function deleteCanvasPlugin(
  name: string,
  scope?: CanvasPluginStorageScope | null,
  updatedBy?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isValidCanvasPluginName(name)) {
    return { success: false, error: 'Invalid plugin name' };
  }

  const registry = await readCanvasPluginRegistryForWrite(scope);
  const plugin = registry.plugins[name];
  if (!plugin) {
    return { success: false, error: `Plugin "${name}" not found` };
  }

  delete registry.plugins[name];
  await writeCanvasPluginRegistry(registry, scope);
  await fs.rm(plugin.installDir, { recursive: true, force: true }).catch(() => undefined);
  await updateRuntimeConfigForPluginSkills(getPluginRuntimeSkillNames(plugin), false, scope, updatedBy).catch((error) => {
    console.warn('[CanvasPluginRegistry] Failed to disable removed plugin skills:', error);
  });

  return { success: true };
}

export async function loadEnabledPluginSkills(
  enabledSkills?: string[],
  scope?: CanvasPluginStorageScope | null,
): Promise<CanvasSkill[]> {
  const registry = await readCanvasPluginRegistry(scope);
  const pluginSkills: CanvasSkill[] = [];
  const allSkillNames = await getAllKnownSkillNames(scope, registry);
  const enabledSkillNameSet = resolveEnabledSkillNames(allSkillNames, enabledSkills);

  for (const plugin of Object.values(registry.plugins)) {
    if (!plugin.enabled) {
      continue;
    }

    const parsedSkills = await Promise.all(
      plugin.skills.map((skillRecord) => parseInstalledPluginRecordSkill(plugin, skillRecord)),
    );

    for (const skill of parsedSkills) {
      if (!skill) continue;
      skill.enabled = enabledSkillNameSet.has(skill.name);
      pluginSkills.push(skill);
    }
  }

  return pluginSkills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function getActivePluginSkillNames(scope?: CanvasPluginStorageScope | null): Promise<string[]> {
  const registry = await readCanvasPluginRegistry(scope);
  const names: string[] = [];
  for (const plugin of Object.values(registry.plugins)) {
    if (!plugin.enabled) continue;
    names.push(...plugin.skills.map((skill) => skill.name));
  }
  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
}

export async function getAllKnownSkillNames(
  scope?: CanvasPluginStorageScope | null,
  registry?: CanvasPluginRegistry,
): Promise<string[]> {
  const standaloneNames = await getStandaloneSkillNames(scope);
  const pluginRegistry = registry || await readCanvasPluginRegistry(scope);
  for (const plugin of Object.values(pluginRegistry.plugins)) {
    if (!plugin.enabled) continue;
    for (const skill of plugin.skills) {
      standaloneNames.add(skill.name);
    }
  }
  return Array.from(standaloneNames).sort((left, right) => left.localeCompare(right));
}
