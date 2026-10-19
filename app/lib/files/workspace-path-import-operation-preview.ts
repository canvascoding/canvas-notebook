import 'server-only';

import { types } from 'node:util';
import { openDb } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { withWorkspaceRequestPrincipalOnConnection, type WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import { withDirectMcpWorkspaceMovePrincipalOnConnection, withDirectMcpWorkspaceDeletePrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { createWorkspacePathImportPreparationPlanV1,
  type WorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import type { WorkspacePathImportPreparationPrincipal } from './workspace-path-import-preparation-phase';

type Input = Readonly<{ principal: WorkspacePathImportPreparationPrincipal; kind: 'move' | 'rename' | 'delete';
  selections: readonly Readonly<{ sourcePath: string; destinationPath?: string }>[] }>;
type Access = WorkspaceRequestPrincipalAccess | DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess;
export class WorkspacePathImportPreviewError extends Error {
  readonly status: 403 | 409 | 422 | 503;
  constructor(readonly code: 'PATH_IMPORT_PREVIEW_INVALID' | 'PATH_IMPORT_PREVIEW_BUSY' | 'PATH_IMPORT_PREVIEW_UNAVAILABLE'
    | 'PATH_IMPORT_PREVIEW_ACCESS_DENIED',
    options?: ErrorOptions) {
    super(code, options); this.name = 'WorkspacePathImportPreviewError';
    this.status = code === 'PATH_IMPORT_PREVIEW_INVALID' ? 422 : code === 'PATH_IMPORT_PREVIEW_BUSY' ? 409
      : code === 'PATH_IMPORT_PREVIEW_ACCESS_DENIED' ? 403 : 503;
  }
}

/** Capture request data before any await; retain only the genuine opaque handle. */
function captureWorkspacePathImportPreviewInput(supplied: Input): Input {
  const invalid = (): never => { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_INVALID'); };
  const data = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== keys.length) return invalid();
    const fields: Record<string, unknown> = {};
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) return invalid(); fields[key] = field.value;
    }
    return fields;
  };
  const fields = data(supplied, ['principal', 'kind', 'selections']), selected = data(fields.principal, ['kind', 'principal']);
  if (fields.kind !== 'move' && fields.kind !== 'rename' && fields.kind !== 'delete'
    || selected.kind !== 'request' && selected.kind !== 'move' && selected.kind !== 'delete'
    || selected.kind !== 'request' && selected.kind !== fields.kind) return invalid();
  const values = fields.selections;
  if (!Array.isArray(values) || types.isProxy(values) || Object.getPrototypeOf(values) !== Array.prototype
    || !values.length || values.length > 1000 || Reflect.ownKeys(values).length !== values.length + 1) return invalid();
  const selections = Array.from({ length: values.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(values, String(index));
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) return invalid();
    const value = data(item.value, fields.kind === 'delete' ? ['sourcePath'] : ['sourcePath', 'destinationPath']);
    for (const file of Object.values(value)) {
      if (typeof file !== 'string' || !isCanonicalAdmissionPath(file) || Buffer.byteLength(file) > 4096
        || file.split('/').length > 33 || Buffer.from(file).toString('utf8') !== file) return invalid();
    }
    return Object.freeze({ sourcePath: value.sourcePath as string,
      ...(fields.kind === 'delete' ? {} : { destinationPath: value.destinationPath as string }) });
  });
  return Object.freeze({ principal: Object.freeze({ kind: selected.kind, principal: selected.principal }) as WorkspacePathImportPreparationPrincipal,
    kind: fields.kind, selections: Object.freeze(selections) });
}

/** Fixed read-only preview facts under a current genuine principal and the same
 * ordinary shared admission fence used by source staging. Live editors remain
 * readable. This never acquires an import/claim capability or migrates a file;
 * the actual B0 owner must reobserve and compare the complete plan before use. */
export async function readWorkspacePathImportPreparationPlan(supplied: Input): Promise<WorkspacePathImportPreparationPlanV1> {
  const captured = captureWorkspacePathImportPreviewInput(supplied);
  if (!authenticatedNativeTextSessionEnabled()) throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_INVALID');
  return executeLifecycleTransaction({
    openConnection: async () => {
      const actual = await openDb().catch(cause => { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_UNAVAILABLE', { cause }); });
      return { get: (sql, values) => actual.get(sql, values), all: (sql, values) => actual.all(sql, values),
        run: (sql, values) => actual.run(sql, values), close: async error => {
          try { await actual.close(error); }
          catch (cause) { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_UNAVAILABLE', { cause }); }
        } };
    },
    execute: async database => {
      // The genuine OnConnection principal requires RC/RW. This fixed entry
      // executes SELECTs only and grants no writable connection to its caller.
      await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
      const read = async (access: Access): Promise<WorkspacePathImportPreparationPlanV1> => {
        await access.assertCurrent(); const workspace = access.workspace;
        if (workspace.legacy || workspace.status !== 'active' || !workspace.permissions.canRead
          || !workspace.permissions.canWrite || !workspace.permissions.canDelete) {
          throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_ACCESS_DENIED');
        }
        const locked = await database.get('SELECT pg_catalog.pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
          [collaborationAdmissionLockKey(workspace.workspaceId)]) as { locked?: unknown } | undefined;
        if (locked?.locked !== true) throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_BUSY');
        const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database, workspace, { physicalParserVersion: 3 });
        const plan = createWorkspacePathImportPreparationPlanV1({ scope: captureWorkspaceOperationJobScope(workspace),
          kind: captured.kind, selections: captured.selections.map(value => ({ ...value })), observation });
        await access.assertCurrent(); return plan;
      };
      return captured.principal.kind === 'request'
        ? withWorkspaceRequestPrincipalOnConnection(database, captured.principal.principal, read)
        : captured.principal.kind === 'move'
          ? withDirectMcpWorkspaceMovePrincipalOnConnection(database, captured.principal.principal, read)
          : withDirectMcpWorkspaceDeletePrincipalOnConnection(database, captured.principal.principal, read);
    },
    recoverCommitted: async (_value, cause) => { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_UNAVAILABLE', { cause }); },
  });
}
