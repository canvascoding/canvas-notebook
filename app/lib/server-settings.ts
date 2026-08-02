import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';

import { resolveSystemSettingsDir } from '@/app/lib/runtime-data-paths';
import { DEFAULT_USER_TIME_ZONE, isValidTimeZone, normalizeTimeZone } from '@/app/lib/time-zones';

const SERVER_SETTINGS_FILE = 'server-preferences.json';

export const INSTANCE_ONBOARDING_STEPS = ['server', 'license', 'provider', 'workspace', 'review'] as const;
export type InstanceOnboardingStep = typeof INSTANCE_ONBOARDING_STEPS[number];
export const LICENSE_RUNTIME_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type LicenseRuntimeEnvironment = typeof LICENSE_RUNTIME_ENVIRONMENTS[number];

export type ServerSettings = {
  timeZone?: string;
  updatedAt?: string;
  updatedBy?: string;
  onboardingStep?: InstanceOnboardingStep;
  onboardingUpdatedAt?: string;
  onboardingUpdatedBy?: string;
  providerVerifiedAt?: string;
  providerVerifiedBy?: string;
  providerVerifiedCatalogRevision?: number;
  providerVerifiedInstallationId?: string;
};

type ServerSettingsFile = {
  version: 1;
  settings: ServerSettings;
};

export function getExpectedLicenseRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): LicenseRuntimeEnvironment | null {
  const configured = environment.CANVAS_LICENSE_RUNTIME_ENVIRONMENT?.trim().toLowerCase();
  if (configured) {
    return (LICENSE_RUNTIME_ENVIRONMENTS as readonly string[]).includes(configured)
      ? configured as LicenseRuntimeEnvironment
      : null;
  }
  if (environment.NODE_ENV === 'development') return 'development';
  if (environment.NODE_ENV === 'test') return 'test';
  return 'production';
}

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

function normalizeInstanceOnboardingStep(value: unknown): InstanceOnboardingStep | null {
  if (value === 'language') return 'server';
  if (value === 'profile') return 'review';
  return typeof value === 'string' && (INSTANCE_ONBOARDING_STEPS as readonly string[]).includes(value)
    ? value as InstanceOnboardingStep
    : null;
}

function normalizeServerSettings(value: unknown): ServerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as {
    timeZone?: unknown;
    updatedAt?: unknown;
    updatedBy?: unknown;
    onboardingStep?: unknown;
    onboardingUpdatedAt?: unknown;
    onboardingUpdatedBy?: unknown;
    providerVerifiedAt?: unknown;
    providerVerifiedBy?: unknown;
    providerVerifiedCatalogRevision?: unknown;
    providerVerifiedInstallationId?: unknown;
  };
  const timeZone = normalizeTimeZoneValue(record.timeZone);
  const onboardingStep = normalizeInstanceOnboardingStep(record.onboardingStep);
  return {
    ...(timeZone ? { timeZone } : {}),
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.updatedBy === 'string' ? { updatedBy: record.updatedBy } : {}),
    ...(onboardingStep ? { onboardingStep } : {}),
    ...(typeof record.onboardingUpdatedAt === 'string' ? { onboardingUpdatedAt: record.onboardingUpdatedAt } : {}),
    ...(typeof record.onboardingUpdatedBy === 'string' ? { onboardingUpdatedBy: record.onboardingUpdatedBy } : {}),
    ...(typeof record.providerVerifiedAt === 'string' ? { providerVerifiedAt: record.providerVerifiedAt } : {}),
    ...(typeof record.providerVerifiedBy === 'string' ? { providerVerifiedBy: record.providerVerifiedBy } : {}),
    ...(typeof record.providerVerifiedCatalogRevision === 'number'
      && Number.isSafeInteger(record.providerVerifiedCatalogRevision)
      && record.providerVerifiedCatalogRevision >= 0
      ? { providerVerifiedCatalogRevision: record.providerVerifiedCatalogRevision }
      : {}),
    ...(typeof record.providerVerifiedInstallationId === 'string' && /^aip_[a-f0-9]{24}$/u.test(record.providerVerifiedInstallationId)
      ? { providerVerifiedInstallationId: record.providerVerifiedInstallationId }
      : {}),
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

export async function getInstanceOnboardingStep(): Promise<InstanceOnboardingStep> {
  const settings = await getServerSettings();
  return settings.onboardingStep ?? 'server';
}

export async function setInstanceOnboardingStep(
  userId: string,
  step: InstanceOnboardingStep,
): Promise<ServerSettings> {
  if (!(INSTANCE_ONBOARDING_STEPS as readonly string[]).includes(step)) {
    throw new Error('Unsupported onboarding step.');
  }
  const file = await readServerSettingsFile();
  const now = new Date().toISOString();
  const nextSettings: ServerSettings = {
    ...file.settings,
    onboardingStep: step,
    onboardingUpdatedAt: now,
    onboardingUpdatedBy: userId,
  };
  await writeServerSettingsFileAtomic({ version: 1, settings: nextSettings });
  return nextSettings;
}

export async function markInstanceProviderVerified(
  userId: string,
  verification?: { catalogRevision: number; providerInstallationId: string },
): Promise<ServerSettings> {
  if (verification && (
    !Number.isSafeInteger(verification.catalogRevision)
    || verification.catalogRevision < 0
    || !/^aip_[a-f0-9]{24}$/u.test(verification.providerInstallationId)
  )) {
    throw new Error('Unsupported provider verification metadata.');
  }
  const file = await readServerSettingsFile();
  const now = new Date().toISOString();
  const nextSettings: ServerSettings = {
    ...file.settings,
    providerVerifiedAt: now,
    providerVerifiedBy: userId,
    ...(verification ? {
      providerVerifiedCatalogRevision: verification.catalogRevision,
      providerVerifiedInstallationId: verification.providerInstallationId,
    } : {}),
  };
  await writeServerSettingsFileAtomic({ version: 1, settings: nextSettings });
  return nextSettings;
}
