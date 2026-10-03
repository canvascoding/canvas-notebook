import 'server-only';

import { createHash } from 'node:crypto';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase } from '@/app/lib/file-version-center/database';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type WorkspacePathOperationProblem = {
  problemId: string; workspaceId: string; kind: 'move' | 'rename' | 'delete';
  selections: Array<{ sourcePath: string; destinationPath?: string }>;
  errorCode: string; createdAt: number; updatedAt: number;
};
export type WorkspacePathOperationProblemInput = {
  workspace: WorkspaceContext; actorUserId: string; kind: WorkspacePathOperationProblem['kind'];
  selections: Array<{ sourcePath: string; destinationPath?: string }>; error: unknown;
};

/** Only displayable workspace-relative names are persisted. Invalid requests still get a generic problem. */
function safePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.startsWith('/')
    || value.includes('\\') || /[\p{Cc}\p{Cf}]/u.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return null;
  const parts = value.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

export function sanitizeWorkspacePathOperationSelections(value: unknown): WorkspacePathOperationProblem['selections'] {
  if (!Array.isArray(value)) return [];
  const selections = new Map<string, WorkspacePathOperationProblem['selections'][number]>();
  for (const raw of value.slice(0, 1000)) {
    if (!raw || typeof raw !== 'object') continue;
    const sourcePath = safePath(raw.sourcePath);
    if (!sourcePath) continue;
    const destinationPath = safePath(raw.destinationPath);
    const selection = { sourcePath, ...(destinationPath ? { destinationPath } : {}) };
    selections.set(JSON.stringify(selection), selection);
  }
  return [...selections.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function workspacePathOperationProblemErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : 'WORKSPACE_OPERATION_FAILED';
}

type Row = { problem_id: string; workspace_id: string; operation_kind: WorkspacePathOperationProblem['kind'];
  selections_json: string; error_code: string; created_at: string | number; updated_at: string | number };

export function createWorkspacePathOperationProblemStore(options: {
  database?: FileVersionCenterDatabase; now?: () => number;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const now = options.now ?? Date.now;
  return {
    async get(problemId: string): Promise<WorkspacePathOperationProblem | null> {
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(problemId)) return null;
      return database.transaction(async (transaction) => {
        const result = await transaction.query<Row>(`SELECT problem_id,workspace_id,operation_kind,selections_json,
          error_code,created_at,updated_at FROM workspace_path_operation_problems WHERE problem_id = $1`, [problemId]);
        const row = result.rows[0];
        if (!row) return null;
        return { problemId: row.problem_id, workspaceId: row.workspace_id, kind: row.operation_kind,
          selections: sanitizeWorkspacePathOperationSelections(JSON.parse(row.selections_json)),
          errorCode: workspacePathOperationProblemErrorCode({ code: row.error_code }),
          createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
      });
    },
    async record(input: WorkspacePathOperationProblemInput): Promise<void> {
      if (!input.actorUserId?.trim() || !input.workspace.workspaceId || !input.workspace.permissions.canRead
        || (input.workspace.status ?? 'active') !== 'active' || !['move', 'rename', 'delete'].includes(input.kind)) return;
      const selections = sanitizeWorkspacePathOperationSelections(input.selections);
      const problemId = createHash('sha256').update(JSON.stringify(['workspace-path-problem-v1',
        input.workspace.workspaceId, input.actorUserId, input.kind, selections])).digest('hex');
      await database.transaction(async (transaction) => {
        await transaction.query(`INSERT INTO workspace_path_operation_problems
          (problem_id,workspace_id,actor_user_id,operation_kind,selections_json,error_code,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
          ON CONFLICT (problem_id) DO UPDATE SET error_code = EXCLUDED.error_code,
            updated_at = GREATEST(EXCLUDED.updated_at, workspace_path_operation_problems.updated_at + 1)`,
        [problemId, input.workspace.workspaceId, input.actorUserId, input.kind, JSON.stringify(selections),
          workspacePathOperationProblemErrorCode(input.error), now()]);
      });
    },
  };
}

export const workspacePathOperationProblemStore = createWorkspacePathOperationProblemStore();
export const recordWorkspacePathOperationProblem = (input: WorkspacePathOperationProblemInput): Promise<void> =>
  workspacePathOperationProblemStore.record(input);
