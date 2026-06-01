import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { publicFileShares } from '@/app/lib/db/schema';
import { resolveExistingWorkspacePath, validatePath } from '@/app/lib/filesystem/workspace-files';

export type PublicShareStatus = 'active' | 'revoked' | 'missing' | 'stale' | 'expired';
export type PublicShareSource = 'ui' | 'agent';
export type PublicShareTypeFilter = 'all' | 'image' | 'html' | 'pdf' | 'media' | 'other';

export interface PublicShareDto {
  id: string;
  workspacePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: PublicShareStatus;
  source: PublicShareSource;
  createdByUserId: string;
  createdByAgentId: string | null;
  sourceSessionId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  publicUrl: string;
  publicPath: string;
}

export interface PublicShareAnnotation {
  id: string;
  status: PublicShareStatus;
  publicUrl: string;
  expiresAt: string | null;
  accessCount: number;
}

type PublicShareRow = typeof publicFileShares.$inferSelect;

interface WorkspaceFileDetails {
  workspacePath: string;
  fullPath: string;
  fileName: string;
  fileIdentity: string;
  mimeType: string;
  sizeBytes: number;
  stats: Stats;
}

const TOKEN_BYTES = 32;
const DEFAULT_SHARE_LIMIT = 500;

const MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json; charset=utf-8',
  m4a: 'audio/mp4',
  md: 'text/markdown; charset=utf-8',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
};

const FORCED_ATTACHMENT_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'svg',
  'xml',
  'wasm',
]);

const BLOCKED_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'canvas-integrations.env',
  'canvas-agents.env',
  'sqlite.db',
  'database.sqlite',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const BLOCKED_EXTENSIONS = new Set([
  '.db',
  '.sqlite',
  '.sqlite3',
  '.key',
  '.pem',
  '.p12',
  '.pfx',
  '.crt',
  '.cer',
]);

function getRuntimeCwd(): string {
  return Reflect.apply(process.cwd, process, []) as string;
}

function getDataDir(): string {
  const configuredDataDir = process.env.DATA?.trim();
  if (!configuredDataDir || configuredDataDir === './data' || configuredDataDir === 'data') {
    return path.join(getRuntimeCwd(), 'data');
  }
  return path.isAbsolute(configuredDataDir)
    ? configuredDataDir
    : path.join(getRuntimeCwd(), 'data');
}

function workspaceBaseDir(): string {
  return path.resolve(getDataDir(), 'workspace');
}

function isPathWithin(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedBase = path.resolve(basePath);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

function normalizeWorkspacePath(input: string): string {
  const raw = input.trim().replace(/\0/g, '').replace(/\\/g, '/');
  if (!raw || raw === '.' || raw === '/') {
    throw new Error('A concrete file path is required.');
  }

  if (raw === '/data/workspace' || raw.startsWith('/data/workspace/')) {
    const containerRelative = raw.slice('/data/workspace'.length).replace(/^\/+/, '');
    if (!containerRelative) throw new Error('A concrete file path is required.');
    return normalizeWorkspacePath(containerRelative);
  }

  const base = workspaceBaseDir();
  if (path.isAbsolute(raw)) {
    const resolved = path.resolve(raw);
    if (!isPathWithin(resolved, base)) {
      throw new Error('Public shares are restricted to workspace files.');
    }
    const relative = path.relative(base, resolved).split(path.sep).join('/');
    if (!relative || relative === '.') throw new Error('A concrete file path is required.');
    return relative;
  }

  const validated = validatePath(raw);
  const relative = path.relative(base, validated).split(path.sep).join('/');
  if (!relative || relative === '.' || relative.startsWith('..')) {
    throw new Error('Invalid workspace path.');
  }
  return relative;
}

function fileIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[extension] || 'application/octet-stream';
}

function isSensitiveWorkspacePath(workspacePath: string): boolean {
  const segments = workspacePath.split('/').map((segment) => segment.toLowerCase());
  const baseName = segments[segments.length - 1] || '';
  const ext = path.extname(baseName);

  if (baseName.startsWith('.env') || baseName.endsWith('.env')) return true;
  if (BLOCKED_FILE_NAMES.has(baseName)) return true;
  if (BLOCKED_EXTENSIONS.has(ext)) return true;
  return segments.some((segment) => (
    segment === '.ssh' ||
    segment === 'secrets' ||
    segment === '.secrets' ||
    segment === 'credentials' ||
    segment === '.credentials'
  ));
}

async function getWorkspaceFileDetails(inputPath: string): Promise<WorkspaceFileDetails> {
  const workspacePath = normalizeWorkspacePath(inputPath);
  if (isSensitiveWorkspacePath(workspacePath)) {
    throw new Error('This file path is blocked from public sharing because it looks sensitive.');
  }

  const fullPath = await resolveExistingWorkspacePath(workspacePath);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) {
    throw new Error('Only files can be shared publicly. Folder sharing is disabled.');
  }

  return {
    workspacePath,
    fullPath,
    fileName: path.posix.basename(workspacePath),
    fileIdentity: fileIdentity(stats),
    mimeType: getMimeType(workspacePath),
    sizeBytes: stats.size,
    stats,
  };
}

function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toDateOrNull(value: Date | number | string | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value: Date | number | string | null): string | null {
  return toDateOrNull(value)?.toISOString() ?? null;
}

function safeStatus(value: string): PublicShareStatus {
  if (value === 'active' || value === 'revoked' || value === 'missing' || value === 'stale' || value === 'expired') {
    return value;
  }
  return 'revoked';
}

function publicFilePath(row: PublicShareRow): string {
  return `/public/files/${encodeURIComponent(row.token)}/${encodeURIComponent(row.fileName)}`;
}

export function buildPublicFileUrl(row: PublicShareRow, baseUrl?: string | null): string {
  const relative = publicFilePath(row);
  if (!baseUrl) return relative;
  return `${baseUrl.replace(/\/+$/, '')}${relative}`;
}

function toDto(row: PublicShareRow, baseUrl?: string | null): PublicShareDto {
  return {
    id: row.id,
    workspacePath: row.workspacePath,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: safeStatus(row.status),
    source: row.source === 'agent' ? 'agent' : 'ui',
    createdByUserId: row.createdByUserId,
    createdByAgentId: row.createdByAgentId,
    sourceSessionId: row.sourceSessionId,
    reason: row.reason,
    createdAt: toIso(row.createdAt) || new Date().toISOString(),
    updatedAt: toIso(row.updatedAt) || new Date().toISOString(),
    expiresAt: toIso(row.expiresAt),
    revokedAt: toIso(row.revokedAt),
    lastAccessedAt: toIso(row.lastAccessedAt),
    accessCount: row.accessCount,
    publicUrl: buildPublicFileUrl(row, baseUrl),
    publicPath: publicFilePath(row),
  };
}

async function updateShare(row: PublicShareRow, values: Partial<typeof publicFileShares.$inferInsert>): Promise<PublicShareRow> {
  const updatedAt = new Date();
  await db.update(publicFileShares)
    .set({ ...values, updatedAt })
    .where(eq(publicFileShares.id, row.id));
  const [updated] = await db.select().from(publicFileShares).where(eq(publicFileShares.id, row.id)).limit(1);
  return updated || { ...row, ...values, updatedAt } as PublicShareRow;
}

async function reconcileRow(row: PublicShareRow): Promise<PublicShareRow> {
  if (row.status !== 'active') return row;

  const expiresAt = toDateOrNull(row.expiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return updateShare(row, { status: 'expired', revokedAt: new Date() });
  }

  let details: WorkspaceFileDetails;
  try {
    details = await getWorkspaceFileDetails(row.workspacePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.includes('blocked') ? 'stale' : 'missing';
    return updateShare(row, { status });
  }

  if (details.fileIdentity !== row.fileIdentity) {
    return updateShare(row, {
      status: 'stale',
      mimeType: details.mimeType,
      sizeBytes: details.sizeBytes,
      fileName: details.fileName,
    });
  }

  if (details.mimeType !== row.mimeType || details.sizeBytes !== row.sizeBytes || details.fileName !== row.fileName) {
    return updateShare(row, {
      mimeType: details.mimeType,
      sizeBytes: details.sizeBytes,
      fileName: details.fileName,
    });
  }

  return row;
}

export async function createPublicFileShares(params: {
  paths: string[];
  createdByUserId: string;
  source?: PublicShareSource;
  createdByAgentId?: string | null;
  sourceSessionId?: string | null;
  expiresAt?: Date | null;
  reason?: string | null;
  confirmPublicExposure?: boolean;
  baseUrl?: string | null;
}): Promise<{
  shares: PublicShareDto[];
  skipped: Array<{ path: string; reason: string }>;
}> {
  if (params.source === 'agent' && params.confirmPublicExposure !== true) {
    throw new Error('Agent-created public shares require confirmPublicExposure=true.');
  }

  const uniquePaths = Array.from(new Set(params.paths.map((candidate) => candidate.trim()).filter(Boolean)));
  if (uniquePaths.length === 0) {
    throw new Error('At least one file path is required.');
  }

  const shares: PublicShareDto[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const requestedPath of uniquePaths) {
    try {
      const details = await getWorkspaceFileDetails(requestedPath);
      const existingRows = await db.select()
        .from(publicFileShares)
        .where(and(
          eq(publicFileShares.workspacePath, details.workspacePath),
          eq(publicFileShares.status, 'active'),
        ));

      const reconciledExistingRows = await Promise.all(existingRows.map(reconcileRow));
      const existing = reconciledExistingRows.find((row) => row.status === 'active' && row.fileIdentity === details.fileIdentity);
      if (existing) {
        shares.push(toDto(await reconcileRow(existing), params.baseUrl));
        continue;
      }

      const token = createToken();
      const now = new Date();
      const [inserted] = await db.insert(publicFileShares)
        .values({
          id: randomUUID(),
          token,
          tokenHash: tokenHash(token),
          tokenPreview: token.slice(0, 8),
          workspacePath: details.workspacePath,
          fileName: details.fileName,
          fileIdentity: details.fileIdentity,
          mimeType: details.mimeType,
          sizeBytes: details.sizeBytes,
          status: 'active',
          createdByUserId: params.createdByUserId,
          createdByAgentId: params.createdByAgentId ?? null,
          sourceSessionId: params.sourceSessionId ?? null,
          source: params.source ?? 'ui',
          reason: params.reason?.trim().slice(0, 500) || null,
          createdAt: now,
          updatedAt: now,
          expiresAt: params.expiresAt ?? null,
          revokedAt: null,
          lastAccessedAt: null,
          accessCount: 0,
        })
        .returning();

      shares.push(toDto(inserted, params.baseUrl));
    } catch (error) {
      skipped.push({
        path: requestedPath,
        reason: error instanceof Error ? error.message : 'Failed to create public share.',
      });
    }
  }

  return { shares, skipped };
}

export async function revokePublicFileShare(params: {
  id: string;
  userId: string;
  isAdmin?: boolean;
  baseUrl?: string | null;
}): Promise<PublicShareDto | null> {
  const [row] = await db.select().from(publicFileShares).where(eq(publicFileShares.id, params.id)).limit(1);
  if (!row) return null;
  if (!params.isAdmin && row.createdByUserId !== params.userId) {
    throw new Error('Forbidden');
  }

  const updated = await updateShare(row, { status: 'revoked', revokedAt: new Date() });
  return toDto(updated, params.baseUrl);
}

function matchesTypeFilter(row: PublicShareRow, type: PublicShareTypeFilter): boolean {
  if (type === 'all') return true;
  const mime = row.mimeType.toLowerCase();
  if (type === 'image') return mime.startsWith('image/');
  if (type === 'html') return mime.includes('text/html');
  if (type === 'pdf') return mime === 'application/pdf';
  if (type === 'media') return mime.startsWith('video/') || mime.startsWith('audio/');
  return !mime.startsWith('image/') && !mime.startsWith('video/') && !mime.startsWith('audio/') && mime !== 'application/pdf' && !mime.includes('text/html');
}

export async function listPublicFileShares(params: {
  userId: string;
  isAdmin?: boolean;
  status?: PublicShareStatus | 'all';
  type?: PublicShareTypeFilter;
  query?: string;
  paths?: string[];
  source?: PublicShareSource | 'all';
  limit?: number;
  baseUrl?: string | null;
}): Promise<PublicShareDto[]> {
  const rows = await db.select().from(publicFileShares).orderBy(desc(publicFileShares.createdAt));
  const reconciled = await Promise.all(rows.map(reconcileRow));
  const query = params.query?.trim().toLowerCase() || '';
  const type = params.type ?? 'all';
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_SHARE_LIMIT, 1000));
  const pathFilter = new Set(
    (params.paths ?? []).map((candidate) => {
      try {
        return normalizeWorkspacePath(candidate);
      } catch {
        return null;
      }
    }).filter((candidate): candidate is string => Boolean(candidate))
  );

  return reconciled
    .filter((row) => params.isAdmin || row.createdByUserId === params.userId)
    .filter((row) => pathFilter.size === 0 || pathFilter.has(row.workspacePath))
    .filter((row) => !params.status || params.status === 'all' || row.status === params.status)
    .filter((row) => !params.source || params.source === 'all' || row.source === params.source)
    .filter((row) => matchesTypeFilter(row, type))
    .filter((row) => !query || `${row.workspacePath} ${row.fileName}`.toLowerCase().includes(query))
    .slice(0, limit)
    .map((row) => toDto(row, params.baseUrl));
}

export async function getPublicShareAnnotations(paths: string[], baseUrl?: string | null): Promise<Map<string, PublicShareAnnotation>> {
  const normalizedTargets = new Set<string>();
  for (const candidate of paths) {
    try {
      normalizedTargets.add(normalizeWorkspacePath(candidate));
    } catch {
      // Ignore invalid browser entries; the file APIs will report their own errors.
    }
  }

  if (normalizedTargets.size === 0) return new Map();

  const rows = await db.select().from(publicFileShares).where(eq(publicFileShares.status, 'active'));
  const result = new Map<string, PublicShareAnnotation>();
  for (const row of rows) {
    if (!normalizedTargets.has(row.workspacePath)) continue;
    const reconciled = await reconcileRow(row);
    if (reconciled.status !== 'active') continue;
    result.set(reconciled.workspacePath, {
      id: reconciled.id,
      status: 'active',
      publicUrl: buildPublicFileUrl(reconciled, baseUrl),
      expiresAt: toIso(reconciled.expiresAt),
      accessCount: reconciled.accessCount,
    });
  }
  return result;
}

function affectedByPath(rowPath: string, targetPath: string): boolean {
  return rowPath === targetPath || rowPath.startsWith(`${targetPath}/`);
}

export async function syncPublicSharesAfterDelete(paths: string[]): Promise<void> {
  const normalized = paths.map((candidate) => {
    try {
      return normalizeWorkspacePath(candidate);
    } catch {
      return null;
    }
  }).filter((candidate): candidate is string => Boolean(candidate));

  if (normalized.length === 0) return;

  const rows = await db.select().from(publicFileShares).where(eq(publicFileShares.status, 'active'));
  await Promise.all(rows.map(async (row) => {
    if (!normalized.some((targetPath) => affectedByPath(row.workspacePath, targetPath))) return;
    await updateShare(row, { status: 'missing' });
  }));
}

export async function syncPublicSharesAfterWrite(paths: string[]): Promise<void> {
  const normalized = paths.map((candidate) => {
    try {
      return normalizeWorkspacePath(candidate);
    } catch {
      return null;
    }
  }).filter((candidate): candidate is string => Boolean(candidate));

  if (normalized.length === 0) return;

  const rows = await db.select().from(publicFileShares).where(eq(publicFileShares.status, 'active'));
  await Promise.all(rows
    .filter((row) => normalized.includes(row.workspacePath))
    .map(reconcileRow));
}

function remapWorkspacePath(rowPath: string, oldPath: string, newPath: string): string {
  if (rowPath === oldPath) return newPath;
  return `${newPath}/${rowPath.slice(oldPath.length + 1)}`;
}

export async function syncPublicSharesAfterMove(oldPath: string, newPath: string): Promise<void> {
  let normalizedOld: string;
  let normalizedNew: string;
  try {
    normalizedOld = normalizeWorkspacePath(oldPath);
    normalizedNew = normalizeWorkspacePath(newPath);
  } catch {
    return;
  }

  const rows = await db.select().from(publicFileShares).where(eq(publicFileShares.status, 'active'));
  for (const row of rows) {
    if (!affectedByPath(row.workspacePath, normalizedOld)) continue;
    const nextWorkspacePath = remapWorkspacePath(row.workspacePath, normalizedOld, normalizedNew);
    await updateShare(row, {
      workspacePath: nextWorkspacePath,
      fileName: path.posix.basename(nextWorkspacePath),
    });
  }

  const affectedRows = await db.select().from(publicFileShares).where(eq(publicFileShares.status, 'active'));
  await Promise.all(
    affectedRows
      .filter((row) => affectedByPath(row.workspacePath, normalizedNew))
      .map(reconcileRow)
  );
}

export async function resolvePublicShareToken(token: string): Promise<{
  ok: true;
  share: PublicShareDto;
  row: PublicShareRow;
  workspacePath: string;
  fullPath: string;
  sizeBytes: number;
  mimeType: string;
} | {
  ok: false;
  status: number;
  error: string;
}> {
  const normalizedToken = token.trim();
  if (!/^[A-Za-z0-9_-]{20,160}$/.test(normalizedToken)) {
    return { ok: false, status: 404, error: 'Public file not found.' };
  }

  const [row] = await db.select()
    .from(publicFileShares)
    .where(eq(publicFileShares.tokenHash, tokenHash(normalizedToken)))
    .limit(1);

  if (!row) {
    return { ok: false, status: 404, error: 'Public file not found.' };
  }

  const reconciled = await reconcileRow(row);
  if (reconciled.status !== 'active') {
    return {
      ok: false,
      status: reconciled.status === 'expired' || reconciled.status === 'revoked' ? 410 : 404,
      error: `Public file is ${reconciled.status}.`,
    };
  }

  const details = await getWorkspaceFileDetails(reconciled.workspacePath);
  if (details.fileIdentity !== reconciled.fileIdentity) {
    await updateShare(reconciled, { status: 'stale' });
    return { ok: false, status: 404, error: 'Public file is no longer the same file.' };
  }

  await updateShare(reconciled, {
    lastAccessedAt: new Date(),
    accessCount: reconciled.accessCount + 1,
    mimeType: details.mimeType,
    sizeBytes: details.sizeBytes,
    fileName: details.fileName,
  });

  return {
    ok: true,
    share: toDto({ ...reconciled, ...details, sizeBytes: details.sizeBytes } as PublicShareRow),
    row: reconciled,
    workspacePath: details.workspacePath,
    fullPath: details.fullPath,
    sizeBytes: details.sizeBytes,
    mimeType: details.mimeType,
  };
}

function quotedFileName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}

export function createPublicFileHeaders(params: {
  fileName: string;
  workspacePath: string;
  mimeType: string;
  sizeBytes?: number;
  range?: { start: number; end: number; total: number };
}): Headers {
  const ext = path.extname(params.workspacePath).slice(1).toLowerCase();
  const isHtml = params.mimeType.toLowerCase().includes('text/html');
  const forceAttachment = FORCED_ATTACHMENT_EXTENSIONS.has(ext);
  const headers = new Headers({
    'Content-Type': params.mimeType,
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=60, must-revalidate',
  });

  if (params.range) {
    const length = params.range.end - params.range.start + 1;
    headers.set('Content-Range', `bytes ${params.range.start}-${params.range.end}/${params.range.total}`);
    headers.set('Content-Length', length.toString());
  } else if (typeof params.sizeBytes === 'number') {
    headers.set('Content-Length', params.sizeBytes.toString());
  }

  if (isHtml) {
    headers.set(
      'Content-Security-Policy',
      [
        'sandbox',
        "default-src 'none'",
        "script-src 'none'",
        "connect-src 'none'",
        "img-src data: blob:",
        "media-src data: blob:",
        "style-src 'unsafe-inline'",
        "font-src data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
  } else {
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none';"
    );
  }

  if (forceAttachment) {
    headers.set('Content-Disposition', `attachment; filename="${quotedFileName(params.fileName)}"`);
  } else {
    headers.set('Content-Disposition', `inline; filename="${quotedFileName(params.fileName)}"`);
  }

  return headers;
}
