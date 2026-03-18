import path from 'node:path';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

export const QMD_CANONICAL_TOOL_NAME = 'qmd';
export const QMD_LEGACY_TOOL_NAME = 'qmd_search';

export const QMD_DEFAULT_MODE = 'search' as const;
export const QMD_ALLOWED_MODES = ['search', 'vsearch', 'query'] as const;

export type QmdSearchMode = (typeof QMD_ALLOWED_MODES)[number];

export const QMD_TEXT_COLLECTION_NAME = 'workspace-text';
export const QMD_DERIVED_COLLECTION_NAME = 'workspace-derived';
export const QMD_DEFAULT_COLLECTIONS = [QMD_TEXT_COLLECTION_NAME, QMD_DERIVED_COLLECTION_NAME] as const;

export const QMD_TEXT_COLLECTION_MASK =
  '**/*.{md,mdx,txt,text,json,jsonl,csv,xml,ts,tsx,js,jsx,mjs,cjs,py,html,css,scss,sql,yaml,yml}';
export const QMD_DERIVED_COLLECTION_MASK = '**/*.md';

export const QMD_RUNTIME_STATUS_FILE = 'runtime-status.json';
export const QMD_DERIVED_STATUS_FILE = 'status.json';

export type QmdSourceType = 'workspace-text' | 'workspace-derived';

export type QmdSearchResult = {
  docid: string;
  score: number | null;
  file: string;
  title: string | null;
  context: string | null;
  snippet: string | null;
  body: string | null;
  collection: string;
  originalPath: string;
  displayPath: string;
  sourceType: QmdSourceType;
};

type QmdJsonResult = {
  docid?: string;
  score?: number;
  file?: string;
  title?: string;
  context?: string;
  snippet?: string;
  body?: string;
};

export function getQmdCacheRoot(cwd = process.cwd()): string {
  return path.join(resolveCanvasDataRoot(cwd), 'cache', 'qmd');
}

export function getQmdDerivedRoot(cwd = process.cwd()): string {
  return path.join(getQmdCacheRoot(cwd), 'derived');
}

export function getQmdDerivedDocxRoot(cwd = process.cwd()): string {
  return path.join(getQmdDerivedRoot(cwd), 'docx');
}

export function getQmdRuntimeStatusPath(cwd = process.cwd()): string {
  return path.join(getQmdCacheRoot(cwd), QMD_RUNTIME_STATUS_FILE);
}

export function getQmdDerivedStatusPath(cwd = process.cwd()): string {
  return path.join(getQmdDerivedRoot(cwd), QMD_DERIVED_STATUS_FILE);
}

export function getQmdShellExports(): string {
  return 'export BUN_INSTALL="${BUN_INSTALL:-/data/cache/.bun}" && export PATH="$BUN_INSTALL/bin:$PATH"';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractFirstJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as unknown[];
  }

  const start = trimmed.indexOf('[');
  if (start === -1) {
    throw new Error('qmd did not return JSON results.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, index + 1)) as unknown[];
      }
    }
  }

  throw new Error('qmd returned malformed JSON results.');
}

export function normalizeQmdMode(value: unknown): QmdSearchMode {
  if (typeof value !== 'string') {
    return QMD_DEFAULT_MODE;
  }

  const normalized = value.trim();
  if ((QMD_ALLOWED_MODES as readonly string[]).includes(normalized)) {
    return normalized as QmdSearchMode;
  }

  throw new Error(`Invalid qmd mode "${value}". Allowed values: ${QMD_ALLOWED_MODES.join(', ')}`);
}

export function normalizeQmdCollections(value: unknown): string[] {
  if (Array.isArray(value)) {
    const values = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return values.length > 0 ? Array.from(new Set(values)) : [...QMD_DEFAULT_COLLECTIONS];
  }

  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }

  return [...QMD_DEFAULT_COLLECTIONS];
}

export function mapQmdFileToOriginalPath(file: string, collection: string): {
  originalPath: string;
  displayPath: string;
  sourceType: QmdSourceType;
} {
  if (collection === QMD_DERIVED_COLLECTION_NAME && file.endsWith('.docx.md')) {
    const originalPath = file.slice(0, -3);
    return {
      originalPath,
      displayPath: originalPath,
      sourceType: 'workspace-derived',
    };
  }

  return {
    originalPath: file,
    displayPath: file,
    sourceType: 'workspace-text',
  };
}

export function normalizeQmdResults(payload: unknown, collection: string): QmdSearchResult[] {
  if (!Array.isArray(payload)) {
    throw new Error('qmd JSON response was not an array.');
  }

  const results: QmdSearchResult[] = [];

  for (const entry of payload) {
    if (!isObject(entry)) {
      continue;
    }

    const raw = entry as QmdJsonResult;
    if (!raw.file || typeof raw.file !== 'string') {
      continue;
    }

    const mapped = mapQmdFileToOriginalPath(raw.file, collection);

    results.push({
      docid: typeof raw.docid === 'string' ? raw.docid : '',
      score: typeof raw.score === 'number' ? raw.score : null,
      file: raw.file,
      title: typeof raw.title === 'string' ? raw.title : null,
      context: typeof raw.context === 'string' ? raw.context : null,
      snippet: typeof raw.snippet === 'string' ? raw.snippet : null,
      body: typeof raw.body === 'string' ? raw.body : null,
      collection,
      originalPath: mapped.originalPath,
      displayPath: mapped.displayPath,
      sourceType: mapped.sourceType,
    });
  }

  return results;
}

export function mergeQmdResults(results: QmdSearchResult[]): QmdSearchResult[] {
  const deduped = new Map<string, QmdSearchResult>();

  for (const result of results) {
    const existing = deduped.get(result.originalPath);
    if (!existing || (result.score ?? 0) > (existing.score ?? 0)) {
      deduped.set(result.originalPath, result);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}

export function formatQmdSearchSummary(results: QmdSearchResult[], mode: QmdSearchMode): string {
  if (results.length === 0) {
    return `No qmd results found using mode "${mode}".`;
  }

  return results
    .map((result, index) => {
      const header = `${index + 1}. ${result.displayPath}`;
      const detailParts = [
        `collection=${result.collection}`,
        `source=${result.sourceType}`,
        result.score !== null ? `score=${Math.round(result.score * 100) / 100}` : null,
      ].filter(Boolean);
      const snippet = result.snippet || result.body || '(no snippet available)';
      return `${header}\n${detailParts.join(' | ')}\n${snippet}`;
    })
    .join('\n\n');
}
