import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';

import { resolveSystemSettingsDir } from '@/app/lib/runtime-data-paths';
import { DEFAULT_USER_TIME_ZONE, isValidTimeZone, normalizeTimeZone } from '@/app/lib/time-zones';

const SERVER_SETTINGS_FILE = 'server-preferences.json';

export type ServerSettings = {
  timeZone?: string;
  updatedAt?: string;
  updatedBy?: string;
};

type ServerSettingsFile = {
  version: 1;
  settings: ServerSettings;
};

function emptyServerSettingsFile(): ServerSettingsFile {
  return { version: 1, settings: {} };
}

function serverSettingsFilePath(): string {
  return path.join(resolveSystemSettingsDir(), SERVER_SETTINGS_FILE);
}

async function ensureSystemSettingsDir(): Promise<void> {
  const dir = resolveSystemSettingsDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
}

function normalizeTimeZoneValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return isValidTimeZone(value) ? value.trim() : null;
}

function normalizeServerSettings(value: unknown): ServerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as { timeZone?: unknown; updatedAt?: unknown; updatedBy?: unknown };
  const timeZone = normalizeTimeZoneValue(record.timeZone);
  return {
    ...(timeZone ? { timeZone } : {}),
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.updatedBy === 'string' ? { updatedBy: record.updatedBy } : {}),
  };
}

function parseServerSettingsFile(content: string | null): ServerSettingsFile {
  if (!content?.trim()) return emptyServerSettingsFile();
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyServerSettingsFile();
    }
    const rawSettings = (parsed as { settings?: unknown }).settings;
    if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
      return emptyServerSettingsFile();
    }
    return { version: 1, settings: normalizeServerSettings(rawSettings) };
  } catch {
    return emptyServerSettingsFile();
  }
}

async function readServerSettingsFile(): Promise<ServerSettingsFile> {
  const filePath = serverSettingsFilePath();
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return parseServerSettingsFile(content);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return emptyServerSettingsFile();
    }
    throw error;
  }
}

async function writeServerSettingsFileAtomic(payload: ServerSettingsFile): Promise<void> {
  await ensureSystemSettingsDir();
  const filePath = serverSettingsFilePath();
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tempPath = `${filePath}.tmp-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, body, { mode: 0o600 });
  await fs.chmod(tempPath, 0o600).catch(() => undefined);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function getServerSettings(): Promise<ServerSettings> {
  const file = await readServerSettingsFile();
  return file.settings;
}

export async function getServerPreferredTimeZone(): Promise<string> {
  const settings = await getServerSettings();
  return normalizeTimeZone(settings.timeZone, DEFAULT_USER_TIME_ZONE);
}

export async function setServerPreferredTimeZone(
  userId: string,
  timeZone: unknown,
): Promise<ServerSettings> {
  const normalized = normalizeTimeZoneValue(timeZone);
  if (!normalized) {
    throw new Error('Unsupported time zone.');
  }
  const file = await readServerSettingsFile();
  const nextSettings: ServerSettings = {
    ...file.settings,
    timeZone: normalized,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };
  await writeServerSettingsFileAtomic({ version: 1, settings: nextSettings });
  return nextSettings;
}