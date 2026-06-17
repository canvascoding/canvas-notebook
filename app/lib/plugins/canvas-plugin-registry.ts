import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import {
  resolveInstalledPluginsDir,
  resolvePluginRegistryPath,
  resolvePluginsDataDir,
  resolveSkillsDataDir,
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
import { readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import {
  isPathInside,
  isValidCanvasPluginName,
  resolvePluginRelativePath,
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
  skillsDir: string;
  skills: CanvasPluginSkillRecord[];
  interface?: CanvasPluginInterface;
  connectors?: CanvasPluginConnectorManifest;
}

export interface CanvasPluginRegistry {
  version: 1;
  updatedAt: string;
  plugins: Record<string, CanvasPluginInstallRecord>;
}

export interface CanvasPluginInstallOptions {
  enable?: boolean;
  replace?: boolean;
  installedBy?: string;
  sourcePathLabel?: string;
  sourceRegistryId?: string;
  sourceRegistryUrl?: string;
}

export interface CanvasPluginInstallResult {
  success: boolean;
  error?: string;
  validation?: CanvasPluginValidationResult;
  plugin?: CanvasPluginInstallRecord;
}

const IGNORED_CHECKSUM_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store']);

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

async function ensurePluginsRoot(): Promise<void> {
  await fs.mkdir(resolvePluginsDataDir(), { recursive: true });
  await fs.mkdir(resolveInstalledPluginsDir(), { recursive: true });
}

export async function readCanvasPluginRegistry(): Promise<CanvasPluginRegistry> {
  await ensurePluginsRoot();
  const registryPath = resolvePluginRegistryPath();
  try {
    const raw = await fs.readFile(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as CanvasPluginRegistry;
    if (!parsed || parsed.version !== 1 || !parsed.plugins || typeof parsed.plugins !== 'object') {
      return createEmptyRegistry();
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createEmptyRegistry();
    }
    console.warn('[CanvasPluginRegistry] Failed to read registry, using empty registry:', error);
    return createEmptyRegistry();
  }
}

export async function writeCanvasPluginRegistry(registry: CanvasPluginRegistry): Promise<void> {
  await ensurePluginsRoot();
  const registryPath = resolvePluginRegistryPath();
  const tmpPath = `${registryPath}.tmp`;
  const nextRegistry: CanvasPluginRegistry = {
    ...registry,
    version: 1,
    updatedAt: nowIso(),
  };
  await fs.writeFile(tmpPath, `${JSON.stringify(nextRegistry, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, registryPath);
}

function resolvePluginInstallDir(name: string, version: string): string {
  return path.join(resolveInstalledPluginsDir(), name, version);
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
  skillsDir: string,
): Promise<{ skills: CanvasSkill[]; records: CanvasPluginSkillRecord[]; errors: string[] }> {
  const skills: CanvasSkill[] = [];
  const records: CanvasPluginSkillRecord[] = [];
  const errors: string[] = [];
  const skillFiles = await discoverPluginSkillFiles(skillsDir);
  const seen = new Set<string>();

  if (skillFiles.length === 0) {
    errors.push('Plugin must contain at least one SKILL.md under its skills directory.');
  }

  for (const skillFile of skillFiles) {
    const skill = await parseSkillFile(skillFile);
    if (!skill) {
      errors.push(`Invalid skill file: ${path.relative(skillsDir, skillFile)}`);
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
    });
  }

  return { skills, records, errors };
}

async function getStandaloneSkillNames(): Promise<Set<string>> {
  const skillsDir = resolveSkillsDataDir();
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

async function findSkillConflicts(
  candidateSkills: CanvasPluginSkillRecord[],
  installingPluginName: string,
  registry: CanvasPluginRegistry,
): Promise<string[]> {
  const conflicts: string[] = [];
  const standaloneNames = await getStandaloneSkillNames();

  for (const skill of candidateSkills) {
    if (standaloneNames.has(skill.name)) {
      conflicts.push(`Skill "${skill.name}" already exists as a standalone skill.`);
    }
  }

  for (const plugin of Object.values(registry.plugins)) {
    if (plugin.name === installingPluginName) {
      continue;
    }

    const pluginSkillNames = new Set(plugin.skills.map((skill) => skill.name));
    for (const skill of candidateSkills) {
      if (pluginSkillNames.has(skill.name)) {
        conflicts.push(`Skill "${skill.name}" is already provided by plugin "${plugin.name}".`);
      }
    }
  }

  return conflicts;
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

async function buildPluginRecordFromInstalledPackage(
  manifest: CanvasPluginManifest,
  sourceRoot: string,
  installDir: string,
  enabled: boolean,
  options: CanvasPluginInstallOptions = {},
): Promise<{ record?: CanvasPluginInstallRecord; errors: string[] }> {
  const installedValidation = await validateCanvasPluginPackage(installDir);
  const errors = [...installedValidation.errors];
  if (!installedValidation.valid || !installedValidation.manifest || !installedValidation.skillsDir) {
    return { errors };
  }

  const pluginDisplayName = installedValidation.manifest.interface?.displayName;
  const parsedSkills = await parsePluginSkills(
    installedValidation.manifest.name,
    installedValidation.manifest.version,
    pluginDisplayName,
    installDir,
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
): Promise<void> {
  const config = await readPiRuntimeConfig();
  const allSkillNames = await getAllKnownSkillNames();
  let nextEnabledSkills = config.enabledSkills;

  for (const skillName of skillNames) {
    nextEnabledSkills = enabled
      ? enableSkillInConfig(skillName, nextEnabledSkills, allSkillNames)
      : disableSkillInConfig(skillName, nextEnabledSkills, allSkillNames);
  }

  config.enabledSkills = nextEnabledSkills;
  config.updatedAt = nowIso();
  await writePiRuntimeConfig(config);
}

export async function installCanvasPluginFromPath(
  sourcePath: string,
  options: CanvasPluginInstallOptions = {},
): Promise<CanvasPluginInstallResult> {
  const validation = await validateCanvasPluginPackage(sourcePath);
  if (!validation.valid || !validation.manifest || !validation.skillsDir || !validation.rootDir) {
    return {
      success: false,
      error: 'Plugin validation failed',
      validation,
    };
  }

  const manifest = validation.manifest;
  const installDir = resolvePluginInstallDir(manifest.name, manifest.version);
  const registry = await readCanvasPluginRegistry();
  const existingRecord = registry.plugins[manifest.name];

  if (existingRecord && existingRecord.version === manifest.version && !options.replace) {
    return {
      success: false,
      error: `Plugin "${manifest.name}" version ${manifest.version} is already installed. Use replace to reinstall it.`,
      validation,
      plugin: existingRecord,
    };
  }

  const candidateSkills = await parsePluginSkills(
    manifest.name,
    manifest.version,
    manifest.interface?.displayName,
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

  const conflicts = await findSkillConflicts(candidateSkills.records, manifest.name, registry);
  if (conflicts.length > 0) {
    return {
      success: false,
      error: 'Plugin skill names conflict with existing skills',
      validation: {
        ...validation,
        valid: false,
        errors: [...validation.errors, ...conflicts],
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

    if (existingRecord && existingRecord.version !== manifest.version) {
      await fs.rm(existingRecord.installDir, { recursive: true, force: true }).catch(() => undefined);
    }

    registry.plugins[manifest.name] = {
      ...built.record,
      installedAt: existingRecord?.installedAt || built.record.installedAt,
      updatedAt: nowIso(),
    };
    await writeCanvasPluginRegistry(registry);

    if (built.record.enabled) {
      await updateRuntimeConfigForPluginSkills(built.record.skills.map((skill) => skill.name), true).catch((error) => {
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

export async function listCanvasPlugins(): Promise<CanvasPluginInstallRecord[]> {
  const registry = await readCanvasPluginRegistry();
  return Object.values(registry.plugins)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function getCanvasPlugin(name: string): Promise<CanvasPluginInstallRecord | null> {
  if (!isValidCanvasPluginName(name)) return null;
  const registry = await readCanvasPluginRegistry();
  return registry.plugins[name] || null;
}

export async function setCanvasPluginEnabled(
  name: string,
  enabled: boolean,
): Promise<{ success: boolean; error?: string; plugin?: CanvasPluginInstallRecord }> {
  if (!isValidCanvasPluginName(name)) {
    return { success: false, error: 'Invalid plugin name' };
  }

  const registry = await readCanvasPluginRegistry();
  const plugin = registry.plugins[name];
  if (!plugin) {
    return { success: false, error: `Plugin "${name}" not found` };
  }

  plugin.enabled = enabled;
  plugin.updatedAt = nowIso();
  await writeCanvasPluginRegistry(registry);

  await updateRuntimeConfigForPluginSkills(plugin.skills.map((skill) => skill.name), enabled).catch((error) => {
    console.warn('[CanvasPluginRegistry] Failed to update runtime config for plugin skills:', error);
  });

  return { success: true, plugin };
}

export async function deleteCanvasPlugin(
  name: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isValidCanvasPluginName(name)) {
    return { success: false, error: 'Invalid plugin name' };
  }

  const registry = await readCanvasPluginRegistry();
  const plugin = registry.plugins[name];
  if (!plugin) {
    return { success: false, error: `Plugin "${name}" not found` };
  }

  delete registry.plugins[name];
  await writeCanvasPluginRegistry(registry);
  await fs.rm(plugin.installDir, { recursive: true, force: true }).catch(() => undefined);
  await updateRuntimeConfigForPluginSkills(plugin.skills.map((skill) => skill.name), false).catch((error) => {
    console.warn('[CanvasPluginRegistry] Failed to disable removed plugin skills:', error);
  });

  return { success: true };
}

export async function loadEnabledPluginSkills(enabledSkills?: string[]): Promise<CanvasSkill[]> {
  const registry = await readCanvasPluginRegistry();
  const pluginSkills: CanvasSkill[] = [];
  const allSkillNames = await getAllKnownSkillNames(registry);
  const enabledSkillNameSet = resolveEnabledSkillNames(allSkillNames, enabledSkills);

  for (const plugin of Object.values(registry.plugins)) {
    if (!plugin.enabled) {
      continue;
    }

    const skillsDir = plugin.skillsDir || resolvePluginRelativePath(plugin.installDir, 'skills');
    const parsedSkills = await parsePluginSkills(
      plugin.name,
      plugin.version,
      plugin.interface?.displayName,
      plugin.installDir,
      skillsDir,
    );

    for (const skill of parsedSkills.skills) {
      skill.enabled = enabledSkillNameSet.has(skill.name);
      pluginSkills.push(skill);
    }
  }

  return pluginSkills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function getActivePluginSkillNames(): Promise<string[]> {
  const registry = await readCanvasPluginRegistry();
  const names: string[] = [];
  for (const plugin of Object.values(registry.plugins)) {
    if (!plugin.enabled) continue;
    names.push(...plugin.skills.map((skill) => skill.name));
  }
  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
}

export async function getAllKnownSkillNames(registry?: CanvasPluginRegistry): Promise<string[]> {
  const standaloneNames = await getStandaloneSkillNames();
  const pluginRegistry = registry || await readCanvasPluginRegistry();
  for (const plugin of Object.values(pluginRegistry.plugins)) {
    if (!plugin.enabled) continue;
    for (const skill of plugin.skills) {
      standaloneNames.add(skill.name);
    }
  }
  return Array.from(standaloneNames).sort((left, right) => left.localeCompare(right));
}
