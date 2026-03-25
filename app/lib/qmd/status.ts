import 'server-only';

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import {
  getQmdDerivedStatusPath,
  getQmdRuntimeStatusPath,
  isQmdEnabled,
  QMD_DEFAULT_COLLECTIONS,
  QMD_DEFAULT_MODE,
  QMD_DERIVED_COLLECTION_NAME,
  QMD_TEXT_COLLECTION_NAME,
  type QmdSearchMode,
} from '@/app/lib/qmd/runtime';

const execFileAsync = promisify(execFile);

type QmdRuntimeStatus = {
  qmdAvailable?: boolean;
  defaultMode?: QmdSearchMode;
  allowExpensiveQueryMode?: boolean;
  collections?: Array<{
    name: string;
    sourceType: 'workspace-text' | 'workspace-derived';
    path: string;
  }>;
  derivedDocxEnabled?: boolean;
  derivedStatusPath?: string;
  lastUpdateAt?: string | null;
  lastUpdateSuccess?: boolean;
  lastEmbedAt?: string | null;
};

type QmdDerivedStatus = {
  success?: boolean;
  derivedDocxEnabled?: boolean;
  lastRunAt?: string | null;
  extractedCount?: number;
  updatedCount?: number;
  errorCount?: number;
  warningCount?: number;
};

export type QmdDoctorStatus = {
  enabled: boolean;
  ready: boolean;
  binaryAvailable: boolean;
  defaultMode: QmdSearchMode;
  allowExpensiveQueryMode: boolean;
  collections: Array<{
    name: string;
    sourceType: 'workspace-text' | 'workspace-derived';
    path: string;
    present: boolean;
  }>;
  lastUpdateAt: string | null;
  lastUpdateSuccess: boolean;
  lastEmbedAt: string | null;
  derivedDocxIndexing: {
    enabled: boolean;
    healthy: boolean;
    lastRunAt: string | null;
    extractedCount: number;
    updatedCount: number;
    errorCount: number;
    warningCount: number;
  };
  issues: string[];
};

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function detectQmdBinary(): Promise<boolean> {
  try {
    await execFileAsync('sh', [
      '-lc',
      'export BUN_INSTALL="${BUN_INSTALL:-/data/cache/.bun}" && export PATH="$BUN_INSTALL/bin:$PATH" && command -v qmd >/dev/null 2>&1',
    ], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export async function getQmdDoctorStatus(): Promise<QmdDoctorStatus> {
  const enabled = isQmdEnabled();
  const piConfig = await readPiRuntimeConfig();

  if (!enabled) {
    return {
      enabled: false,
      ready: true,
      binaryAvailable: false,
      defaultMode: QMD_DEFAULT_MODE,
      allowExpensiveQueryMode: piConfig.qmd?.allowExpensiveQueryMode === true,
      collections: [],
      lastUpdateAt: null,
      lastUpdateSuccess: false,
      lastEmbedAt: null,
      derivedDocxIndexing: {
        enabled: false,
        healthy: false,
        lastRunAt: null,
        extractedCount: 0,
        updatedCount: 0,
        errorCount: 0,
        warningCount: 0,
      },
      issues: [],
    };
  }

  const [runtimeStatus, derivedStatus, binaryAvailable, loadedPiConfig] = await Promise.all([
    readJsonIfExists<QmdRuntimeStatus>(getQmdRuntimeStatusPath()),
    readJsonIfExists<QmdDerivedStatus>(getQmdDerivedStatusPath()),
    detectQmdBinary(),
    readPiRuntimeConfig(),
  ]);

  const collections = (runtimeStatus?.collections || [
    { name: QMD_TEXT_COLLECTION_NAME, sourceType: 'workspace-text' as const, path: '/data/workspace' },
    { name: QMD_DERIVED_COLLECTION_NAME, sourceType: 'workspace-derived' as const, path: '/data/cache/qmd/derived/docx' },
  ]).map((collection) => ({
    ...collection,
    present: QMD_DEFAULT_COLLECTIONS.includes(collection.name as (typeof QMD_DEFAULT_COLLECTIONS)[number]),
  }));

  const derivedDocxIndexing = {
    enabled: runtimeStatus?.derivedDocxEnabled !== false && derivedStatus?.derivedDocxEnabled !== false,
    healthy: (derivedStatus?.success ?? false) && (derivedStatus?.errorCount ?? 0) === 0,
    lastRunAt: derivedStatus?.lastRunAt || null,
    extractedCount: derivedStatus?.extractedCount ?? 0,
    updatedCount: derivedStatus?.updatedCount ?? 0,
    errorCount: derivedStatus?.errorCount ?? 0,
    warningCount: derivedStatus?.warningCount ?? 0,
  };

  const issues: string[] = [];

  if (!binaryAvailable) {
    issues.push('qmd binary not available on the server PATH.');
  }

  if (!runtimeStatus?.lastUpdateSuccess) {
    issues.push('qmd index has no successful recorded update yet.');
  }

  if (!collections.some((collection) => collection.name === QMD_TEXT_COLLECTION_NAME)) {
    issues.push('qmd workspace-text collection is missing from runtime status.');
  }

  if (!collections.some((collection) => collection.name === QMD_DERIVED_COLLECTION_NAME)) {
    issues.push('qmd workspace-derived collection is missing from runtime status.');
  }

  if (!derivedDocxIndexing.enabled) {
    issues.push('Derived DOCX indexing is disabled.');
  } else if (!derivedDocxIndexing.lastRunAt) {
    issues.push('Derived DOCX indexing has not produced a status file yet.');
  } else if (!derivedDocxIndexing.healthy) {
    issues.push('Derived DOCX indexing completed with errors.');
  }

  return {
    enabled: true,
    ready: issues.length === 0,
    binaryAvailable,
    defaultMode: runtimeStatus?.defaultMode || QMD_DEFAULT_MODE,
    allowExpensiveQueryMode: loadedPiConfig.qmd?.allowExpensiveQueryMode === true,
    collections,
    lastUpdateAt: runtimeStatus?.lastUpdateAt || null,
    lastUpdateSuccess: runtimeStatus?.lastUpdateSuccess === true,
    lastEmbedAt: runtimeStatus?.lastEmbedAt || null,
    derivedDocxIndexing,
    issues,
  };
}
