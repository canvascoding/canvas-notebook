import 'server-only';

import { McpAccessError } from '@/app/lib/mcp/access';
import type { McpAppChat } from '@/app/lib/mcp/apps-host';
import { requireBuiltinToolAppAccess } from './builtin-access';
import { readFileChangeAppData, type FileChangeAppData } from './file-change-data';
import { FILE_CHANGE_APP_URI, readBuiltinToolAppDescriptor, type BuiltinToolAppDescriptor } from './types';

export const MAX_FILE_CHANGE_SUMMARY_APPS = 100;
export const MAX_FILE_CHANGE_SUMMARY_GROUP_BYTES = 2 * 1024 * 1024;

export type FileChangeSummaryUnavailable = {
  entityId: string;
  toolCallId: string;
  status: 403 | 404 | 413 | 425;
  retryable: boolean;
};

export type FileChangeSummaryData = {
  groups: FileChangeAppData[];
  unavailable: FileChangeSummaryUnavailable[];
};

/** Only stored file-change references can request current summary data. */
export function readFileChangeSummaryApps(value: unknown): BuiltinToolAppDescriptor[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILE_CHANGE_SUMMARY_APPS) {
    throw new McpAccessError('Invalid file-change summary references.', 400);
  }
  const apps: BuiltinToolAppDescriptor[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const app = readBuiltinToolAppDescriptor(candidate);
    if (!app || app.resourceUri !== FILE_CHANGE_APP_URI) {
      throw new McpAccessError('Invalid file-change summary reference.', 400);
    }
    const key = JSON.stringify([app.entityId, app.toolCallId, app.operation]);
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push(app);
  }
  return apps;
}

/** Reuse the saved-result binding and workspace authorization for every group. */
export async function readAuthorizedFileChangeSummary(
  chat: McpAppChat,
  references: unknown,
): Promise<FileChangeSummaryData> {
  const apps = readFileChangeSummaryApps(references);
  const data: FileChangeSummaryData = { groups: [], unavailable: [] };
  let groupBytes = 2;
  for (const app of apps) {
    try {
      const group = readFileChangeAppData(await requireBuiltinToolAppAccess(chat, app));
      if (!group || group.id !== app.entityId || group.operation !== app.operation) {
        throw new McpAccessError('File changes are unavailable.', 404);
      }
      const bytes = Buffer.byteLength(JSON.stringify(group), 'utf8') + (data.groups.length ? 1 : 0);
      if (groupBytes + bytes > MAX_FILE_CHANGE_SUMMARY_GROUP_BYTES) {
        throw new McpAccessError('File-change summary data is too large.', 413);
      }
      groupBytes += bytes;
      data.groups.push(group);
    } catch (error) {
      if (!(error instanceof McpAccessError) || ![403, 404, 413, 425].includes(error.status)) throw error;
      data.unavailable.push({
        entityId: app.entityId,
        toolCallId: app.toolCallId,
        status: error.status as FileChangeSummaryUnavailable['status'],
        retryable: error.status === 425,
      });
    }
  }
  return data;
}
