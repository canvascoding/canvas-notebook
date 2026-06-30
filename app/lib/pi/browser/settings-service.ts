import 'server-only';

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { resolveSystemSettingsDir } from '@/app/lib/runtime-data-paths';
import { isBrowserToolEnabledConfig } from '@/app/lib/pi/enabled-tools';

import { getBrowserRequirementStatus, type BrowserRequirementStatus } from './requirements';

const SETTINGS_FILE = 'browser-runtime-settings.json';

export type BrowserRuntimeAvailability = 'available' | 'disabled';

export type BrowserRuntimeSettings = {
  runtimeEnabled: boolean;
  allowAgentBrowserTool: boolean;
  allowBrowserBasedExports: boolean;
  updatedAt: string | null;
  updatedByUserId: string | null;
};

export type BrowserRuntimeCapability = {
  settings: BrowserRuntimeSettings;
  requirements: BrowserRequirementStatus;
  availability: BrowserRuntimeAvailability;
  runtimeAvailable: boolean;
  browserToolAvailable: boolean;
  browserExportsAvailable: boolean;
  blockers: string[];
  warnings: string[];
  checkedAt: string;
};

export type BrowserRuntimeSettingsUpdate = Partial<Pick<
  BrowserRuntimeSettings,
  'runtimeEnabled' | 'allowAgentBrowserTool' | 'allowBrowserBasedExports'
>>;

const DEFAULT_BROWSER_RUNTIME_SETTINGS: BrowserRuntimeSettings = {
  runtimeEnabled: true,
  allowAgentBrowserTool: true,
  allowBrowserBasedExports: true,
  updatedAt: null,
  updatedByUserId: null,
};

function resolveSettingsPath(): string {
  return path.join(resolveSystemSettingsDir(), SETTINGS_FILE);
}

async function ensurePrivateParent(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateParent(filePath);
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => undefined);
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeBrowserRuntimeSettings(value: unknown): BrowserRuntimeSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<BrowserRuntimeSettings>
    : {};

  return {
    runtimeEnabled: normalizeBoolean(record.runtimeEnabled, DEFAULT_BROWSER_RUNTIME_SETTINGS.runtimeEnabled),
    allowAgentBrowserTool: normalizeBoolean(record.allowAgentBrowserTool, DEFAULT_BROWSER_RUNTIME_SETTINGS.allowAgentBrowserTool),
    allowBrowserBasedExports: normalizeBoolean(record.allowBrowserBasedExports, DEFAULT_BROWSER_RUNTIME_SETTINGS.allowBrowserBasedExports),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    updatedByUserId: typeof record.updatedByUserId === 'string' ? record.updatedByUserId : null,
  };
}

export async function readBrowserRuntimeSettings(): Promise<{
  settings: BrowserRuntimeSettings;
  storage: { filePath: string };
}> {
  const filePath = resolveSettingsPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return {
      settings: normalizeBrowserRuntimeSettings(JSON.parse(raw)),
      storage: { filePath },
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      throw error;
    }
    return {
      settings: { ...DEFAULT_BROWSER_RUNTIME_SETTINGS },
      storage: { filePath },
    };
  }
}

export async function updateBrowserRuntimeSettings(input: {
  actorUserId: string;
  updates: BrowserRuntimeSettingsUpdate;
}): Promise<BrowserRuntimeSettings> {
  const current = await readBrowserRuntimeSettings();
  const next: BrowserRuntimeSettings = {
    ...current.settings,
    updatedAt: new Date().toISOString(),
    updatedByUserId: input.actorUserId,
  };

  if ('runtimeEnabled' in input.updates) {
    next.runtimeEnabled = Boolean(input.updates.runtimeEnabled);
  }
  if ('allowAgentBrowserTool' in input.updates) {
    next.allowAgentBrowserTool = Boolean(input.updates.allowAgentBrowserTool);
  }
  if ('allowBrowserBasedExports' in input.updates) {
    next.allowBrowserBasedExports = Boolean(input.updates.allowBrowserBasedExports);
  }

  await writeJsonAtomic(current.storage.filePath, next);
  return next;
}

export async function resolveBrowserRuntimeCapability(input?: {
  settings?: BrowserRuntimeSettings;
  requirements?: BrowserRequirementStatus;
}): Promise<BrowserRuntimeCapability> {
  const settings = input?.settings ?? (await readBrowserRuntimeSettings()).settings;
  const requirements = input?.requirements ?? getBrowserRequirementStatus({ cache: true });
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!settings.runtimeEnabled) blockers.push('browser_runtime_disabled');
  if (!requirements.available) blockers.push('chromium_unavailable');
  if (settings.runtimeEnabled && !settings.allowAgentBrowserTool) warnings.push('agent_browser_tool_disabled');
  if (settings.runtimeEnabled && !settings.allowBrowserBasedExports) warnings.push('browser_exports_disabled');

  const runtimeAvailable = settings.runtimeEnabled && requirements.available;
  const browserToolAvailable = runtimeAvailable && settings.allowAgentBrowserTool;
  const browserExportsAvailable = runtimeAvailable && settings.allowBrowserBasedExports;

  return {
    settings,
    requirements,
    availability: runtimeAvailable ? 'available' : 'disabled',
    runtimeAvailable,
    browserToolAvailable,
    browserExportsAvailable,
    blockers,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

function formatBrowserRuntimeIssues(
  capability: BrowserRuntimeCapability,
  scope: 'tool' | 'export',
): string {
  const issues = [...capability.blockers];

  if (scope === 'tool' && capability.settings.runtimeEnabled && !capability.settings.allowAgentBrowserTool) {
    issues.push('agent_browser_tool_disabled');
  }
  if (scope === 'export' && capability.settings.runtimeEnabled && !capability.settings.allowBrowserBasedExports) {
    issues.push('browser_exports_disabled');
  }

  return issues.join(', ') || capability.requirements.reason || 'disabled';
}

export async function assertBrowserToolAvailable(): Promise<void> {
  const capability = await resolveBrowserRuntimeCapability();
  if (capability.browserToolAvailable) return;
  throw new Error(`Browser tool is not available: ${formatBrowserRuntimeIssues(capability, 'tool')}`);
}

export async function assertBrowserRuntimeAvailable(): Promise<void> {
  const capability = await resolveBrowserRuntimeCapability();
  if (capability.runtimeAvailable) return;
  throw new Error(`Browser runtime is not available: ${capability.blockers.join(', ') || capability.requirements.reason || 'disabled'}`);
}

export async function assertBrowserToolCanBeEnabled(input?: {
  previousEnabledTools?: string[] | null;
  nextEnabledTools?: string[] | null;
}): Promise<void> {
  const wasEnabled = isBrowserToolEnabledConfig(input?.previousEnabledTools);
  const willBeEnabled = isBrowserToolEnabledConfig(input?.nextEnabledTools);
  if (!willBeEnabled || wasEnabled) return;

  const capability = await resolveBrowserRuntimeCapability();
  if (capability.browserToolAvailable) return;
  throw new Error(`Browser tool cannot be enabled: ${formatBrowserRuntimeIssues(capability, 'tool')}`);
}

export async function assertBrowserExportAvailable(): Promise<void> {
  const capability = await resolveBrowserRuntimeCapability();
  if (capability.browserExportsAvailable) return;
  throw new Error(`Browser-based export is not available: ${formatBrowserRuntimeIssues(capability, 'export')}`);
}

export function isBrowserExportUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('Browser-based export is not available:');
}
