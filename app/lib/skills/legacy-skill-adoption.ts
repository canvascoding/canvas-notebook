import { promises as fs } from 'fs';
import path from 'path';

import {
  resolveScopedSkillRegistryPath,
  resolveScopedSkillsDataDir,
  shouldUseLegacyScopedSkillsFallback,
  type UserScopedDataStorageScope,
} from '@/app/lib/runtime-data-paths';
import { isPathInside } from '@/app/lib/plugins/canvas-plugin-manifest';

type StandaloneSkillRegistryRecord = {
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
  interface?: unknown;
};

type StandaloneSkillRegistry = {
  version: 1;
  updatedAt: string;
  skills: Record<string, StandaloneSkillRegistryRecord>;
};

const IGNORED_SKILL_COPY_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store']);

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyRegistry(): StandaloneSkillRegistry {
  return {
    version: 1,
    updatedAt: nowIso(),
    skills: {},
  };
}

async function readStandaloneSkillRegistryFile(registryPath: string): Promise<StandaloneSkillRegistry | null> {
  try {
    const raw = await fs.readFile(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as StandaloneSkillRegistry;
    if (parsed?.version === 1 && parsed.skills && typeof parsed.skills === 'object') {
      return parsed;
    }
  } catch {
    // Missing or invalid legacy registries are treated as empty.
  }
  return null;
}

async function writeStandaloneSkillRegistryFile(registryPath: string, registry: StandaloneSkillRegistry): Promise<void> {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify({
    ...registry,
    version: 1,
    updatedAt: nowIso(),
  }, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, registryPath);
}

function rebaseLegacyStandaloneSkillRecord(
  record: StandaloneSkillRegistryRecord,
  legacySkillsDir: string,
  scopedSkillsDir: string,
): StandaloneSkillRegistryRecord {
  const rebaseSkillPath = (value: string): string => {
    return isPathInside(legacySkillsDir, value)
      ? path.join(scopedSkillsDir, path.relative(legacySkillsDir, value))
      : value;
  };

  return {
    ...record,
    installDir: rebaseSkillPath(record.installDir),
    skillPath: rebaseSkillPath(record.skillPath),
  };
}

export async function adoptLegacyStandaloneSkillsForScope(
  scope?: UserScopedDataStorageScope | null,
): Promise<boolean> {
  if (!(await shouldUseLegacyScopedSkillsFallback(scope))) {
    return false;
  }

  const legacySkillsDir = resolveScopedSkillsDataDir();
  const scopedSkillsDir = resolveScopedSkillsDataDir(scope);
  if (path.resolve(/*turbopackIgnore: true*/ legacySkillsDir) === path.resolve(/*turbopackIgnore: true*/ scopedSkillsDir)) {
    return false;
  }

  const entries = await fs.readdir(legacySkillsDir, { withFileTypes: true }).catch(() => []);
  await fs.mkdir(scopedSkillsDir, { recursive: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.backups') {
      continue;
    }

    const sourceDir = path.join(legacySkillsDir, entry.name);
    const skillPath = path.join(sourceDir, 'SKILL.md');
    const isSkillDir = await fs.stat(skillPath).then((stat) => stat.isFile()).catch(() => false);
    if (!isSkillDir) {
      continue;
    }

    const targetDir = path.join(scopedSkillsDir, entry.name);
    const targetExists = await fs.stat(targetDir).then((stat) => stat.isDirectory()).catch(() => false);
    if (targetExists) {
      continue;
    }

    await fs.cp(sourceDir, targetDir, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => !IGNORED_SKILL_COPY_ENTRIES.has(path.basename(source)),
    });
  }

  const legacyRegistry = await readStandaloneSkillRegistryFile(resolveScopedSkillRegistryPath()) || createEmptyRegistry();
  const scopedRegistry = await readStandaloneSkillRegistryFile(resolveScopedSkillRegistryPath(scope)) || createEmptyRegistry();
  for (const [skillName, record] of Object.entries(legacyRegistry.skills)) {
    if (scopedRegistry.skills[skillName]) {
      continue;
    }
    scopedRegistry.skills[skillName] = rebaseLegacyStandaloneSkillRecord(record, legacySkillsDir, scopedSkillsDir);
  }
  await writeStandaloneSkillRegistryFile(resolveScopedSkillRegistryPath(scope), scopedRegistry);

  return true;
}
