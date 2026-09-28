import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  isSafeFileVersionPathHint,
  type FileChangeGroupEntryV1,
  type FileChangeGroupV1,
} from '@/app/lib/file-version-center/contracts/v1';
import {
  parseProposalEntryPointV1,
  type ProposalEntryPointV1,
} from '@/app/lib/file-version-center/contracts/proposal-entrypoint-v1';
import { isToolAppRecord } from './types';

export const FILE_CHANGE_APP_DATA_MAX_BYTES = 256 * 1024;
export const FILE_CHANGE_APP_VISIBLE_ENTRIES = 5;

export function paginateFileChangeAppEntries<T>(entries: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(entries.length / FILE_CHANGE_APP_VISIBLE_ENTRIES));
  const pageIndex = Math.max(0, Math.min(Math.trunc(requestedPage) || 0, pageCount - 1));
  const offset = pageIndex * FILE_CHANGE_APP_VISIBLE_ENTRIES;
  return {
    entries: entries.slice(offset, offset + FILE_CHANGE_APP_VISIBLE_ENTRIES),
    pageIndex,
    pageCount,
    hiddenCount: Math.max(0, entries.length - FILE_CHANGE_APP_VISIBLE_ENTRIES),
  };
}

export type FileChangeAppEntryState = FileChangeGroupEntryV1['outcome']
  | 'rejected'
  | 'reverted'
  | 'restored'
  | 'superseded'
  | 'included'
  | 'alternative_not_selected'
  | 'blocked_by_parent'
  | 'satisfied_elsewhere'
  | 'unavailable'
  | 'expired';

export type FileChangeAppEntryData = {
  id: string;
  ordinal: number;
  pathHint: string;
  state: FileChangeAppEntryState;
  operationId: string | null;
  revisionId: string | null;
  additions: number | null;
  deletions: number | null;
  proposal?: ProposalEntryPointV1;
};

export type FileChangeAppData = {
  contractVersion: 1;
  id: string;
  workspaceId: string;
  operation: FileChangeGroupV1['operation'];
  status: FileChangeAppEntryState | 'mixed';
  createdAt: string;
  entries: FileChangeAppEntryData[];
};

export function fileChangeAppStatusMessageKey(state: FileChangeAppEntryState | 'mixed', graph = false): string {
  return state === 'superseded' && graph ? 'fileChangeStatus_graph_superseded' : `fileChangeStatus_${state}`;
}

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const fileChangeGroupId = /^fvcg-[a-f0-9]{64}$/u;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedCount(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function readEntry(value: unknown): FileChangeAppEntryData | null {
  const requiredKeys = ['id', 'ordinal', 'pathHint', 'state', 'operationId', 'revisionId', 'additions', 'deletions'];
  if (!isToolAppRecord(value)
    || !exactKeys(value, value.proposal === undefined ? requiredKeys : [...requiredKeys, 'proposal'])
    || typeof value.id !== 'string' || !opaqueId.test(value.id)
    || !Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0
    || Number(value.ordinal) >= FILE_VERSION_CENTER_CONTRACT_LIMITS.changeGroupEntries
    || typeof value.pathHint !== 'string' || !isSafeFileVersionPathHint(value.pathHint)
    || !['applied', 'review_required', 'conflict', 'failed', 'rejected', 'reverted', 'restored', 'superseded',
      'included', 'alternative_not_selected', 'blocked_by_parent', 'satisfied_elsewhere', 'unavailable', 'expired']
      .includes(String(value.state))
    || (value.operationId !== null && (typeof value.operationId !== 'string' || !opaqueId.test(value.operationId)))
    || (value.revisionId !== null && (typeof value.revisionId !== 'string' || !opaqueId.test(value.revisionId)))
    || !boundedCount(value.additions) || !boundedCount(value.deletions)) return null;
  let proposal: ProposalEntryPointV1 | undefined;
  if (value.proposal !== undefined) {
    if (value.operationId === null) return null;
    try { proposal = parseProposalEntryPointV1(value.proposal); } catch { return null; }
  }
  return {
    id: value.id,
    ordinal: Number(value.ordinal),
    pathHint: value.pathHint,
    state: value.state as FileChangeAppEntryState,
    operationId: value.operationId as string | null,
    revisionId: value.revisionId as string | null,
    additions: value.additions as number | null,
    deletions: value.deletions as number | null,
    ...(proposal ? { proposal } : {}),
  };
}

/** Strict client boundary for server-authorized, reloadable file-change summaries. */
export function readFileChangeAppData(value: unknown): FileChangeAppData | null {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > FILE_CHANGE_APP_DATA_MAX_BYTES) return null;
  } catch { return null; }
  if (!isToolAppRecord(value)
    || !exactKeys(value, ['contractVersion', 'id', 'workspaceId', 'operation', 'status', 'createdAt', 'entries'])
    || value.contractVersion !== 1
    || typeof value.id !== 'string' || !fileChangeGroupId.test(value.id)
    || typeof value.workspaceId !== 'string' || !opaqueId.test(value.workspaceId)
    || !['write', 'edit_file', 'apply_patch'].includes(String(value.operation))
    || !['applied', 'review_required', 'conflict', 'failed', 'rejected', 'reverted', 'restored', 'superseded',
      'included', 'alternative_not_selected', 'blocked_by_parent', 'satisfied_elsewhere', 'unavailable', 'expired', 'mixed']
      .includes(String(value.status))
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.entries) || value.entries.length < 1
    || value.entries.length > FILE_VERSION_CENTER_CONTRACT_LIMITS.changeGroupEntries) return null;
  const entries = value.entries.map(readEntry);
  if (entries.some((entry) => !entry)) return null;
  const parsed = entries as FileChangeAppEntryData[];
  if (parsed.some((entry, ordinal) => entry.ordinal !== ordinal)
    || new Set(parsed.map((entry) => entry.id)).size !== parsed.length) return null;
  const statuses = new Set(parsed.map((entry) => entry.state));
  const status = statuses.size === 1 ? parsed[0]!.state : 'mixed';
  if (status !== value.status) return null;
  return {
    contractVersion: 1,
    id: value.id,
    workspaceId: value.workspaceId,
    operation: value.operation as FileChangeGroupV1['operation'],
    status,
    createdAt: new Date(value.createdAt).toISOString(),
    entries: parsed,
  };
}
