import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { publicFileShares } from '@/app/lib/db/schema';
import { resolveExistingWorkspacePath, validatePath } from '@/app/lib/filesystem/workspace-files';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import {
  INTERACTIVE_PUBLIC_HTML_CSP,
  isHtmlWorkspacePath,
  normalizePublicShareSecurityMode,
  PUBLIC_SHARE_ASSET_CSP,
  STRICT_PUBLIC_HTML_CSP,
  type PublicShareSecurityMode,
} from '@/app/lib/public-sharing/public-share-security';
import {
  LEGACY_PERSONAL_WORKSPACE_ID,
  createLegacyPersonalWorkspaceContext,
} from '@/app/lib/workspaces/context';
import { resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/service';
import type { WorkspaceContext, WorkspaceType } from '@/app/lib/workspaces/types';

export type PublicShareStatus = 'active' | 'revoked' | 'missing' | 'stale' | 'expired';
export type PublicShareSource = 'ui' | 'agent';
export type PublicShareTypeFilter = 'all' | 'image' | 'html' | 'pdf' | 'media' | 'other';

export interface PublicShareDto {
  id: string;
  organizationId: string | null;
  workspaceId: string | null;
  workspaceType: WorkspaceType | null;
  workspaceName: string | null;
  workspacePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: PublicShareStatus;
  targetRevisionPolicy: 'latest' | 'fixed';
  lastKnownRevision: string | null;
  passwordEnabled: boolean;
  source: PublicShareSource;
  securityMode: PublicShareSecurityMode;
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
  shortCode: string | null;
  shortUrl: string;
  shortPath: string;
  publicUrl: string;
  publicPath: string;
}

export interface PublicShareAnnotation {
  id: string;
  status: PublicShareStatus;
  workspaceId: string | null;
  shortUrl: string;
  publicUrl: string;
  securityMode: PublicShareSecurityMode;
  expiresAt: string | null;
  accessCount: number;
}

export type PublicShareRow = typeof publicFileShares.$inferSelect;

export type PublicShareResolution = {
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
};

interface ResolvePublicShareOptions {
  recordAccess?: boolean;
}

interface WorkspaceFileDetails {
  workspacePath: string;
  fullPath: string;
  fileName: string;
  fileIdentity: string;
  lastKnownRevision: string;
  mimeType: string;
  sizeBytes: number;
  stats: Stats;
}

const TOKEN_BYTES = 32;
const SHORT_CODE_LENGTH = 6;
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const DEFAULT_SHARE_LIMIT = 500;

const MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  m4a: 'audio/mp4',
  md: 'text/markdown; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  ttf: 'font/ttf',
  wav: 'audio/wav',
  wasm: 'application/wasm',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
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

function normalizeWorkspaceType(value: string | null | undefined): WorkspaceType | null {
  if (value === 'personal' || value === 'team' || value === 'project') return value;
  return null;
}

function inferWorkspaceRootRelativePath(rootPath: string | null | undefined): string | undefined {
  if (!rootPath) return undefined;
  const dataRoot = path.resolve(getDataDir());
  const resolvedRoot = path.resolve(rootPath);
  if (!isPathWithin(resolvedRoot, dataRoot)) return undefined;
  const relative = path.relative(dataRoot, resolvedRoot).split(path.sep).join('/');
  if (!relative || relative === '.' || relative.startsWith('../')) return undefined;
  return relative;
}

function workspaceRootRelativePath(workspace?: WorkspaceContext | null): string | null {
  return workspace?.rootRelativePath ?? inferWorkspaceRootRelativePath(workspace?.rootPath) ?? null;
}

function implicitAgentWorkspace(): WorkspaceContext | undefined {
  const context = getAgentExecutionContext();
  if (!context) return undefined;

  return {
    workspaceId: context.workspaceId,
    workspaceType: context.workspaceType,
    rootPath: context.workspaceRoot,
    rootRelativePath: context.workspaceRootRelativePath ?? inferWorkspaceRootRelativePath(context.workspaceRoot),
    displayName: context.workspaceName ?? undefined,
    status: 'active',
    actor: {
      userId: context.userId,
      role: 'member',
    },
    organizationId: context.organizationId,
    ownerUserId: context.workspaceType === 'personal' ? context.userId : null,
    permissions: {
      canRead: true,
      canWrite: context.canWrite,
      canDelete: context.canWrite,
      canCreatePublicLinks: context.canShare,
      canManageWorkspace: false,
      canRunAgent: true,
    },
    legacy: context.legacy,
  };
}

function resolveOperationWorkspace(workspace?: WorkspaceContext | null): WorkspaceContext | undefined {
  return workspace ?? implicitAgentWorkspace();
}

function workspaceForRow(row: PublicShareRow): WorkspaceContext {
  const workspaceType = normalizeWorkspaceType(row.workspaceType) ?? 'personal';
  if (row.workspaceId && row.workspaceRootRelativePath) {
    return {
      workspaceId: row.workspaceId,
      workspaceType,
      rootPath: workspaceAbsoluteRoot(row.workspaceRootRelativePath),
      rootRelativePath: row.workspaceRootRelativePath,
      displayName: workspaceType === 'team' ? 'Team Workspace' : 'Personal Workspace',
      status: 'active',
      organizationId: row.organizationId,
      ownerUserId: null,
      permissions: {
        canRead: true,
        canWrite: false,
        canDelete: false,
        canCreatePublicLinks: false,
        canManageWorkspace: false,
        canRunAgent: false,
      },
      legacy: false,
    };
  }

  if (row.workspaceId && row.workspaceId !== LEGACY_PERSONAL_WORKSPACE_ID) {
    throw new Error('Public share workspace root is missing.');
  }

  return createLegacyPersonalWorkspaceContext();
}

function workspaceMatches(row: PublicShareRow, workspace?: WorkspaceContext | null): boolean {
  if (!workspace) return !row.workspaceId || row.workspaceId === LEGACY_PERSONAL_WORKSPACE_ID;
  if (workspace.legacy) return !row.workspaceId || row.workspaceId === LEGACY_PERSONAL_WORKSPACE_ID;
  return row.workspaceId === workspace.workspaceId;
}

function workspaceScopePredicate(workspace?: WorkspaceContext | null): SQL {
  if (workspace && !workspace.legacy) {
    return eq(publicFileShares.workspaceId, workspace.workspaceId);
  }
  const legacyScope = or(
    isNull(publicFileShares.workspaceId),
    eq(publicFileShares.workspaceId, LEGACY_PERSONAL_WORKSPACE_ID)
  );
  if (!legacyScope) throw new Error('Could not create public share workspace scope.');
  return legacyScope;
}

function isPathWithin(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedBase = path.resolve(basePath);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

function normalizeWorkspacePath(input: string, workspace?: WorkspaceContext | null): string {
  const raw = input.trim().replace(/\0/g, '').replace(/\\/g, '/');
  if (!raw || raw === '.' || raw === '/') {
    throw new Error('A concrete file path is required.');
  }

  if (workspace) {
    const base = path.resolve(workspace.rootPath);
    if (path.isAbsolute(raw)) {
      const resolved = path.resolve(raw);
      if (!isPathWithin(resolved, base)) {
        throw new Error('Public shares are restricted to workspace files.');
      }
      const relative = path.relative(base, resolved).split(path.sep).join('/');
      if (!relative || relative === '.') throw new Error('A concrete file path is required.');
      return relative;
    }

    return resolveWorkspacePath(workspace, raw).relativePath;
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

function latestRevision(stats: Stats): string {
  return `${Math.trunc(stats.mtimeMs)}:${stats.size}:${fileIdentity(stats)}`;
}

export function getPublicShareMimeType(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[extension] || 'application/octet-stream';
}

export function isSensitiveWorkspacePath(workspacePath: string): boolean {
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

async function getWorkspaceFileDetails(inputPath: string, workspace?: WorkspaceContext | null): Promise<WorkspaceFileDetails> {
  const workspacePath = normalizeWorkspacePath(inputPath, workspace);
  if (isSensitiveWorkspacePath(workspacePath)) {
    throw new Error('This file path is blocked from public sharing because it looks sensitive.');
  }

  const fullPath = await resolveExistingWorkspacePath(workspacePath, workspace ? { workspace } : undefined);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) {
    throw new Error('Only files can be shared publicly. Folder sharing is disabled.');
  }

  return {
    workspacePath,
    fullPath,
    fileName: path.posix.basename(workspacePath),
    fileIdentity: fileIdentity(stats),
    lastKnownRevision: latestRevision(stats),
    mimeType: getPublicShareMimeType(workspacePath),
    sizeBytes: stats.size,
    stats,
  };
}

function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function createShortCode(): string {
  const maxAcceptedByte = Math.floor(256 / SHORT_CODE_ALPHABET.length) * SHORT_CODE_ALPHABET.length;
  let code = '';
  while (code.length < SHORT_CODE_LENGTH) {
    for (const byte of randomBytes(SHORT_CODE_LENGTH * 2)) {
      if (byte >= maxAcceptedByte) continue;
      code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];
      if (code.length === SHORT_CODE_LENGTH) break;
    }
  }
  return code;
}

async function createUniqueShortCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const shortCode = createShortCode();
    const [existing] = await db.select({ id: publicFileShares.id })
      .from(publicFileShares)
      .where(eq(publicFileShares.shortCode, shortCode))
      .limit(1);
    if (!existing) return shortCode;
  }

  throw new Error('Could not allocate a unique short public URL.');
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

function shortPublicFilePath(row: PublicShareRow): string {
  return row.shortCode ? `/p/${encodeURIComponent(row.shortCode)}` : publicFilePath(row);
}

export function buildPublicFileUrl(row: PublicShareRow, baseUrl?: string | null): string {
  const relative = publicFilePath(row);
  if (!baseUrl) return relative;
  return `${baseUrl.replace(/\/+$/, '')}${relative}`;
}

export function buildShortPublicFileUrl(row: PublicShareRow, baseUrl?: string | null): string {
  const relative = shortPublicFilePath(row);
  if (!baseUrl) return relative;
  return `${baseUrl.replace(/\/+$/, '')}${relative}`;
}

function toDto(row: PublicShareRow, baseUrl?: string | null, workspaceName?: string | null): PublicShareDto {
  const workspaceType = normalizeWorkspaceType(row.workspaceType);
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    workspaceType,
    workspaceName: workspaceName ?? null,
    workspacePath: row.workspacePath,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: safeStatus(row.status),
    targetRevisionPolicy: row.targetRevisionPolicy === 'fixed' ? 'fixed' : 'latest',
    lastKnownRevision: row.lastKnownRevision,
    passwordEnabled: row.passwordEnabled === 1,
    source: row.source === 'agent' ? 'agent' : 'ui',
    securityMode: normalizePublicShareSecurityMode(row.securityMode),
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
    shortCode: row.shortCode,
    shortUrl: buildShortPublicFileUrl(row, baseUrl),
    shortPath: shortPublicFilePath(row),
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

async function ensureShortCode(row: PublicShareRow): Promise<PublicShareRow> {
  if (row.shortCode) return row;
  return updateShare(row, { shortCode: await createUniqueShortCode() });
}

async function reconcileRow(row: PublicShareRow): Promise<PublicShareRow> {
  if (row.status !== 'active') return row;

  const expiresAt = toDateOrNull(row.expiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return updateShare(row, { status: 'expired', revokedAt: new Date() });
  }

  let details: WorkspaceFileDetails;
  try {
    details = await getWorkspaceFileDetails(row.workspacePath, workspaceForRow(row));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const workspaceRootMissing = message.includes('workspace root');
    const status = message.includes('blocked') || workspaceRootMissing ? 'stale' : 'missing';
    const revokedAt = status === 'missing' ? row.revokedAt ?? new Date() : row.revokedAt;
    return updateShare(row, {
      status,
      revokedAt,
      revokedReason: status === 'missing'
        ? 'target_missing'
        : workspaceRootMissing
          ? 'workspace_root_missing'
          : 'target_blocked',
    });
  }

  if (
    details.fileIdentity !== row.fileIdentity ||
    details.lastKnownRevision !== row.lastKnownRevision ||
    details.mimeType !== row.mimeType ||
    details.sizeBytes !== row.sizeBytes ||
    details.fileName !== row.fileName
  ) {
    return updateShare(row, {
      fileIdentity: details.fileIdentity,
      lastKnownRevision: details.lastKnownRevision,
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
  workspace?: WorkspaceContext | null;
  source?: PublicShareSource;
  createdByAgentId?: string | null;
  sourceSessionId?: string | null;
  expiresAt?: Date | null;
  reason?: string | null;
  securityMode?: PublicShareSecurityMode;
  confirmPublicExposure?: boolean;
  baseUrl?: string | null;
}): Promise<{
  shares: PublicShareDto[];
  skipped: Array<{ path: string; reason: string }>;
}> {
  if (params.source === 'agent' && params.confirmPublicExposure !== true) {
    throw new Error('Agent-created public shares require confirmPublicExposure=true.');
  }

  const source = params.source ?? 'ui';
  const workspace = resolveOperationWorkspace(params.workspace);
  if (workspace && !workspace.permissions.canCreatePublicLinks) {
    throw new Error('Workspace public link permission required.');
  }

  const requestedSecurityMode = normalizePublicShareSecurityMode(params.securityMode);
  if (source !== 'ui' && requestedSecurityMode === 'interactive') {
    throw new Error('Interactive public HTML shares can only be created from the user interface.');
  }

  const uniquePaths = Array.from(new Set(params.paths.map((candidate) => candidate.trim()).filter(Boolean)));
  if (uniquePaths.length === 0) {
    throw new Error('At least one file path is required.');
  }

  const shares: PublicShareDto[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const requestedPath of uniquePaths) {
    try {
      const details = await getWorkspaceFileDetails(requestedPath, workspace);
      if (requestedSecurityMode === 'interactive' && !isHtmlWorkspacePath(details.workspacePath)) {
        throw new Error('Interactive public sharing is only available for HTML files.');
      }

      const existingRows = await db.select()
        .from(publicFileShares)
        .where(and(
          workspaceScopePredicate(workspace),
          eq(publicFileShares.workspacePath, details.workspacePath),
          eq(publicFileShares.status, 'active'),
        ));

      const reconciledExistingRows = await Promise.all(existingRows.map(reconcileRow));
      const existing = reconciledExistingRows.find((row) => row.status === 'active' && workspaceMatches(row, workspace));
      if (existing) {
        const existingSecurityMode = normalizePublicShareSecurityMode(existing.securityMode);
        const row = existingSecurityMode === requestedSecurityMode
          ? existing
          : await updateShare(existing, {
            securityMode: requestedSecurityMode,
            expiresAt: params.expiresAt ?? existing.expiresAt,
            reason: params.reason?.trim().slice(0, 500) || existing.reason,
          });
        shares.push(toDto(await ensureShortCode(await reconcileRow(row)), params.baseUrl, workspace?.displayName ?? null));
        continue;
      }

      const token = createToken();
      const shortCode = await createUniqueShortCode();
      const now = new Date();
      const [inserted] = await db.insert(publicFileShares)
        .values({
          id: randomUUID(),
          token,
          tokenHash: tokenHash(token),
          tokenPreview: token.slice(0, 8),
          shortCode,
          organizationId: workspace?.organizationId ?? null,
          workspaceId: workspace?.workspaceId ?? null,
          workspaceType: workspace?.workspaceType ?? null,
          workspaceRootRelativePath: workspaceRootRelativePath(workspace),
          workspacePath: details.workspacePath,
          fileName: details.fileName,
          fileIdentity: details.fileIdentity,
          targetRevisionPolicy: 'latest',
          lastKnownRevision: details.lastKnownRevision,
          mimeType: details.mimeType,
          sizeBytes: details.sizeBytes,
          status: 'active',
          createdByUserId: params.createdByUserId,
          createdByAgentId: params.createdByAgentId ?? null,
          sourceSessionId: params.sourceSessionId ?? null,
          source,
          securityMode: requestedSecurityMode,
          reason: params.reason?.trim().slice(0, 500) || null,
          createdAt: now,
          updatedAt: now,
          expiresAt: params.expiresAt ?? null,
          revokedAt: null,
          revokedReason: null,
          passwordEnabled: 0,
          passwordHash: null,
          lastAccessedAt: null,
          accessCount: 0,
        })
        .returning();

      shares.push(toDto(inserted, params.baseUrl, workspace?.displayName ?? null));
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
  workspace?: WorkspaceContext | null;
  isAdmin?: boolean;
  baseUrl?: string | null;
}): Promise<PublicShareDto | null> {
  const [row] = await db.select().from(publicFileShares).where(eq(publicFileShares.id, params.id)).limit(1);
  if (!row) return null;
  const workspace = resolveOperationWorkspace(params.workspace);
  const canManageWorkspaceShare = Boolean(
    workspace &&
    workspaceMatches(row, workspace) &&
    normalizeWorkspaceType(row.workspaceType) === 'team' &&
    workspace.permissions.canCreatePublicLinks
  );
  if (!params.isAdmin && row.createdByUserId !== params.userId && !canManageWorkspaceShare) {
    throw new Error('Forbidden');
  }

  const updated = await updateShare(row, { status: 'revoked', revokedAt: new Date(), revokedReason: 'manual' });
  return toDto(updated, params.baseUrl, workspace?.displayName ?? null);
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
  workspace?: WorkspaceContext | null;
  isAdmin?: boolean;
  status?: PublicShareStatus | 'all';
  type?: PublicShareTypeFilter;
  query?: string;
  paths?: string[];
  source?: PublicShareSource | 'all';
  limit?: number;
  baseUrl?: string | null;
}): Promise<PublicShareDto[]> {
  const workspace = resolveOperationWorkspace(params.workspace);
  const query = params.query?.trim().toLowerCase() || '';
  const type = params.type ?? 'all';
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_SHARE_LIMIT, 1000));
  const pathFilter = new Set(
    (params.paths ?? []).map((candidate) => {
      try {
        return normalizeWorkspacePath(candidate, workspace);
      } catch {
        return null;
      }
    }).filter((candidate): candidate is string => Boolean(candidate))
  );
  const whereParts: SQL[] = [workspaceScopePredicate(workspace)];
  if (pathFilter.size > 0) {
    whereParts.push(inArray(publicFileShares.workspacePath, Array.from(pathFilter)));
  }

  const rows = await db.select()
    .from(publicFileShares)
    .where(and(...whereParts))
    .orderBy(desc(publicFileShares.createdAt));
  const reconciled = await Promise.all(rows.map(reconcileRow));

  const visibleRows = reconciled
    .filter((row) => {
      if (workspace && !workspaceMatches(row, workspace)) return false;
      if (params.isAdmin) return true;
      if (row.createdByUserId === params.userId) return true;
      return Boolean(
        workspace &&
        normalizeWorkspaceType(row.workspaceType) === 'team' &&
        workspace.permissions.canCreatePublicLinks
      );
    })
    .filter((row) => pathFilter.size === 0 || pathFilter.has(row.workspacePath))
    .filter((row) => !params.status || params.status === 'all' || row.status === params.status)
    .filter((row) => !params.source || params.source === 'all' || row.source === params.source)
    .filter((row) => matchesTypeFilter(row, type))
    .filter((row) => !query || `${row.workspacePath} ${row.fileName} ${row.shortCode ?? ''} ${row.tokenPreview}`.toLowerCase().includes(query))
    .slice(0, limit);

  const withShortCodes = await Promise.all(visibleRows.map(ensureShortCode));
  return withShortCodes.map((row) => toDto(row, params.baseUrl, workspace?.displayName ?? null));
}

export async function getPublicShareAnnotations(
  paths: string[],
  baseUrl?: string | null,
  workspace?: WorkspaceContext | null,
): Promise<Map<string, PublicShareAnnotation>> {
  const resolvedWorkspace = resolveOperationWorkspace(workspace);
  const normalizedTargets = new Set<string>();
  for (const candidate of paths) {
    try {
      normalizedTargets.add(normalizeWorkspacePath(candidate, resolvedWorkspace));
    } catch {
      // Ignore invalid browser entries; the file APIs will report their own errors.
    }
  }

  if (normalizedTargets.size === 0) return new Map();

  const rows = await db.select()
    .from(publicFileShares)
    .where(and(
      workspaceScopePredicate(resolvedWorkspace),
      eq(publicFileShares.status, 'active'),
      inArray(publicFileShares.workspacePath, Array.from(normalizedTargets)),
    ));
  const result = new Map<string, PublicShareAnnotation>();
  for (const row of rows) {
    if (!workspaceMatches(row, resolvedWorkspace)) continue;
    if (!normalizedTargets.has(row.workspacePath)) continue;
    const reconciled = await reconcileRow(row);
    if (reconciled.status !== 'active') continue;
    const withShortCode = await ensureShortCode(reconciled);
    result.set(withShortCode.workspacePath, {
      id: withShortCode.id,
      status: 'active',
      workspaceId: withShortCode.workspaceId,
      shortUrl: buildShortPublicFileUrl(withShortCode, baseUrl),
      publicUrl: buildPublicFileUrl(withShortCode, baseUrl),
      securityMode: normalizePublicShareSecurityMode(withShortCode.securityMode),
      expiresAt: toIso(withShortCode.expiresAt),
      accessCount: withShortCode.accessCount,
    });
  }
  return result;
}

function affectedByPath(rowPath: string, targetPath: string): boolean {
  return rowPath === targetPath || rowPath.startsWith(`${targetPath}/`);
}

export async function syncPublicSharesAfterDelete(paths: string[], workspace?: WorkspaceContext | null): Promise<void> {
  const resolvedWorkspace = resolveOperationWorkspace(workspace);
  const normalized = paths.map((candidate) => {
    try {
      return normalizeWorkspacePath(candidate, resolvedWorkspace);
    } catch {
      return null;
    }
  }).filter((candidate): candidate is string => Boolean(candidate));

  if (normalized.length === 0) return;

  const rows = await db.select()
    .from(publicFileShares)
    .where(and(
      workspaceScopePredicate(resolvedWorkspace),
      eq(publicFileShares.status, 'active'),
    ));
  await Promise.all(rows.map(async (row) => {
    if (!workspaceMatches(row, resolvedWorkspace)) return;
    if (!normalized.some((targetPath) => affectedByPath(row.workspacePath, targetPath))) return;
    await updateShare(row, { status: 'missing', revokedAt: new Date(), revokedReason: 'target_deleted' });
  }));
}

export async function syncPublicSharesAfterWrite(paths: string[], workspace?: WorkspaceContext | null): Promise<void> {
  const resolvedWorkspace = resolveOperationWorkspace(workspace);
  const normalized = paths.map((candidate) => {
    try {
      return normalizeWorkspacePath(candidate, resolvedWorkspace);
    } catch {
      return null;
    }
  }).filter((candidate): candidate is string => Boolean(candidate));

  const uniquePaths = Array.from(new Set(normalized));
  if (uniquePaths.length === 0) return;

  const rows = await db.select()
    .from(publicFileShares)
    .where(and(
      workspaceScopePredicate(resolvedWorkspace),
      eq(publicFileShares.status, 'active'),
      inArray(publicFileShares.workspacePath, uniquePaths),
    ));
  await Promise.all(rows.filter((row) => workspaceMatches(row, resolvedWorkspace)).map(reconcileRow));
}

export function queuePublicSharesAfterWrite(paths: string[], workspace?: WorkspaceContext | null): void {
  const resolvedWorkspace = resolveOperationWorkspace(workspace);
  const timer = setTimeout(() => {
    syncPublicSharesAfterWrite(paths, resolvedWorkspace).catch((error) => {
      console.warn('[public-sharing] Failed to sync public shares after write:', error);
    });
  }, 0) as ReturnType<typeof setTimeout> & { unref?: () => void };
  timer.unref?.();
}

export async function syncPublicSharesAfterMove(oldPath: string, newPath: string, workspace?: WorkspaceContext | null): Promise<void> {
  const resolvedWorkspace = resolveOperationWorkspace(workspace);
  let normalizedOld: string;
  try {
    normalizedOld = normalizeWorkspacePath(oldPath, resolvedWorkspace);
    normalizeWorkspacePath(newPath, resolvedWorkspace);
  } catch {
    return;
  }

  const rows = await db.select()
    .from(publicFileShares)
    .where(and(
      workspaceScopePredicate(resolvedWorkspace),
      eq(publicFileShares.status, 'active'),
    ));
  for (const row of rows) {
    if (!workspaceMatches(row, resolvedWorkspace)) continue;
    if (!affectedByPath(row.workspacePath, normalizedOld)) continue;
    await updateShare(row, {
      status: 'revoked',
      revokedAt: new Date(),
      revokedReason: 'target_moved',
    });
  }
}

async function resolvePublicShareRow(row: PublicShareRow, options: ResolvePublicShareOptions = {}): Promise<PublicShareResolution> {
  const reconciled = await reconcileRow(row);
  if (reconciled.status !== 'active') {
    return {
      ok: false,
      status: reconciled.status === 'expired' || reconciled.status === 'revoked' ? 410 : 404,
      error: `Public file is ${reconciled.status}.`,
    };
  }

  const withShortCode = await ensureShortCode(reconciled);
  const details = await getWorkspaceFileDetails(withShortCode.workspacePath, workspaceForRow(withShortCode));

  const updated = options.recordAccess === false
    ? withShortCode
    : await updateShare(withShortCode, {
      lastAccessedAt: new Date(),
      accessCount: withShortCode.accessCount + 1,
      fileIdentity: details.fileIdentity,
      lastKnownRevision: details.lastKnownRevision,
      mimeType: details.mimeType,
      sizeBytes: details.sizeBytes,
      fileName: details.fileName,
    });

  return {
    ok: true,
    share: toDto(updated, null),
    row: updated,
    workspacePath: details.workspacePath,
    fullPath: details.fullPath,
    sizeBytes: details.sizeBytes,
    mimeType: details.mimeType,
  };
}

export async function resolvePublicShareToken(token: string, options: ResolvePublicShareOptions = {}): Promise<PublicShareResolution> {
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

  return resolvePublicShareRow(row, options);
}

export async function resolvePublicShareShortCode(shortCode: string, options: ResolvePublicShareOptions = {}): Promise<PublicShareResolution> {
  const normalizedShortCode = shortCode.trim();
  const hasValidCharacters = Array.from(normalizedShortCode).every((char) => SHORT_CODE_ALPHABET.includes(char));
  if (normalizedShortCode.length !== SHORT_CODE_LENGTH || !hasValidCharacters) {
    return { ok: false, status: 404, error: 'Public file not found.' };
  }

  const [row] = await db.select()
    .from(publicFileShares)
    .where(eq(publicFileShares.shortCode, normalizedShortCode))
    .limit(1);

  if (!row) {
    return { ok: false, status: 404, error: 'Public file not found.' };
  }

  const resolved = await resolvePublicShareRow(row, options);
  if (!resolved.ok) {
    return { ok: false, status: 404, error: 'Public file not found.' };
  }
  return resolved;
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
  securityMode?: PublicShareSecurityMode;
  asSiteAsset?: boolean;
  forceAttachment?: boolean;
}): Headers {
  const ext = path.extname(params.workspacePath).slice(1).toLowerCase();
  const isHtml = params.mimeType.toLowerCase().includes('text/html');
  const securityMode = normalizePublicShareSecurityMode(params.securityMode);
  const forceAttachment = params.forceAttachment || (FORCED_ATTACHMENT_EXTENSIONS.has(ext) && !params.asSiteAsset);
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
      securityMode === 'interactive' ? INTERACTIVE_PUBLIC_HTML_CSP : STRICT_PUBLIC_HTML_CSP
    );
  } else {
    headers.set('Content-Security-Policy', PUBLIC_SHARE_ASSET_CSP);
  }

  if (forceAttachment) {
    headers.set('Content-Disposition', `attachment; filename="${quotedFileName(params.fileName)}"`);
  } else {
    headers.set('Content-Disposition', `inline; filename="${quotedFileName(params.fileName)}"`);
  }

  return headers;
}
