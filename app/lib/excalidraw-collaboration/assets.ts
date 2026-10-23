import 'server-only';

import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openDb } from '@/app/lib/db';
import { resolveDataDir } from '@/app/lib/db/provider';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import type { ExcalidrawAssetMetadata } from './protocol';
import { sanitizeExcalidrawSvg } from './svg-sanitizer';
import { EXCALIDRAW_ASSET_MAX_BYTES, EXCALIDRAW_MAX_ASSET_REFERENCES, EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';

const SAFE_FILE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ALLOWED_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);

type AssetRow = {
  workspace_id: string;
  file_id: string;
  content_sha256: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  version: number;
  status: string;
  created_at: number;
  last_referenced_at: number;
};

export class ExcalidrawAssetConflictError extends Error {
  readonly code = 'EXCALIDRAW_ASSET_ID_CONFLICT';
  readonly status = 409;
  constructor() {
    super('The Excalidraw asset file ID is already bound to different content.');
    this.name = 'ExcalidrawAssetConflictError';
  }
}

function workspaceStorageScope(workspaceId: string): string {
  return crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 32);
}

function assetRoot(): string {
  return path.join(resolveDataDir(), 'collaboration-assets', 'excalidraw');
}

function absoluteStoragePath(storageKey: string): string {
  const root = assetRoot();
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid Excalidraw asset storage key.');
  return resolved;
}

function mapAsset(row: AssetRow): ExcalidrawAssetMetadata {
  return {
    fileId: row.file_id,
    contentHash: row.content_sha256,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    version: Number(row.version),
    createdAt: Number(row.created_at),
  };
}

function validateAssetData(mimeType: string, buffer: Buffer): Buffer {
  if (mimeType === 'image/png' && buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG signature does not match MIME type.');
  if (mimeType === 'image/jpeg' && !(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9)) throw new Error('JPEG signature does not match MIME type.');
  if (mimeType === 'image/gif' && !['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) throw new Error('GIF signature does not match MIME type.');
  if (mimeType === 'image/webp' && !(buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')) throw new Error('WebP signature does not match MIME type.');
  return mimeType === 'image/svg+xml' ? sanitizeExcalidrawSvg(buffer) : buffer;
}

export function decodeExcalidrawDataUrl(dataUrl: string): { mimeType: string; data: Buffer } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/u.exec(dataUrl);
  if (!match) throw new Error('Excalidraw asset must be a base64 data URL.');
  const encoded = match[2].replace(/\s/gu, '');
  if (encoded.length > Math.ceil(EXCALIDRAW_ASSET_MAX_BYTES / 3) * 4) throw new Error('Excalidraw asset exceeds the 20 MiB limit.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 === 1) throw new Error('Excalidraw asset has invalid base64 data.');
  const data = Buffer.from(encoded, 'base64');
  if (!data.length) throw new Error('Excalidraw asset is empty.');
  if (data.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) throw new Error('Excalidraw asset has invalid base64 data.');
  return { mimeType: match[1].toLowerCase(), data };
}

export type ValidatedPortableExcalidrawAsset = {
  fileId: string;
  mimeType: string;
  data: Buffer;
  contentHash: string;
  version: number;
  createdAt?: number;
};

function prepareExcalidrawAsset(input: {
  fileId: string;
  mimeType: string;
  data: Buffer;
  version?: unknown;
  createdAt?: unknown;
}): ValidatedPortableExcalidrawAsset {
  if (!SAFE_FILE_ID.test(input.fileId)) throw new Error('Invalid Excalidraw asset file id.');
  const mimeType = input.mimeType.toLowerCase().split(';', 1)[0].trim();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported Excalidraw asset MIME type: ${mimeType}.`);
  if (!input.data.length || input.data.length > EXCALIDRAW_ASSET_MAX_BYTES) throw new Error('Excalidraw asset exceeds the 20 MiB limit.');
  if (input.version !== undefined && (!Number.isSafeInteger(input.version) || Number(input.version) < 1)) throw new Error('Invalid Excalidraw asset version.');
  if (input.createdAt !== undefined && (!Number.isSafeInteger(input.createdAt) || Number(input.createdAt) < 0)) throw new Error('Invalid Excalidraw asset creation time.');
  const data = validateAssetData(mimeType, input.data);
  if (!data.length || data.length > EXCALIDRAW_ASSET_MAX_BYTES) throw new Error('Excalidraw asset exceeds the 20 MiB limit.');
  return { fileId: input.fileId, mimeType, data, version: input.version === undefined ? 1 : Number(input.version),
    createdAt: input.createdAt === undefined ? undefined : Number(input.createdAt),
    contentHash: crypto.createHash('sha256').update(data).digest('hex') };
}

async function persistExcalidrawAsset(workspaceId: string, asset: ValidatedPortableExcalidrawAsset): Promise<ExcalidrawAssetMetadata> {
  return withWorkspaceMutationLock(workspaceId, async () => {
  const { fileId, mimeType, data, contentHash: hash } = asset;
  const storageKey = path.join(workspaceStorageScope(workspaceId), hash);
  const target = absoluteStoragePath(storageKey);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      await rm(temporary, { force: true });
    });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const now = Date.now();
  const database = await openDb();
  try {
    const row = await database.get(
      `INSERT INTO collaboration_excalidraw_assets (
         workspace_id, file_id, content_sha256, mime_type, size_bytes, storage_key,
         version, status, created_at, last_referenced_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'available', $8, $9)
       ON CONFLICT(workspace_id, file_id) DO UPDATE SET
         status = 'available', last_referenced_at = excluded.last_referenced_at
       WHERE collaboration_excalidraw_assets.content_sha256 = excluded.content_sha256
       RETURNING *`,
      [
        workspaceId,
        fileId,
        hash,
        mimeType,
        data.length,
        storageKey,
        asset.version,
        asset.createdAt ?? now,
        now,
      ],
    ) as AssetRow | undefined;
    if (!row) throw new ExcalidrawAssetConflictError();
    return mapAsset(row);
  } finally {
    await database.close();
  }
  });
}

export async function storeExcalidrawAsset(input: {
  workspaceId: string;
  fileId: string;
  mimeType: string;
  data: Buffer;
  version?: number;
  createdAt?: number;
}): Promise<ExcalidrawAssetMetadata> {
  const asset = prepareExcalidrawAsset(input);
  await assertPortableExcalidrawAssetBindings(input.workspaceId, [asset]);
  return persistExcalidrawAsset(input.workspaceId, asset);
}

/** Preflight the entire validated batch before any import can publish bytes or metadata. */
export async function assertPortableExcalidrawAssetBindings(
  workspaceId: string,
  assets: readonly ValidatedPortableExcalidrawAsset[],
): Promise<void> {
  if (!assets.length) return;
  const database = await openDb();
  try {
    const existing = await database.all(`SELECT file_id, content_sha256 FROM collaboration_excalidraw_assets
      WHERE workspace_id = $1 AND file_id = ANY($2::text[])`, [workspaceId, assets.map(asset => asset.fileId)]) as Array<{
      file_id: string; content_sha256: string;
    }>;
    const hashes = new Map(assets.map(asset => [asset.fileId, asset.contentHash]));
    if (existing.some(asset => hashes.get(asset.file_id) !== asset.content_sha256)) throw new ExcalidrawAssetConflictError();
  } finally { await database.close(); }
}

export async function loadExcalidrawAsset(input: { workspaceId: string; fileId: string }): Promise<{
  metadata: ExcalidrawAssetMetadata;
  data: Buffer;
} | null> {
  if (!SAFE_FILE_ID.test(input.fileId)) return null;
  const database = await openDb();
  try {
    const row = await database.get(
      "SELECT * FROM collaboration_excalidraw_assets WHERE workspace_id = $1 AND file_id = $2 AND status = 'available' LIMIT 1",
      [input.workspaceId, input.fileId],
    ) as AssetRow | undefined;
    if (!row) return null;
    const data = await readFile(absoluteStoragePath(row.storage_key));
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== row.content_sha256) throw new Error('Excalidraw asset failed integrity verification.');
    await database.run(
      'UPDATE collaboration_excalidraw_assets SET last_referenced_at = $1 WHERE workspace_id = $2 AND file_id = $3',
      [Date.now(), input.workspaceId, input.fileId],
    );
    return { metadata: mapAsset(row), data };
  } finally {
    await database.close();
  }
}

export async function validateExcalidrawAssetMetadata(
  workspaceId: string,
  requested: ExcalidrawAssetMetadata[],
): Promise<ExcalidrawAssetMetadata[]> {
  if (requested.length > EXCALIDRAW_MAX_ASSET_REFERENCES) throw new Error('Excalidraw scene exceeds the 2,000 asset reference limit.');
  const unique = new Map(requested.map((asset) => [asset.fileId, asset]));
  if (unique.size !== requested.length) throw new Error('Duplicate Excalidraw asset reference.');
  const database = await openDb();
  try {
    const canonical: ExcalidrawAssetMetadata[] = [];
    for (const asset of requested) {
      if (!SAFE_FILE_ID.test(asset.fileId)) throw new Error('Invalid Excalidraw asset reference.');
      const row = await database.get(
        "SELECT * FROM collaboration_excalidraw_assets WHERE workspace_id = $1 AND file_id = $2 AND status = 'available' LIMIT 1",
        [workspaceId, asset.fileId],
      ) as AssetRow | undefined;
      if (!row || row.content_sha256 !== asset.contentHash) throw new Error(`Excalidraw asset is unavailable: ${asset.fileId}.`);
      canonical.push(mapAsset(row));
    }
    return canonical;
  } finally {
    await database.close();
  }
}

/** Validate the complete portable asset batch without database or filesystem writes. */
export function validatePortableExcalidrawAssets(content: string): ValidatedPortableExcalidrawAsset[] {
  if (Buffer.byteLength(content, 'utf8') > EXCALIDRAW_PORTABLE_MAX_BYTES) throw Object.assign(
    new Error('Excalidraw collaboration supports portable files up to 50 MiB.'),
    { code: 'EXCALIDRAW_SCENE_TOO_LARGE', status: 413 });
  if (!content.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('The Excalidraw file is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The Excalidraw file has an invalid root object.');
  const files = (parsed as { files?: unknown }).files;
  if (files === undefined) return [];
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('The Excalidraw files map is invalid.');
  if (Object.keys(files).length > EXCALIDRAW_MAX_ASSET_REFERENCES) throw new Error('Excalidraw scene exceeds the 2,000 asset reference limit.');
  const assets: ValidatedPortableExcalidrawAsset[] = [];
  for (const [fileId, value] of Object.entries(files as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Excalidraw asset: ${fileId}.`);
    const file = value as { id?: unknown; dataURL?: unknown; mimeType?: unknown; version?: unknown; created?: unknown };
    if (file.id !== undefined && file.id !== fileId) throw new Error('Excalidraw asset ID does not match its files map key.');
    if (typeof file.dataURL !== 'string') throw new Error(`Excalidraw asset data is missing: ${fileId}.`);
    const decoded = decodeExcalidrawDataUrl(file.dataURL);
    if (file.mimeType !== undefined && (typeof file.mimeType !== 'string'
      || file.mimeType.toLowerCase().split(';', 1)[0].trim() !== decoded.mimeType)) throw new Error('Excalidraw asset MIME type does not match its data URL.');
    assets.push(prepareExcalidrawAsset({
      fileId,
      mimeType: decoded.mimeType,
      data: decoded.data,
      version: file.version,
      createdAt: file.created,
    }));
  }
  return assets;
}

export async function importPortableExcalidrawAssets(input: {
  workspaceId: string;
  content: string;
}): Promise<ExcalidrawAssetMetadata[]> {
  const assets = validatePortableExcalidrawAssets(input.content);
  await assertPortableExcalidrawAssetBindings(input.workspaceId, assets);
  const metadata: ExcalidrawAssetMetadata[] = [];
  for (const asset of assets) metadata.push(await persistExcalidrawAsset(input.workspaceId, asset));
  return metadata;
}
