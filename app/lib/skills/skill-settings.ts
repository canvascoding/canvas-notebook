import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';

import { readPiRuntimeConfig, writePiRuntimeConfig } from '@/app/lib/agents/storage';
import {
  createAtomicTempPath,
  resolveScopedSettingsDir,
  type UserScopedDataStorageScope,
} from '@/app/lib/runtime-data-paths';

export type SkillSettingsScope = UserScopedDataStorageScope;

export interface CanvasSkillSettings {
  version: 1;
  updatedAt: string;
  updatedBy?: string;
  enabledSkills: string[];
}

const SKILL_SETTINGS_FILE = 'skills.json';

function nowIso(): string {
  return new Date().toISOString();
}

function hasUserScope(scope?: SkillSettingsScope | null): boolean {
  return Boolean(scope?.userId?.trim());
}

function createSkillSettings(enabledSkills: string[], updatedBy?: string): CanvasSkillSettings {
  return {
    version: 1,
    updatedAt: nowIso(),
    updatedBy,
    enabledSkills,
  };
}

function resolveSkillSettingsPath(scope?: SkillSettingsScope | null): string {
  return path.join(resolveScopedSettingsDir(scope), SKILL_SETTINGS_FILE);
}

async function readUserSkillSettings(scope: SkillSettingsScope): Promise<CanvasSkillSettings | null> {
  const settingsPath = resolveSkillSettingsPath(scope);
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CanvasSkillSettings>;
    if (
      parsed.version === 1
      && Array.isArray(parsed.enabledSkills)
      && parsed.enabledSkills.every((entry) => typeof entry === 'string')
    ) {
      return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
        updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : undefined,
        enabledSkills: parsed.enabledSkills,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[SkillSettings] Failed to read user skill settings, falling back to legacy runtime config:', error);
    }
  }
  return null;
}

async function writeUserSkillSettings(settings: CanvasSkillSettings, scope: SkillSettingsScope): Promise<void> {
  const settingsPath = resolveSkillSettingsPath(scope);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const tmpPath = createAtomicTempPath(settingsPath);
  await fs.writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, settingsPath);
}

export async function readEnabledSkillsForScope(
  scope?: SkillSettingsScope | null,
): Promise<string[] | undefined> {
  if (hasUserScope(scope)) {
    const userSettings = await readUserSkillSettings(scope as SkillSettingsScope);
    if (userSettings) {
      return userSettings.enabledSkills;
    }
  }

  const legacyConfig = await readPiRuntimeConfig();
  return legacyConfig.enabledSkills;
}

export async function writeEnabledSkillsForScope(
  enabledSkills: string[],
  options: {
    scope?: SkillSettingsScope | null;
    updatedBy?: string;
  } = {},
): Promise<void> {
  if (hasUserScope(options.scope)) {
    await writeUserSkillSettings(
      createSkillSettings(enabledSkills, options.updatedBy),
      options.scope as SkillSettingsScope,
    );
    return;
  }

  const config = await readPiRuntimeConfig();
  config.enabledSkills = enabledSkills;
  config.updatedAt = nowIso();
  config.updatedBy = options.updatedBy || config.updatedBy;
  await writePiRuntimeConfig(config);
}
