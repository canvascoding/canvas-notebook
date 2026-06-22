import 'server-only';

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  getDatabaseProvider,
  type OrganizationPermissionState,
} from '@/app/lib/organization/bootstrap';
import {
  resolveCanvasDataRoot,
  resolveOrganizationSettingsDir,
  resolveSystemLogsDir,
  resolveSystemSettingsDir,
} from '@/app/lib/runtime-data-paths';
import {
  type KnowledgeOperationalLogEntry,
  type KnowledgeParsingSettings,
  type KnowledgeResourceAvailability,
  type KnowledgeResourceProfile,
  type KnowledgeResourceStatus,
} from '@/app/lib/knowledge/settings-types';

const SETTINGS_FILE = 'knowledge-parsing-settings.json';
const LOG_FILE = 'knowledge-operational.jsonl';
const DEFAULT_MINIMUM_FREE_MEMORY_MB = 512;
const MIN_ENABLE_MEMORY_MB = 2048;
const MIN_ENABLE_DISK_GB = 10;
const MAX_LOG_ENTRIES = 50;
const MAX_LOG_FILE_LINES = 500;

type KnowledgeSettingsStorage = {
  scope: 'organization' | 'system';
  filePath: string;
};

type KnowledgeSettingsUpdate = Partial<Omit<
  KnowledgeParsingSettings,
  'updatedAt' | 'updatedByUserId'
>>;

const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeParsingSettings = {
  knowledgeAutoIngestionEnabled: false,
  heavyDocumentParsingEnabled: false,
  doclingEnabled: false,
  ocrEnabled: false,
  embeddingIndexingEnabled: false,
  remoteParsingEnabled: false,
  maxConcurrentHeavyJobs: 1,
  maxDocumentSizeMb: 25,
  maxPages: 200,
  maxOcrPages: 25,
  perFileTimeoutSeconds: 120,
  minimumFreeMemoryMb: DEFAULT_MINIMUM_FREE_MEMORY_MB,
  updatedAt: null,
  updatedByUserId: null,
};

const BOOLEAN_SETTING_KEYS = [
  'knowledgeAutoIngestionEnabled',
  'heavyDocumentParsingEnabled',
  'doclingEnabled',
  'ocrEnabled',
  'embeddingIndexingEnabled',
  'remoteParsingEnabled',
] as const;

const NUMBER_SETTING_LIMITS: Record<
  Exclude<keyof KnowledgeSettingsUpdate, (typeof BOOLEAN_SETTING_KEYS)[number]>,
  { min: number; max: number }
> = {
  maxConcurrentHeavyJobs: { min: 1, max: 4 },
  maxDocumentSizeMb: { min: 1, max: 1024 },
  maxPages: { min: 1, max: 5000 },
  maxOcrPages: { min: 0, max: 500 },
  perFileTimeoutSeconds: { min: 10, max: 3600 },
  minimumFreeMemoryMb: { min: 128, max: 32768 },
};

function resolveKnowledgeSettingsStorage(state?: OrganizationPermissionState | null): KnowledgeSettingsStorage {
  const organizationId = state?.organizationId?.trim();
  if (organizationId) {
    return {
      scope: 'organization',
      filePath: path.join(resolveOrganizationSettingsDir(organizationId), SETTINGS_FILE),
    };
  }

  return {
    scope: 'system',
    filePath: path.join(resolveSystemSettingsDir(), SETTINGS_FILE),
  };
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

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeKnowledgeSettings(value: unknown): KnowledgeParsingSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<KnowledgeParsingSettings>
    : {};

  const normalized: KnowledgeParsingSettings = {
    ...DEFAULT_KNOWLEDGE_SETTINGS,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    updatedByUserId: typeof record.updatedByUserId === 'string' ? record.updatedByUserId : null,
  };

  for (const key of BOOLEAN_SETTING_KEYS) {
    normalized[key] = normalizeBoolean(record[key], DEFAULT_KNOWLEDGE_SETTINGS[key]);
  }
  for (const [key, limits] of Object.entries(NUMBER_SETTING_LIMITS) as Array<[keyof typeof NUMBER_SETTING_LIMITS, { min: number; max: number }]>) {
    normalized[key] = normalizeNumber(record[key], DEFAULT_KNOWLEDGE_SETTINGS[key], limits.min, limits.max);
  }

  return normalized;
}

export async function readKnowledgeParsingSettings(
  state?: OrganizationPermissionState | null,
): Promise<{ settings: KnowledgeParsingSettings; storage: KnowledgeSettingsStorage }> {
  const storage = resolveKnowledgeSettingsStorage(state);
  try {
    const raw = await fs.readFile(storage.filePath, 'utf8');
    return {
      settings: normalizeKnowledgeSettings(JSON.parse(raw)),
      storage,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      throw error;
    }
    return {
      settings: { ...DEFAULT_KNOWLEDGE_SETTINGS },
      storage,
    };
  }
}

async function getDiskFreeGb(): Promise<number | null> {
  try {
    const stats = await fs.statfs(resolveCanvasDataRoot());
    return Math.floor((stats.bavail * stats.bsize) / 1024 / 1024 / 1024);
  } catch {
    return null;
  }
}

function resolveMemoryProfile(totalMb: number | null): KnowledgeResourceProfile {
  if (totalMb === null || totalMb < 1536) return 'disabled';
  if (totalMb < 4096) return 'low';
  if (totalMb < 8192) return 'standard';
  return 'large';
}

function availabilityFor(
  blockers: string[],
  warnings: string[],
  profile: KnowledgeResourceProfile,
): KnowledgeResourceAvailability {
  if (blockers.length > 0 || profile === 'disabled') return 'disabled';
  if (warnings.length > 0 || profile === 'low') return 'degraded';
  return 'available';
}

export async function resolveKnowledgeResourceStatus(
  settings: KnowledgeParsingSettings,
  state?: OrganizationPermissionState | null,
): Promise<KnowledgeResourceStatus> {
  const databaseProvider = (state?.databaseProvider || getDatabaseProvider()).trim().toLowerCase() || 'sqlite';
  const postgresReady = databaseProvider === 'postgres';
  const pgvectorReady = process.env.CANVAS_POSTGRES_VECTOR_ENABLED === 'true';
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const diskFreeGb = await getDiskFreeGb();
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!postgresReady) blockers.push('requires_postgres');
  if (postgresReady && !pgvectorReady) blockers.push('requires_pgvector');
  if (totalMb < MIN_ENABLE_MEMORY_MB) blockers.push('memory_below_2gb');
  if (freeMb < settings.minimumFreeMemoryMb) warnings.push('free_memory_below_guard');
  if (diskFreeGb !== null && diskFreeGb < MIN_ENABLE_DISK_GB) blockers.push('disk_below_10gb');
  if (os.cpus().length < 2) warnings.push('single_cpu_serial_jobs');

  const profile = resolveMemoryProfile(totalMb);
  const availability = availabilityFor(blockers, warnings, profile);
  const canEnableKnowledge = blockers.length === 0 && profile !== 'disabled';

  return {
    availability,
    resourceProfile: profile,
    databaseProvider,
    postgresRequired: true,
    postgresReady,
    pgvectorReady,
    memory: {
      totalMb,
      freeMb,
      thresholdMb: MIN_ENABLE_MEMORY_MB,
    },
    cpu: {
      count: os.cpus().length || null,
    },
    disk: {
      freeGb: diskFreeGb,
      thresholdGb: MIN_ENABLE_DISK_GB,
    },
    queue: {
      depth: 0,
      activeHeavyJobs: 0,
    },
    parser: {
      docling: settings.doclingEnabled ? 'not_checked' : 'disabled',
      ocr: settings.ocrEnabled ? 'not_checked' : 'disabled',
      embeddings: settings.embeddingIndexingEnabled
        ? (postgresReady && pgvectorReady ? 'available' : 'requires_postgres')
        : 'disabled',
      remoteParsing: settings.remoteParsingEnabled ? 'enabled' : 'disabled',
    },
    canEnableKnowledge,
    blockers,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

function sanitizeLogString(value: string): string {
  if (/(secret|token|password|credential|authorization|cookie|api[_-]?key|private[_-]?key)/iu.test(value)) {
    return '[REDACTED]';
  }
  return value.length > 180 ? `${value.slice(0, 180)}...` : value;
}

function sanitizeLogValue(value: boolean | number | string | null): boolean | number | string | null {
  return typeof value === 'string' ? sanitizeLogString(value) : value;
}

async function appendKnowledgeOperationalLog(entry: KnowledgeOperationalLogEntry): Promise<void> {
  const logDir = resolveSystemLogsDir();
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  await fs.chmod(logDir, 0o700).catch(() => undefined);
  const filePath = path.join(logDir, LOG_FILE);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  await trimKnowledgeOperationalLogFile(filePath);
}

async function trimKnowledgeOperationalLogFile(filePath: string): Promise<void> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= MAX_LOG_FILE_LINES) return;

    const trimmed = `${lines.slice(-MAX_LOG_FILE_LINES).join('\n')}\n`;
    const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tmpPath, trimmed, { mode: 0o600 });
    await fs.chmod(tmpPath, 0o600).catch(() => undefined);
    await fs.rename(tmpPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } catch {
    // Trimming failures must not block the settings update path.
  }
}

export async function readKnowledgeOperationalLogs(input?: {
  limit?: number;
  organizationId?: string | null;
}): Promise<KnowledgeOperationalLogEntry[]> {
  const filePath = path.join(resolveSystemLogsDir(), LOG_FILE);
  const limit = input?.limit ?? 12;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const entries: KnowledgeOperationalLogEntry[] = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        entries.push(JSON.parse(line) as KnowledgeOperationalLogEntry);
      } catch {
        // Keep readable entries visible if the process dies during appendFile.
      }
    }
    return entries
      .filter((entry) => input?.organizationId === undefined || entry.organizationId === input.organizationId)
      .slice(-Math.min(MAX_LOG_ENTRIES, Math.max(1, limit)))
      .reverse();
  } catch {
    return [];
  }
}

function collectChanges(
  previous: KnowledgeParsingSettings,
  next: KnowledgeParsingSettings,
): KnowledgeOperationalLogEntry['changes'] {
  const changes: KnowledgeOperationalLogEntry['changes'] = {};
  const keys = [...BOOLEAN_SETTING_KEYS, ...Object.keys(NUMBER_SETTING_LIMITS)] as Array<keyof KnowledgeSettingsUpdate>;
  for (const key of keys) {
    if (previous[key] !== next[key]) {
      changes[key] = {
        from: sanitizeLogValue(previous[key] ?? null),
        to: sanitizeLogValue(next[key] ?? null),
      };
    }
  }
  return changes;
}

function validateKnowledgeSettingsUpdate(
  next: KnowledgeParsingSettings,
  resourceStatus: KnowledgeResourceStatus,
): string[] {
  const errors: string[] = [];
  if ((next.doclingEnabled || next.ocrEnabled) && !next.heavyDocumentParsingEnabled) {
    errors.push('heavy_parsing_required_for_docling_or_ocr');
  }
  if (next.embeddingIndexingEnabled && !next.knowledgeAutoIngestionEnabled) {
    errors.push('knowledge_required_for_embeddings');
  }
  if ((next.knowledgeAutoIngestionEnabled || next.embeddingIndexingEnabled) && !resourceStatus.canEnableKnowledge) {
    errors.push(...resourceStatus.blockers);
  }
  if (next.heavyDocumentParsingEnabled && resourceStatus.memory.totalMb !== null && resourceStatus.memory.totalMb < MIN_ENABLE_MEMORY_MB) {
    errors.push('memory_below_2gb');
  }
  return Array.from(new Set(errors));
}

export async function updateKnowledgeParsingSettings(input: {
  state?: OrganizationPermissionState | null;
  actorUserId: string;
  updates: KnowledgeSettingsUpdate;
}): Promise<{
  settings: KnowledgeParsingSettings;
  storage: KnowledgeSettingsStorage;
  resourceStatus: KnowledgeResourceStatus;
  logs: KnowledgeOperationalLogEntry[];
  changedKeys: string[];
}> {
  const current = await readKnowledgeParsingSettings(input.state);
  const next: KnowledgeParsingSettings = {
    ...current.settings,
    updatedAt: new Date().toISOString(),
    updatedByUserId: input.actorUserId,
  };

  for (const key of BOOLEAN_SETTING_KEYS) {
    if (key in input.updates) {
      next[key] = Boolean(input.updates[key]);
    }
  }
  for (const [key, limits] of Object.entries(NUMBER_SETTING_LIMITS) as Array<[keyof typeof NUMBER_SETTING_LIMITS, { min: number; max: number }]>) {
    if (key in input.updates) {
      next[key] = normalizeNumber(input.updates[key], current.settings[key], limits.min, limits.max);
    }
  }

  const changes = collectChanges(current.settings, next);
  const changedKeys = Object.keys(changes);
  const resourceStatus = await resolveKnowledgeResourceStatus(next, input.state);
  const errors = validateKnowledgeSettingsUpdate(next, resourceStatus);
  if (errors.length > 0) {
    const logEntry: KnowledgeOperationalLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'warn',
      action: 'knowledge_settings.update_blocked',
      actorUserId: input.actorUserId,
      organizationId: input.state?.organizationId ?? null,
      reasonCode: errors[0] ?? 'blocked',
      changedKeys,
      changes,
      resourceProfile: resourceStatus.resourceProfile,
      blockers: errors,
      message: 'Knowledge settings update blocked by policy or resource preflight.',
    };
    await appendKnowledgeOperationalLog(logEntry);
    throw new Error(`Knowledge settings update blocked: ${errors.join(', ')}`);
  }

  if (changedKeys.length > 0) {
    await writeJsonAtomic(current.storage.filePath, next);
    await appendKnowledgeOperationalLog({
      timestamp: new Date().toISOString(),
      level: 'info',
      action: 'knowledge_settings.updated',
      actorUserId: input.actorUserId,
      organizationId: input.state?.organizationId ?? null,
      reasonCode: resourceStatus.availability,
      changedKeys,
      changes,
      resourceProfile: resourceStatus.resourceProfile,
      blockers: resourceStatus.blockers,
      message: 'Knowledge and parsing settings updated.',
    });
  }

  return {
    settings: changedKeys.length > 0 ? next : current.settings,
    storage: current.storage,
    resourceStatus,
    logs: await readKnowledgeOperationalLogs({ organizationId: input.state?.organizationId ?? null }),
    changedKeys,
  };
}
