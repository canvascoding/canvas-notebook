import type { PublicShareDto, PublicShareStatus } from '@/app/lib/public-sharing/public-file-shares';
import { isToolAppRecord } from './types';

export type PublicShareAppData = {
  id: string; fileName: string; workspacePath: string; workspaceId: string;
  status: PublicShareStatus; expiresAt: string | null; publicUrl: string | null;
  accessCount: number; passwordEnabled: boolean;
};

/** No raw token, policy secrets, creator identity or publication reason in the app. */
export function presentPublicShareAppData(share: PublicShareDto, workspaceId: string): PublicShareAppData {
  const data = readPublicShareAppData({ id: share.id, fileName: share.fileName, workspacePath: share.workspacePath,
    workspaceId, status: share.status, expiresAt: share.expiresAt,
    publicUrl: share.status === 'active' ? share.shortUrl || share.publicUrl : null,
    accessCount: share.accessCount, passwordEnabled: share.passwordEnabled });
  if (!data) throw new Error('Public share widget data is unavailable.');
  return data;
}

export function readPublicShareAppData(value: unknown): PublicShareAppData | null {
  if (!isToolAppRecord(value) || typeof value.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.id)
    || typeof value.fileName !== 'string' || value.fileName.length > 512
    || typeof value.workspacePath !== 'string' || value.workspacePath.length > 4096
    || typeof value.workspaceId !== 'string' || !value.workspaceId || value.workspaceId.length > 200
    || !['active', 'expired', 'revoked', 'missing', 'stale'].includes(String(value.status))
    || (value.expiresAt !== null && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))))
    || !Number.isSafeInteger(value.accessCount) || Number(value.accessCount) < 0
    || typeof value.passwordEnabled !== 'boolean') return null;
  let publicUrl: string | null = null;
  if (value.status === 'active') {
    if (typeof value.publicUrl !== 'string' || value.publicUrl.length > 8192) return null;
    try {
      const url = new URL(value.publicUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || !/^\/(?:p\/[A-Za-z0-9]+|public\/files\/[A-Za-z0-9_-]+\/[^/]+)$/u.test(url.pathname)) return null;
      publicUrl = url.href;
    } catch { return null; }
  }
  return { id: value.id, fileName: value.fileName, workspacePath: value.workspacePath, workspaceId: value.workspaceId,
    status: value.status as PublicShareStatus, expiresAt: value.expiresAt as string | null, publicUrl,
    accessCount: Number(value.accessCount), passwordEnabled: value.passwordEnabled };
}
