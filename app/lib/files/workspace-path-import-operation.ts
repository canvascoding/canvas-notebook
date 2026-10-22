import 'server-only';

import { types } from 'node:util';
import { openDb } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { withWorkspaceFileLifecycleGuard } from './workspace-file-lifecycle-guard';
import { decodeWorkspacePathHtmlImportPreparationPlanV4 } from './workspace-path-html-import-preparation';
import { decodeWorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import { prepareWorkspacePathImportOperationOnConnection, type WorkspacePathImportPreparationInput,
  type WorkspacePathImportOperationPreparation, type WorkspacePathImportPreparationPrincipal } from './workspace-path-import-preparation-phase';

export class WorkspacePathImportOperationError extends Error {
  readonly status: 422 | 503;
  constructor(readonly code: 'PATH_IMPORT_OPERATION_INVALID' | 'PATH_IMPORT_OPERATION_OUTCOME_UNCONFIRMED',
    readonly operationId?: string, readonly previewPlanId?: string, options?: ErrorOptions) {
    super(code, options); this.name = 'WorkspacePathImportOperationError';
    this.status = code === 'PATH_IMPORT_OPERATION_INVALID' ? 422 : 503;
  }
}

function captureWorkspacePathImportOperationInput(supplied: WorkspacePathImportPreparationInput): WorkspacePathImportPreparationInput {
  const invalid = (): never => { throw new WorkspacePathImportOperationError('PATH_IMPORT_OPERATION_INVALID'); };
  const data = (value: unknown, keys: readonly string[]) => {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== keys.length) return invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) return invalid();
      result[key] = field.value;
    }
    return result;
  };
  const fields = data(supplied, ['principal', 'operationId', 'plan']);
  const selected = data(fields.principal, ['kind', 'principal']);
  if (selected.kind !== 'request' && selected.kind !== 'move' && selected.kind !== 'delete'
    || typeof fields.operationId !== 'string' || !fields.operationId || fields.operationId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(fields.operationId) || Buffer.from(fields.operationId).toString('utf8') !== fields.operationId) return invalid();
  if (!fields.plan || typeof fields.plan !== 'object' || types.isProxy(fields.plan)
    || Object.getPrototypeOf(fields.plan) !== Object.prototype) return invalid();
  const versionField = Object.getOwnPropertyDescriptor(fields.plan, 'version');
  if (!versionField?.enumerable || !Object.hasOwn(versionField, 'value')) return invalid();
  const planVersion = versionField.value;
  const plan = planVersion === 4 ? decodeWorkspacePathHtmlImportPreparationPlanV4(fields.plan)
    : decodeWorkspacePathImportPreparationPlanV1(fields.plan);
  if (plan.readiness !== 'requires-import-rebinding' || !plan.importRequirements.length
    || selected.kind !== 'request' && plan.request.kind !== selected.kind) return invalid();
  return Object.freeze({ principal: Object.freeze({ kind: selected.kind, principal: selected.principal }) as WorkspacePathImportPreparationPrincipal,
    operationId: fields.operationId, plan });
}

/** Fresh Apply preparation only. Original public history is resolved before
 * entering here. B0 commits imports, the real header, P0 and admission together.
 * This creates no executable claim and performs no file move/delete. The caller
 * acquires the existing ordinary claim only after this complete owner returns. */
export async function prepareWorkspacePathImportOperation(supplied: WorkspacePathImportPreparationInput
): Promise<WorkspacePathImportOperationPreparation> {
  const captured = captureWorkspacePathImportOperationInput(supplied);
  if (!authenticatedNativeTextSessionEnabled()) throw new WorkspacePathImportOperationError('PATH_IMPORT_OPERATION_INVALID');
  return withWorkspaceFileLifecycleGuard({ workspaceId: captured.plan.scope.workspaceId,
    paths: captured.plan.importRequirements.map(requirement => requirement.path) }, async () => {
    return executeLifecycleTransaction({
        openConnection: async () => {
          const actual = await openDb();
          return { get: (sql, values) => actual.get(sql, values), all: (sql, values) => actual.all(sql, values),
            run: (sql, values) => actual.run(sql, values), close: async error => {
              try { await actual.close(error); }
              catch (cause) { throw new WorkspacePathImportOperationError('PATH_IMPORT_OPERATION_OUTCOME_UNCONFIRMED',
                captured.operationId, captured.plan.planId, { cause }); }
            } };
        },
        execute: async database => {
          await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
          return prepareWorkspacePathImportOperationOnConnection(database, captured);
        },
        recoverCommitted: async (_original, cause) => {
          throw new WorkspacePathImportOperationError('PATH_IMPORT_OPERATION_OUTCOME_UNCONFIRMED',
            captured.operationId, captured.plan.planId, { cause });
        },
      });
  });
}
