import { openDb } from '@/app/lib/db';

export interface UploadAccessGrant {
  fileId: string;
  ownerUserId: string;
  workspaceId: string | null;
  storagePath: string;
  originalName: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  createdAt: number;
}

type UploadAccessRow = {
  file_id: string;
  owner_user_id: string;
  workspace_id: string | null;
  storage_path: string;
  original_name: string;
  mime_type: string;
  category: string;
  size_bytes: number;
  created_at: number;
};

function mapGrant(row: UploadAccessRow): UploadAccessGrant {
  return {
    fileId: row.file_id,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    storagePath: row.storage_path,
    originalName: row.original_name,
    mimeType: row.mime_type,
    category: row.category,
    sizeBytes: Number(row.size_bytes),
    createdAt: Number(row.created_at),
  };
}

export async function getUploadAccessGrant(fileId: string): Promise<UploadAccessGrant | null> {
  const database = await openDb();
  try {
    const row = await database.get(
      'SELECT * FROM upload_access_grants WHERE file_id = ? LIMIT 1',
      [fileId],
    ) as UploadAccessRow | undefined;
    return row ? mapGrant(row) : null;
  } finally {
    await database.close();
  }
}

export async function createUploadAccessGrant(
  grant: UploadAccessGrant,
  options: { ifAbsent?: boolean } = {},
): Promise<void> {
  const database = await openDb();
  try {
    const conflictClause = options.ifAbsent ? ' ON CONFLICT(file_id) DO NOTHING' : '';
    await database.run(
      `INSERT INTO upload_access_grants (
         file_id, owner_user_id, workspace_id, storage_path, original_name,
         mime_type, category, size_bytes, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)${conflictClause}`,
      [
        grant.fileId,
        grant.ownerUserId,
        grant.workspaceId,
        grant.storagePath,
        grant.originalName,
        grant.mimeType,
        grant.category,
        grant.sizeBytes,
        grant.createdAt,
      ],
    );
  } finally {
    await database.close();
  }
}

export async function deleteUploadAccessGrant(fileId: string): Promise<void> {
  const database = await openDb();
  try {
    await database.run('DELETE FROM upload_access_grants WHERE file_id = ?', [fileId]);
  } finally {
    await database.close();
  }
}

export function isUploadAccessAllowed(
  grant: UploadAccessGrant,
  identity: { userId: string; workspaceId?: string | null },
): boolean {
  if (grant.ownerUserId === identity.userId) return true;
  return Boolean(
    grant.workspaceId
    && identity.workspaceId
    && grant.workspaceId === identity.workspaceId,
  );
}
