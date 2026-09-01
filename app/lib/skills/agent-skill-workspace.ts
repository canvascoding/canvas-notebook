import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { computeCanvasPluginChecksum } from '@/app/lib/plugins/canvas-plugin-registry';
import { isValidCanvasPluginVersion } from '@/app/lib/plugins/canvas-plugin-manifest';
import { createAtomicTempPath, resolveScopedSkillsDataDir } from '@/app/lib/runtime-data-paths';
import { requirePathInside } from '@/app/lib/security/safe-paths';
import {
  CANVAS_SKILL_INTERFACE_PATH,
  getSkillsDir,
  isValidAgentSkillName,
  loadCanvasSkillInterface,
  parseSkillFile,
  type CanvasSkill,
  type CanvasSkillStorageScope,
} from '@/app/lib/skills/canvas-skill-manifest';
import {
  readCanvasSkillRegistry,
  writeCanvasSkillRegistry,
  type CanvasSkillInstallRecord,
} from '@/app/lib/skills/canvas-skill-store';
import { isCoreSkillName } from '@/app/lib/skills/core-skills';
import { loadCoreSkillByName } from '@/app/lib/skills/core-skill-loader';
import { enableSkillInConfig } from '@/app/lib/skills/enabled-skills';
import { adoptLegacyStandaloneSkillsForScope } from '@/app/lib/skills/legacy-skill-adoption';
import { getSkillNames, loadSkillByName } from '@/app/lib/skills/skill-loader';
import { importSkillPackage } from '@/app/lib/skills/skill-package-import';
import { readEnabledSkillsForScope, writeEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';

const SKILL_DRAFTS_DIR_NAME = '.canvas-skill-drafts';
const IGNORED_PACKAGE_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store']);
const MAX_SKILL_PACKAGE_FILES = 2_000;
const MAX_SKILL_PACKAGE_BYTES = 250 * 1024 * 1024;

export type AgentSkillScope = {
  userId: string;
  organizationId?: string | null;
};

export type AgentSkillSourceScope = 'personal' | 'organization' | 'core';

export type AgentSkillFileSummary = {
  path: string;
  bytes: number;
  sha256?: string;
};

export type AgentSkillInspection = {
  name: string;
  scope: AgentSkillSourceScope;
  editable: boolean;
  forkable: boolean;
  reason?: string;
  version?: string;
  checksum?: string;
  sourceType: 'core' | CanvasSkillInstallRecord['sourceType'] | 'standalone' | 'missing';
  installDir?: string;
  skillPath?: string;
  files?: AgentSkillFileSummary[];
  record?: CanvasSkillInstallRecord;
};

export type AgentSkillDraftResult = {
  draftId: string;
  draftPath: string;
  packagePath: string;
  sourceSkillName?: string;
  sourceScope?: AgentSkillSourceScope;
  forked?: boolean;
  skillName: string;
  expectedVersion?: string;
  expectedChecksum?: string;
  files: AgentSkillFileSummary[];
};

export type AgentSkillInstallFromWorkspaceResult = {
  success: true;
  name: string;
  path: string;
  version: string;
  checksum: string;
  importedFiles: number;
  draftPath: string;
  draftCleaned: boolean;
  cleanupSkippedReason?: string;
};

export type AgentSkillUpdateFromWorkspaceResult = {
  success: true;
  name: string;
  path: string;
  previousVersion: string;
  version: string;
  previousChecksum: string;
  checksum: string;
  files: number;
  draftPath: string;
  draftCleaned: boolean;
  cleanupSkippedReason?: string;
};

export type AgentSkillDiscardDraftResult = {
  success: true;
  draftPath: string;
  deleted: boolean;
};

type WorkspacePackage = {
  packageRoot: string;
  displayPath: string;
  files: Array<{ relativePath: string; bytes: Buffer }>;
};

type ExistingSkillPackage = {
  skill: CanvasSkill;
  sourceScope: AgentSkillSourceScope;
  editable: boolean;
  installDir: string;
  skillPath: string;
  record?: CanvasSkillInstallRecord;
  version: string;
  checksum: string;
};

type AtomicSkillPackageReplacement = {
  installDir: string;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function assertValidSkillName(skillName: string): void {
  if (!isValidAgentSkillName(skillName)) {
    throw new Error('Invalid skill name. Use 1-64 lowercase Unicode letters or numbers separated by single hyphens.');
  }
}

function assertValidSkillVersion(version: string): void {
  if (!isValidCanvasPluginVersion(version)) {
    throw new Error('Invalid skill version. Use a simple version such as 1.0.0.');
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function workspaceRelativePath(workspaceRoot: string, targetPath: string): string {
  return toPosixPath(path.relative(workspaceRoot, targetPath));
}

function resolveWorkspacePath(workspaceRoot: string, workspacePath: string): string {
  const normalizedRoot = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(workspacePath)
    ? path.resolve(workspacePath)
    : path.resolve(normalizedRoot, workspacePath);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Skill draft path must stay inside the active workspace.');
  }
  return resolved;
}

function isIgnoredPackagePath(relativePath: string): boolean {
  return relativePath
    .split('/')
    .filter(Boolean)
    .some((segment) => IGNORED_PACKAGE_ENTRIES.has(segment));
}

async function findSkillMarkdownFiles(root: string, currentDir = root): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const skillFiles: string[] = [];

  for (const entry of entries) {
    if (IGNORED_PACKAGE_ENTRIES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      skillFiles.push(...await findSkillMarkdownFiles(root, fullPath));
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      skillFiles.push(toPosixPath(path.relative(root, fullPath)));
    }
  }

  return skillFiles.sort((left, right) => left.localeCompare(right));
}

async function assertPackageContainsNoSymlinks(packageRoot: string, currentDir = packageRoot): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_PACKAGE_ENTRIES.has(entry.name)) continue;

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      const relativePath = toPosixPath(path.relative(packageRoot, fullPath));
      throw new Error(`Skill package must not contain symbolic links: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await assertPackageContainsNoSymlinks(packageRoot, fullPath);
    }
  }
}

async function resolveWorkspaceSkillPackageRoot(workspaceRoot: string, workspacePath: string): Promise<{
  packageRoot: string;
  displayPath: string;
}> {
  const candidate = resolveWorkspacePath(workspaceRoot, workspacePath);
  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error('Skill workspace path must be an existing directory.');
  }

  const [realWorkspaceRoot, realCandidate] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(candidate),
  ]);
  if (realCandidate !== realWorkspaceRoot && !realCandidate.startsWith(`${realWorkspaceRoot}${path.sep}`)) {
    throw new Error('Skill draft path must stay inside the active workspace.');
  }
  await assertPackageContainsNoSymlinks(candidate);

  const skillFiles = await findSkillMarkdownFiles(candidate);
  if (skillFiles.length === 0) {
    throw new Error('Skill package must contain a SKILL.md file.');
  }
  if (skillFiles.length > 1) {
    throw new Error(`Skill package contains multiple SKILL.md files. Provide one skill folder: ${skillFiles.slice(0, 5).join(', ')}`);
  }

  const packageRoot = requirePathInside(candidate, path.dirname(skillFiles[0]));
  return {
    packageRoot,
    displayPath: workspaceRelativePath(workspaceRoot, packageRoot),
  };
}

async function readWorkspacePackageFiles(packageRoot: string): Promise<Array<{ relativePath: string; bytes: Buffer }>> {
  const files: Array<{ relativePath: string; bytes: Buffer }> = [];
  let totalBytes = 0;

  async function visit(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = toPosixPath(path.relative(packageRoot, fullPath));
      if (!relativePath || isIgnoredPackagePath(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill package must not contain symbolic links: ${relativePath}`);
      }
      if (!entry.isFile()) {
        continue;
      }

      const bytes = await fs.readFile(fullPath);
      files.push({ relativePath, bytes });
      totalBytes += bytes.byteLength;
      if (files.length > MAX_SKILL_PACKAGE_FILES) {
        throw new Error(`Skill package contains too many files. Maximum is ${MAX_SKILL_PACKAGE_FILES}.`);
      }
      if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
        throw new Error('Skill package is too large. Maximum is 250 MB.');
      }
    }
  }

  await visit(packageRoot);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function listSkillFiles(packageRoot: string, includeSha = false): Promise<AgentSkillFileSummary[]> {
  const files = await readWorkspacePackageFiles(packageRoot);
  return Promise.all(files.map(async (file) => ({
    path: file.relativePath,
    bytes: file.bytes.byteLength,
    sha256: includeSha ? createHash('sha256').update(file.bytes).digest('hex') : undefined,
  })));
}

async function validateWorkspaceSkillPackage(
  packageRoot: string,
  expectedName?: string,
  options: { validateDirectoryName?: boolean } = {},
): Promise<CanvasSkill> {
  const skillPath = requirePathInside(packageRoot, 'SKILL.md');
  const skill = await parseSkillFile(skillPath, {
    validateDirectoryName: options.validateDirectoryName ?? true,
  });
  if (!skill) {
    throw new Error('Skill package contains an invalid SKILL.md.');
  }
  if (expectedName && skill.name !== expectedName) {
    throw new Error(`Skill package name mismatch: expected "${expectedName}", got "${skill.name}".`);
  }
  if (!skill.version) {
    throw new Error('Skill package must declare a version in agents/canvas.yaml skill.version or SKILL.md metadata.version.');
  }
  assertValidSkillVersion(skill.version);
  return skill;
}

async function rewriteSkillPackageName(packageRoot: string, targetSkillName: string): Promise<void> {
  const skillPath = requirePathInside(packageRoot, 'SKILL.md');
  const content = await fs.readFile(skillPath, 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('Skill package must contain valid YAML frontmatter before it can be forked.');
  }

  const frontmatter = YAML.parse(match[1]) as unknown;
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('Skill package must contain object YAML frontmatter before it can be forked.');
  }
  (frontmatter as Record<string, unknown>).name = targetSkillName;
  const serializedFrontmatter = YAML.stringify(frontmatter).trimEnd();
  await fs.writeFile(
    skillPath,
    `---\n${serializedFrontmatter}\n---\n\n${match[2].replace(/^\s+/, '')}`,
    'utf-8',
  );
  await validateWorkspaceSkillPackage(packageRoot, targetSkillName);
}

async function enableInstalledSkill(
  skillName: string,
  scope: CanvasSkillStorageScope,
  updatedBy?: string,
): Promise<void> {
  const enabledSkills = await readEnabledSkillsForScope(scope);
  const allSkillNames = await getSkillNames(scope);
  const nextEnabledSkills = enableSkillInConfig(skillName, enabledSkills, allSkillNames);
  await writeEnabledSkillsForScope(nextEnabledSkills, { scope, updatedBy });
}

async function writeLocalSkillRecord(params: {
  skillName: string;
  version: string;
  description: string;
  license?: string;
  installDir: string;
  sourcePath: string;
  scope: CanvasSkillStorageScope;
}): Promise<CanvasSkillInstallRecord> {
  const skillPath = requirePathInside(params.installDir, 'SKILL.md');
  const registry = await readCanvasSkillRegistry(params.scope);
  const existing = registry.skills[params.skillName];
  const record: CanvasSkillInstallRecord = {
    name: params.skillName,
    version: params.version,
    description: params.description,
    license: params.license,
    sourceType: 'local',
    sourcePath: params.sourcePath,
    installedAt: existing?.installedAt || nowIso(),
    updatedAt: nowIso(),
    checksum: await computeCanvasPluginChecksum(params.installDir),
    installDir: params.installDir,
    skillPath,
    interface: await loadCanvasSkillInterface(params.installDir),
  };
  registry.skills[params.skillName] = record;
  await writeCanvasSkillRegistry(registry, params.scope);
  return record;
}

async function getExistingSkillPackage(
  skillName: string,
  scope: AgentSkillScope,
  requestedSourceScope: AgentSkillSourceScope,
): Promise<ExistingSkillPackage> {
  assertValidSkillName(skillName);
  const sourceScope = isCoreSkillName(skillName) ? 'core' : requestedSourceScope;

  if (sourceScope === 'core') {
    const skill = await loadCoreSkillByName(skillName);
    if (!skill) {
      throw new Error(`Core skill "${skillName}" is not available in the application bundle.`);
    }
    return {
      skill,
      sourceScope,
      editable: false,
      installDir: skill.directory,
      skillPath: skill.path,
      version: skill.version || 'bundled',
      checksum: await computeCanvasPluginChecksum(skill.directory),
    };
  }

  const storageScope: CanvasSkillStorageScope = sourceScope === 'organization'
    ? {
        scopeType: 'organization',
        organizationId: scope.organizationId || undefined,
      }
    : {
        scopeType: 'user',
        userId: scope.userId,
        organizationId: scope.organizationId || undefined,
      };
  if (sourceScope === 'organization' && !scope.organizationId) {
    throw new Error('An organization-bound agent session is required to inspect or fork an organization skill.');
  }

  const registry = await readCanvasSkillRegistry(storageScope);
  const record = registry.skills[skillName];
  const skill = record
    ? await parseSkillFile(record.skillPath)
    : await loadSkillByName(skillName, storageScope, { legacyFallback: false });
  if (!skill) {
    throw new Error(`Skill "${skillName}" is not installed in the ${sourceScope} scope.`);
  }

  const installDir = record?.installDir || path.dirname(skill.path);
  const skillPath = requirePathInside(installDir, 'SKILL.md');
  const currentChecksum = await computeCanvasPluginChecksum(installDir);
  const version = skill.version || record?.version || 'local';
  return {
    skill,
    sourceScope,
    editable: sourceScope === 'personal' && !skill.plugin && record?.sourceType !== 'plugin',
    installDir,
    skillPath,
    record,
    version,
    checksum: currentChecksum,
  };
}

function draftRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, SKILL_DRAFTS_DIR_NAME);
}

function normalizeDraftId(draftId?: string): string {
  const candidate = draftId?.trim() || randomUUID();
  if (!/^[a-zA-Z0-9._-]+$/.test(candidate) || candidate === '.' || candidate === '..') {
    throw new Error('Invalid draftId.');
  }
  return candidate;
}

function managedDraftCleanupPath(workspaceRoot: string, packageRoot: string): { cleanupPath?: string; reason?: string } {
  const root = draftRoot(path.resolve(workspaceRoot));
  const resolvedPackageRoot = path.resolve(packageRoot);
  const relative = path.relative(root, resolvedPackageRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { reason: 'Draft path is not under .canvas-skill-drafts.' };
  }

  const [draftId] = relative.split(path.sep);
  if (!draftId) {
    return { reason: 'Draft id could not be resolved.' };
  }
  return { cleanupPath: requirePathInside(root, draftId) };
}

async function cleanupDraftIfManaged(workspaceRoot: string, packageRoot: string, cleanupDraft = true): Promise<{
  cleaned: boolean;
  reason?: string;
}> {
  if (!cleanupDraft) {
    return { cleaned: false, reason: 'cleanupDraft=false' };
  }
  const cleanup = managedDraftCleanupPath(workspaceRoot, packageRoot);
  if (!cleanup.cleanupPath) {
    return { cleaned: false, reason: cleanup.reason };
  }
  await fs.rm(cleanup.cleanupPath, { recursive: true, force: true });
  return { cleaned: true };
}

async function replaceSkillPackageAtomically(
  packageRoot: string,
  skillName: string,
  scope: CanvasSkillStorageScope,
): Promise<AtomicSkillPackageReplacement> {
  const skillsDir = resolveScopedSkillsDataDir(scope);
  const targetDir = requirePathInside(skillsDir, skillName);
  const tempDir = createAtomicTempPath(targetDir);
  const backupDir = createAtomicTempPath(`${targetDir}.backup`);
  let movedExistingPackage = false;
  let installedReplacement = false;

  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(tempDir), { recursive: true });
    await fs.cp(requirePathInside(packageRoot, '.'), tempDir, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => {
        const relativePath = toPosixPath(path.relative(packageRoot, source));
        return !relativePath || !isIgnoredPackagePath(relativePath);
      },
    });

    await validateWorkspaceSkillPackage(tempDir, skillName, { validateDirectoryName: false });
    const targetExists = await fs.stat(targetDir).then(() => true).catch(() => false);
    if (targetExists) {
      await fs.rename(targetDir, backupDir);
      movedExistingPackage = true;
    }
    await fs.rename(tempDir, targetDir);
    installedReplacement = true;
    return {
      installDir: targetDir,
      commit: async () => {
        if (movedExistingPackage) {
          await fs.rm(backupDir, { recursive: true, force: true });
          movedExistingPackage = false;
        }
      },
      rollback: async () => {
        if (installedReplacement) {
          await fs.rm(targetDir, { recursive: true, force: true });
          installedReplacement = false;
        }
        if (movedExistingPackage) {
          await fs.rename(backupDir, targetDir);
          movedExistingPackage = false;
        }
      },
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (installedReplacement) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (movedExistingPackage) {
      await fs.rename(backupDir, targetDir).catch(() => undefined);
    }
    throw error;
  }
}

export async function inspectCanvasSkillForAgent(params: {
  skillName: string;
  scope: AgentSkillScope;
  sourceScope?: AgentSkillSourceScope;
}): Promise<AgentSkillInspection> {
  const scope = {
    userId: params.scope.userId,
    organizationId: params.scope.organizationId,
  };
  const skillName = params.skillName.trim();
  assertValidSkillName(skillName);
  const sourceScope = isCoreSkillName(skillName) ? 'core' : (params.sourceScope || 'personal');
  if (sourceScope === 'personal') {
    await adoptLegacyStandaloneSkillsForScope({ userId: scope.userId });
  }

  let existing: ExistingSkillPackage;
  try {
    existing = await getExistingSkillPackage(skillName, scope, sourceScope);
  } catch (error) {
    if (error instanceof Error && error.message.includes('is not installed')) {
      return {
        name: skillName,
        scope: sourceScope,
        editable: false,
        forkable: false,
        reason: error.message,
        sourceType: 'missing',
      };
    }
    throw error;
  }

  if (existing.sourceScope === 'core') {
    return {
      name: skillName,
      scope: 'core',
      editable: false,
      forkable: true,
      reason: 'Core skills are bundled and cannot be edited directly. Create a personal fork with a different name instead.',
      sourceType: 'core',
      version: existing.version,
      checksum: existing.checksum,
      installDir: existing.installDir,
      skillPath: existing.skillPath,
      files: await listSkillFiles(existing.installDir),
    };
  }

  return {
    name: skillName,
    scope: existing.sourceScope,
    editable: existing.editable,
    forkable: true,
    reason: existing.editable
      ? undefined
      : existing.sourceScope === 'organization'
        ? 'Organization skills are read-only. Create a personal fork with a different name instead.'
        : `Skill is managed by plugin "${existing.skill.plugin?.name || existing.record?.sourcePluginName || 'unknown'}". Create a personal fork with a different name instead.`,
    version: existing.version,
    checksum: existing.checksum,
    sourceType: existing.record?.sourceType || (existing.skill.plugin ? 'plugin' : 'standalone'),
    installDir: existing.installDir,
    skillPath: existing.skillPath,
    files: await listSkillFiles(existing.installDir),
    record: existing.record,
  };
}

export async function createCanvasSkillDraft(params: {
  workspaceRoot: string;
  scope: AgentSkillScope;
  skillName: string;
  description?: string;
  version?: string;
  sourceSkillName?: string;
  sourceScope?: AgentSkillSourceScope;
  draftId?: string;
  overwrite?: boolean;
}): Promise<AgentSkillDraftResult> {
  const scope = {
    userId: params.scope.userId,
    organizationId: params.scope.organizationId,
  };
  const skillName = params.skillName.trim();
  assertValidSkillName(skillName);
  await adoptLegacyStandaloneSkillsForScope({ userId: scope.userId });

  const id = normalizeDraftId(params.draftId);
  const root = draftRoot(path.resolve(params.workspaceRoot));
  const packageRoot = requirePathInside(root, id, skillName);
  const existing = await fs.stat(packageRoot).catch(() => null);
  if (existing && params.overwrite !== true) {
    throw new Error(`Draft already exists: ${workspaceRelativePath(params.workspaceRoot, packageRoot)}`);
  }

  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });

  if (params.sourceSkillName) {
    const sourceSkillName = params.sourceSkillName.trim();
    const sourceScope = isCoreSkillName(sourceSkillName) ? 'core' : (params.sourceScope || 'personal');
    const source = await getExistingSkillPackage(sourceSkillName, scope, sourceScope);
    const isFork = source.skill.name !== skillName || !source.editable;
    if (!source.editable && source.skill.name === skillName) {
      throw new Error(`${source.sourceScope === 'organization' ? 'Organization' : 'Managed'} skills are read-only. Use a different personal skill name for the fork.`);
    }
    await assertPackageContainsNoSymlinks(source.installDir);
    await fs.cp(source.installDir, packageRoot, {
      recursive: true,
      preserveTimestamps: true,
      filter: (sourcePath) => !isIgnoredPackagePath(toPosixPath(path.relative(source.installDir, sourcePath))),
    });
    if (source.skill.name !== skillName) {
      await rewriteSkillPackageName(packageRoot, skillName);
    }
    return {
      draftId: id,
      draftPath: workspaceRelativePath(params.workspaceRoot, path.dirname(packageRoot)),
      packagePath: workspaceRelativePath(params.workspaceRoot, packageRoot),
      sourceSkillName,
      sourceScope: source.sourceScope,
      forked: isFork,
      skillName,
      expectedVersion: source.version,
      expectedChecksum: source.checksum,
      files: await listSkillFiles(packageRoot),
    };
  }

  const version = params.version?.trim() || '1.0.0';
  assertValidSkillVersion(version);
  const description = params.description?.trim() || `Personal Canvas skill ${skillName}.`;
  await fs.mkdir(path.join(packageRoot, 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      `description: ${JSON.stringify(description)}`,
      '---',
      '',
      `# ${skillName}`,
      '',
      description,
      '',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(packageRoot, CANVAS_SKILL_INTERFACE_PATH),
    [
      'skill:',
      `  version: ${JSON.stringify(version)}`,
      'interface:',
      `  display_name: ${JSON.stringify(skillName)}`,
      `  short_description: ${JSON.stringify(description)}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  return {
    draftId: id,
    draftPath: workspaceRelativePath(params.workspaceRoot, path.dirname(packageRoot)),
    packagePath: workspaceRelativePath(params.workspaceRoot, packageRoot),
    skillName,
    files: await listSkillFiles(packageRoot),
  };
}

export async function installCanvasSkillFromWorkspace(params: {
  workspaceRoot: string;
  scope: AgentSkillScope;
  draftPath: string;
  enable?: boolean;
  cleanupDraft?: boolean;
  updatedBy?: string;
}): Promise<AgentSkillInstallFromWorkspaceResult> {
  const scope = { userId: params.scope.userId };
  const workspacePackage = await resolveWorkspacePackage(params.workspaceRoot, params.draftPath);
  const skill = await validateWorkspaceSkillPackage(workspacePackage.packageRoot);

  const importResult = await importSkillPackage({
    kind: 'folder',
    sourceName: workspacePackage.displayPath,
    files: workspacePackage.files,
  }, {
    scope,
    updatedBy: params.updatedBy,
    enable: params.enable !== false,
  });

  const registry = await readCanvasSkillRegistry(scope);
  const record = registry.skills[importResult.name];
  const cleanup = await cleanupDraftIfManaged(params.workspaceRoot, workspacePackage.packageRoot, params.cleanupDraft !== false);

  return {
    success: true,
    name: importResult.name,
    path: importResult.path,
    version: record?.version || skill.version || 'local',
    checksum: record?.checksum || await computeCanvasPluginChecksum(path.dirname(importResult.path)),
    importedFiles: importResult.importedFiles,
    draftPath: workspacePackage.displayPath,
    draftCleaned: cleanup.cleaned,
    cleanupSkippedReason: cleanup.reason,
  };
}

async function resolveWorkspacePackage(workspaceRoot: string, draftPath: string): Promise<WorkspacePackage> {
  const resolved = await resolveWorkspaceSkillPackageRoot(workspaceRoot, draftPath);
  const files = await readWorkspacePackageFiles(resolved.packageRoot);
  return {
    packageRoot: resolved.packageRoot,
    displayPath: resolved.displayPath,
    files,
  };
}

export async function updateCanvasSkillFromWorkspace(params: {
  workspaceRoot: string;
  scope: AgentSkillScope;
  skillName: string;
  draftPath: string;
  expectedVersion: string;
  expectedChecksum: string;
  enable?: boolean;
  cleanupDraft?: boolean;
  updatedBy?: string;
}): Promise<AgentSkillUpdateFromWorkspaceResult> {
  const scope = { userId: params.scope.userId };
  const skillName = params.skillName.trim();
  assertValidSkillName(skillName);
  await adoptLegacyStandaloneSkillsForScope(scope);
  const expectedVersion = params.expectedVersion.trim();
  const expectedChecksum = params.expectedChecksum.trim().replace(/^sha256:/i, '').toLowerCase();
  if (!expectedVersion) {
    throw new Error('expectedVersion is required.');
  }
  if (!/^[a-f0-9]{64}$/i.test(expectedChecksum)) {
    throw new Error('expectedChecksum must be a SHA-256 hex digest.');
  }

  const existing = await getExistingSkillPackage(skillName, params.scope, 'personal');
  if (!existing.editable) {
    throw new Error(`Skill "${skillName}" is managed and cannot be updated directly. Create a personal fork with a different name instead.`);
  }
  if (existing.version !== expectedVersion) {
    throw new Error(`Skill version changed since inspection. Expected ${expectedVersion}, found ${existing.version}.`);
  }
  if (existing.checksum !== expectedChecksum) {
    throw new Error('Skill checksum changed since inspection. Inspect the skill again before updating.');
  }

  const workspacePackage = await resolveWorkspacePackage(params.workspaceRoot, params.draftPath);
  const nextSkill = await validateWorkspaceSkillPackage(workspacePackage.packageRoot, skillName);
  const previousRegistry = await readCanvasSkillRegistry(scope);
  const replacement = await replaceSkillPackageAtomically(workspacePackage.packageRoot, skillName, scope);
  let record: CanvasSkillInstallRecord;
  try {
    record = await writeLocalSkillRecord({
      skillName,
      version: nextSkill.version || 'local',
      description: nextSkill.description,
      license: nextSkill.license,
      installDir: replacement.installDir,
      sourcePath: `workspace:${workspacePackage.displayPath}`,
      scope,
    });
    await replacement.commit();
  } catch (error) {
    await replacement.rollback().catch(() => undefined);
    await writeCanvasSkillRegistry(previousRegistry, scope).catch(() => undefined);
    throw error;
  }

  if (params.enable !== false) {
    await enableInstalledSkill(skillName, scope, params.updatedBy).catch((error) => {
      console.warn('[AgentSkillWorkspace] Failed to auto-enable updated skill:', error);
    });
  }

  const cleanup = await cleanupDraftIfManaged(params.workspaceRoot, workspacePackage.packageRoot, params.cleanupDraft !== false);
  return {
    success: true,
    name: skillName,
    path: requirePathInside(replacement.installDir, 'SKILL.md'),
    previousVersion: existing.version,
    version: record.version,
    previousChecksum: existing.checksum,
    checksum: record.checksum,
    files: workspacePackage.files.length,
    draftPath: workspacePackage.displayPath,
    draftCleaned: cleanup.cleaned,
    cleanupSkippedReason: cleanup.reason,
  };
}

export async function discardCanvasSkillDraft(params: {
  workspaceRoot: string;
  draftPath: string;
}): Promise<AgentSkillDiscardDraftResult> {
  const candidate = resolveWorkspacePath(params.workspaceRoot, params.draftPath);
  const cleanup = managedDraftCleanupPath(params.workspaceRoot, candidate);
  if (!cleanup.cleanupPath) {
    throw new Error(cleanup.reason || 'Only drafts under .canvas-skill-drafts can be discarded.');
  }
  const existed = await fs.stat(cleanup.cleanupPath).then((stat) => stat.isDirectory()).catch(() => false);
  await fs.rm(cleanup.cleanupPath, { recursive: true, force: true });
  return {
    success: true,
    draftPath: workspaceRelativePath(params.workspaceRoot, cleanup.cleanupPath),
    deleted: existed,
  };
}

export function getAgentSkillDraftsDirectory(workspaceRoot: string): string {
  return draftRoot(path.resolve(workspaceRoot));
}

export function getAgentSkillInstallDirectory(scope: AgentSkillScope, skillName: string): string {
  return requirePathInside(getSkillsDir({ userId: scope.userId }), skillName);
}
