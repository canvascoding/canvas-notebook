import 'server-only';
import { createHash } from 'node:crypto';
import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { readSettingsTextFileIfExists, writeSettingsJsonFileAtomic } from '@/app/lib/settings-storage';
import { addFileVisit, normalizeFileVisits, type FileVisit } from './quick-access';

function historyFile(userId: string, workspaceId: string) {
  const key = createHash('sha256').update(JSON.stringify([userId, workspaceId])).digest('hex');
  return `file-visits/${key}.json`;
}

export async function readFileVisits(userId: string, workspaceId: string): Promise<FileVisit[]> {
  const { content } = await readSettingsTextFileIfExists(historyFile(userId, workspaceId));
  if (!content) return [];
  try {
    return normalizeFileVisits(JSON.parse(content));
  } catch {
    return [];
  }
}

export async function recordFileVisit(userId: string, workspaceId: string, path: string): Promise<void> {
  const file = historyFile(userId, workspaceId);
  await withKeyedOperationLock('file-visits', file, async () => {
    const visits = await readFileVisits(userId, workspaceId);
    await writeSettingsJsonFileAtomic(file, addFileVisit(visits, path));
  });
}
