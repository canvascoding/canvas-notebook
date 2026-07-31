import 'server-only';

import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getDatabaseProvider, openDb } from '@/app/lib/db';
import { resolveDataDir } from '@/app/lib/db/provider';
import type { ExcalidrawAssetMetadata } from './protocol';
import { sanitizeExcalidrawSvg } from './svg-sanitizer';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
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

function assertPostgres(): void {
  if (getDatabaseProvider() !== 'postgres') throw new Error('Excalidraw assets require Postgres.');
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
  const data = Buffer.from(match[2].replace(/\s/gu, ''), 'base64');
  if (!data.length) throw new Error('Excalidraw asset is empty.');
  return { mimeType: match[1].toLowerCase(), data };
}

export async function storeExcalidrawAsset(input: {
  workspaceId: string;
  fileId: string;
  mimeType: string;
  data: Buffer;
  version?: number;
  createdAt?: number;
}): Promise<ExcalidrawAssetMetadata> {
  assertPostgres();
  if (!SAFE_FILE_ID.test(input.fileId)) throw new Error('Invalid Excalidraw asset file id.');
  const mimeType = input.mimeType.toLowerCase().split(';', 1)[0].trim();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported Excalidraw asset MIME type: ${mimeType}.`);
  if (!input.data.length || input.data.length > MAX_ASSET_BYTES) throw new Error('Excalidraw asset exceeds the 20 MiB limit.');
  const data = validateAssetData(mimeType, input.data);
  if (!data.length || data.length > MAX_ASSET_BYTES) throw new Error('Excalidraw asset exceeds the 20 MiB limit.');
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const storageKey = path.join(workspaceStorageScope(input.workspaceId), hash);
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
    const existing = await database.get(
      'SELECT * FROM collaboration_excalidraw_assets WHERE workspace_id = ? AND file_id = ? LIMIT 1',
      [input.workspaceId, input.fileId],
    ) as AssetRow | undefined;
    if (existing && existing.content_sha256 !== hash) throw new Error('Excalidraw asset file id is already bound to different content.');
    const row = await database.get(
      `INSERT INTO collaboration_excalidraw_assets (
         workspace_id, file_id, content_sha256, mime_type, size_bytes, storage_key,
         version, status, created_at, last_referenced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)
       ON CONFLICT(workspace_id, file_id) DO UPDATE SET
         status = 'available', last_referenced_at = excluded.last_referenced_at
       RETURNING *`,
      [
        input.workspaceId,
        input.fileId,
        hash,
        mimeType,
        data.length,
        storageKey,
        input.version ?? 1,
        input.createdAt ?? now,
        now,
      ],
    ) as AssetRow | undefined;
    if (!row) throw new Error('Failed to persist Excalidraw asset metadata.');
    return mapAsset(row);
  } finally {
    await database.close();
  }
}

export async function loadExcalidrawAsset(input: { workspaceId: string; fileId: string }): Promise<{
  metadata: ExcalidrawAssetMetadata;
  data: Buffer;
} | null> {
  assertPostgres();
  if (!SAFE_FILE_ID.test(input.fileId)) return null;
  const database = await openDb();
  try {
    const row = await database.get(
      "SELECT * FROM collaboration_excalidraw_assets WHERE workspace_id = ? AND file_id = ? AND status = 'available' LIMIT 1",
      [input.workspaceId, input.fileId],
    ) as AssetRow | undefined;
    if (!row) return null;
    const data = await readFile(absoluteStoragePath(row.storage_key));
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== row.content_sha256) throw new Error('Excalidraw asset failed integrity verification.');
    await database.run(
      'UPDATE collaboration_excalidraw_assets SET last_referenced_at = ? WHERE workspace_id = ? AND file_id = ?',
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
  assertPostgres();
  if (requested.length > 2_000) throw new Error('Excalidraw scene exceeds the 2,000 asset reference limit.');
  const unique = new Map(requested.map((asset) => [asset.fileId, asset]));
  if (unique.size !== requested.length) throw new Error('Duplicate Excalidraw asset reference.');
  const database = await openDb();
  try {
    const canonical: ExcalidrawAssetMetadata[] = [];
    for (const asset of requested) {
      if (!SAFE_FILE_ID.test(asset.fileId)) throw new Error('Invalid Excalidraw asset reference.');
      const row = await database.get(
        "SELECT * FROM collaboration_excalidraw_assets WHERE workspace_id = ? AND file_id = ? AND status = 'available' LIMIT 1",
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

export async function importPortableExcalidrawAssets(input: {
  workspaceId: string;
  content: string;
}): Promise<ExcalidrawAssetMetadata[]> {
  if (!input.content.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(input.content); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const files = (parsed as { files?: unknown }).files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return [];
  const metadata: ExcalidrawAssetMetadata[] = [];
  for (const [fileId, value] of Object.entries(files as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const file = value as { dataURL?: unknown; mimeType?: unknown; version?: unknown; created?: unknown };
    if (typeof file.dataURL !== 'string') continue;
    const decoded = decodeExcalidrawDataUrl(file.dataURL);
    metadata.push(await storeExcalidrawAsset({
      workspaceId: input.workspaceId,
      fileId,
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : decoded.mimeType,
      data: decoded.data,
      version: Number.isSafeInteger(file.version) ? Number(file.version) : 1,
      createdAt: Number.isSafeInteger(file.created) ? Number(file.created) : Date.now(),
    }));
  }
  return metadata;
}
