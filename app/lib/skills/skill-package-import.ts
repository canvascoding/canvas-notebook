import 'server-only';

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import JSZip from 'jszip';

import { computeCanvasPluginChecksum } from '@/app/lib/plugins/canvas-plugin-registry';
import { requirePathInside } from '@/app/lib/security/safe-paths';
import { adoptLegacyStandaloneSkillsForScope } from '@/app/lib/skills/legacy-skill-adoption';
import {
  getSkillsDir,
  loadCanvasSkillInterface,
  parseFrontmatter,
  parseSkillFile,
  validateFrontmatter,
  type CanvasSkillStorageScope,
  type ValidationResult,
} from '@/app/lib/skills/canvas-skill-manifest';
import {
  readCanvasSkillRegistry,
  writeCanvasSkillRegistry,
  type CanvasSkillInstallRecord,
} from '@/app/lib/skills/canvas-skill-store';
import { enableSkillInConfig } from '@/app/lib/skills/enabled-skills';
import { getSkillNames, loadSkillByName } from '@/app/lib/skills/skill-loader';
import { readEnabledSkillsForScope, writeEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';

const MAX_SKILL_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_EXTRACTED_BYTES = 250 * 1024 * 1024;
const MAX_SKILL_PACKAGE_FILES = 2_000;
const IGNORED_PACKAGE_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store']);

export type SkillPackageImportSource =
  | {
      kind: 'text';
      content: string;
      sourceName?: string;
    }
  | {
      kind: 'archive';
      bytes: Buffer;
      sourceName: string;
    }
  | {
      kind: 'folder';
      sourceName?: string;
      files: Array<{
        relativePath: string;
        bytes: Buffer;
      }>;
    };

export interface SkillPackageImportResult {
  success: true;
  name: string;
  path: string;
  validation: ValidationResult;
  importedFiles: number;
  sourceKind: SkillPackageImportSource['kind'];
}

export class SkillPackageImportError extends Error {
  statusCode: number;
  validation?: ValidationResult;

  constructor(message: string, statusCode = 400, validation?: ValidationResult) {
    super(message);
    this.name = 'SkillPackageImportError';
    this.statusCode = statusCode;
    this.validation = validation;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isIgnoredPackagePath(relativePath: string): boolean {
  return relativePath
    .split('/')
    .filter(Boolean)
    .some((segment) => IGNORED_PACKAGE_ENTRIES.has(segment));
}

function sanitizePackageRelativePath(rawPath: string): string {
  const cleaned = rawPath
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();

  if (!cleaned) {
    throw new SkillPackageImportError('Skill package contains an empty file path.');
  }

  const parts = cleaned.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new SkillPackageImportError(`Skill package contains an unsafe path: ${rawPath}`);
  }

  return parts.join('/');
}

async function writePackageFile(params: {
  root: string;
  relativePath: string;
  bytes: Buffer;
  state: { fileCount: number; totalBytes: number };
}): Promise<void> {
  const relativePath = sanitizePackageRelativePath(params.relativePath);
  if (isIgnoredPackagePath(relativePath)) {
    return;
  }

  params.state.fileCount += 1;
  params.state.totalBytes += params.bytes.byteLength;
  if (params.state.fileCount > MAX_SKILL_PACKAGE_FILES) {
    throw new SkillPackageImportError(`Skill package contains too many files. Maximum is ${MAX_SKILL_PACKAGE_FILES}.`, 413);
  }
  if (params.state.totalBytes > MAX_SKILL_EXTRACTED_BYTES) {
    throw new SkillPackageImportError('Skill package is too large after extraction. Maximum is 250 MB.', 413);
  }

  const targetPath = requirePathInside(params.root, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, params.bytes);
}

async function createTempPackageRoot(source: SkillPackageImportSource): Promise<{
  tempRoot: string;
  extractRoot: string;
  importedFiles: number;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skill-upload-'));
  const extractRoot = path.join(tempRoot, 'package');
  await fs.mkdir(extractRoot, { recursive: true });

  try {
    if (source.kind === 'text') {
      if (!source.content.trim()) {
        throw new SkillPackageImportError('SKILL.md content is required.');
      }
      await writePackageFile({
        root: extractRoot,
        relativePath: 'SKILL.md',
        bytes: Buffer.from(source.content, 'utf-8'),
        state: { fileCount: 0, totalBytes: 0 },
      });
      return { tempRoot, extractRoot, importedFiles: 1 };
    }

    const state = { fileCount: 0, totalBytes: 0 };

    if (source.kind === 'archive') {
      if (source.bytes.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
        throw new SkillPackageImportError('Skill archive is too large. Maximum is 100 MB.', 413);
      }

      const zip = await JSZip.loadAsync(source.bytes);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const bytes = await entry.async('nodebuffer');
        await writePackageFile({
          root: extractRoot,
          relativePath: entry.name,
          bytes,
          state,
        });
      }
      return { tempRoot, extractRoot, importedFiles: state.fileCount };
    }

    if (source.files.length === 0) {
      throw new SkillPackageImportError('Skill folder is empty.');
    }

    for (const file of source.files) {
      await writePackageFile({
        root: extractRoot,
        relativePath: file.relativePath,
        bytes: file.bytes,
        state,
      });
    }

    return { tempRoot, extractRoot, importedFiles: state.fileCount };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
      skillFiles.push(path.relative(root, fullPath).split(path.sep).join('/'));
    }
  }

  return skillFiles.sort((left, right) => left.localeCompare(right));
}

async function resolveSkillPackageRoot(extractRoot: string): Promise<string> {
  const skillFiles = await findSkillMarkdownFiles(extractRoot);
  if (skillFiles.length === 0) {
    throw new SkillPackageImportError('Skill package must contain a SKILL.md file.');
  }
  if (skillFiles.length > 1) {
    throw new SkillPackageImportError(
      `Skill package contains multiple SKILL.md files. Import one skill at a time: ${skillFiles.slice(0, 5).join(', ')}`,
    );
  }

  return requirePathInside(extractRoot, path.dirname(skillFiles[0]));
}

async function validateUploadedPackage(packageRoot: string): Promise<{
  skillName: string;
  validation: ValidationResult;
}> {
  const skillPath = requirePathInside(packageRoot, 'SKILL.md');
  const content = await fs.readFile(skillPath, 'utf-8').catch(() => null);
  if (content === null) {
    throw new SkillPackageImportError('Skill package must contain SKILL.md at the detected package root.');
  }

  const { frontmatter } = parseFrontmatter(content);
  if (!frontmatter) {
    const validation = { valid: false, errors: ['No valid YAML frontmatter found'], warnings: [] };
    throw new SkillPackageImportError(
      'No valid YAML frontmatter found. SKILL.md must start with --- delimiters.',
      400,
      validation,
    );
  }

  const validation = validateFrontmatter(frontmatter);
  if (!validation.valid) {
    throw new SkillPackageImportError('Skill validation failed.', 400, validation);
  }

  const parsed = await parseSkillFile(skillPath);
  if (!parsed) {
    throw new SkillPackageImportError('Skill package contains an invalid SKILL.md.', 400, validation);
  }

  return { skillName: parsed.name, validation };
}

async function ensureSkillCanBeInstalled(
  skillName: string,
  scope?: CanvasSkillStorageScope | null,
): Promise<void> {
  const existing = await loadSkillByName(skillName, scope, { legacyFallback: false });
  const standalonePath = requirePathInside(getSkillsDir(scope), skillName, 'SKILL.md');
  const hasStandalone = await fs.stat(standalonePath).then((stat) => stat.isFile()).catch(() => false);

  if (existing?.plugin) {
    throw new SkillPackageImportError(
      `Skill "${skillName}" is managed by plugin "${existing.plugin.name}". Remove or disable that plugin first.`,
      409,
    );
  }
  if (existing || hasStandalone) {
    throw new SkillPackageImportError(`Skill "${skillName}" already exists. Use the skill editor to modify it.`, 409);
  }
}

async function copySkillPackage(
  packageRoot: string,
  skillName: string,
  scope?: CanvasSkillStorageScope | null,
): Promise<string> {
  const skillsDir = getSkillsDir(scope);
  const targetDir = requirePathInside(skillsDir, skillName);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });

  await fs.cp(packageRoot, targetDir, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => {
      const relativePath = path.relative(packageRoot, source).split(path.sep).join('/');
      return !relativePath || !isIgnoredPackagePath(relativePath);
    },
  });

  return targetDir;
}

async function writeLocalSkillRegistryRecord(params: {
  skillName: string;
  sourceName: string;
  installDir: string;
  scope?: CanvasSkillStorageScope | null;
}): Promise<CanvasSkillInstallRecord> {
  const skillPath = requirePathInside(params.installDir, 'SKILL.md');
  const skill = await parseSkillFile(skillPath);
  if (!skill) {
    throw new SkillPackageImportError(`Installed skill "${params.skillName}" is invalid.`);
  }

  const registry = await readCanvasSkillRegistry(params.scope);
  const existing = registry.skills[params.skillName];
  const record: CanvasSkillInstallRecord = {
    name: skill.name,
    version: skill.version || 'local',
    description: skill.description,
    license: skill.license,
    sourceType: 'local',
    sourcePath: params.sourceName,
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

async function enableImportedSkill(
  skillName: string,
  scope?: CanvasSkillStorageScope | null,
  updatedBy?: string,
): Promise<void> {
  const enabledSkills = await readEnabledSkillsForScope(scope);
  const allSkillNames = await getSkillNames(scope);
  const nextEnabledSkills = enableSkillInConfig(skillName, enabledSkills, allSkillNames);
  await writeEnabledSkillsForScope(nextEnabledSkills, { scope, updatedBy });
}

function sourceNameForRecord(source: SkillPackageImportSource): string {
  if (source.kind === 'text') return source.sourceName || 'manual-upload:SKILL.md';
  if (source.kind === 'archive') return `upload:${source.sourceName}`;
  return `folder-upload:${source.sourceName || 'selected-folder'}`;
}

export async function importSkillPackage(
  source: SkillPackageImportSource,
  options: {
    scope?: CanvasSkillStorageScope | null;
    updatedBy?: string;
    enable?: boolean;
  } = {},
): Promise<SkillPackageImportResult> {
  let tempRoot: string | null = null;

  try {
    await adoptLegacyStandaloneSkillsForScope(options.scope);

    const created = await createTempPackageRoot(source);
    tempRoot = created.tempRoot;
    const packageRoot = await resolveSkillPackageRoot(created.extractRoot);
    const { skillName, validation } = await validateUploadedPackage(packageRoot);

    await ensureSkillCanBeInstalled(skillName, options.scope);
    const installDir = await copySkillPackage(packageRoot, skillName, options.scope);
    await writeLocalSkillRegistryRecord({
      skillName,
      sourceName: sourceNameForRecord(source),
      installDir,
      scope: options.scope,
    });

    if (options.enable !== false) {
      await enableImportedSkill(skillName, options.scope, options.updatedBy).catch((error) => {
        console.warn('[SkillPackageImport] Could not auto-enable skill:', skillName, error);
      });
    }

    return {
      success: true,
      name: skillName,
      path: requirePathInside(installDir, 'SKILL.md'),
      validation,
      importedFiles: created.importedFiles,
      sourceKind: source.kind,
    };
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
