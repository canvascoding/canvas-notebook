import { createWorkspacePathPhysicalDeletePreparationPlanV5, type WorkspacePathPhysicalDeletePreparationPlanV5 } from './workspace-path-physical-delete-preparation-v5';
import 'server-only';
import { isWorkspaceCohortDeleteRequest, createWorkspacePathCohortDeletePreparation, type WorkspacePathCohortDeletePreparation } from './workspace-path-cohort-delete-preparation';

import { isDeepStrictEqual, types } from 'node:util';
import { openDb } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { readWorkspaceLinkSourceAuthorityOnConnection, requiresWorkspaceLinkSourceAuthorityRevalidation } from '../markdown/workspace-source-authority-stage';
import { WorkspacePreviewStaleError } from '../markdown/workspace-file-operation-preview';
import { withWorkspaceRequestPrincipalOnConnection, type WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import { withDirectMcpWorkspaceMovePrincipalOnConnection, withDirectMcpWorkspaceDeletePrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { createWorkspacePathImportPreparationPlanV1,
  type WorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import { createWorkspacePathHtmlNoImportPreparationPlanV2,
  type WorkspacePathHtmlNoImportPreparationPlanV2 } from './workspace-path-html-no-import-preparation';
import { createWorkspacePathHtmlNativeDeletePreparationPlanV3,
  type WorkspacePathHtmlNativeDeletePreparationPlanV3 } from './workspace-path-html-native-delete-preparation';
import { createWorkspacePathHtmlImportPreparationPlanV4, type WorkspacePathHtmlImportPreparationPlanV4 } from './workspace-path-html-import-preparation';
import type { WorkspacePathImportPreparationPrincipal } from './workspace-path-import-preparation-phase';

type Input = Readonly<{ principal: WorkspacePathImportPreparationPrincipal; kind: 'move' | 'rename' | 'delete';
  selections: readonly Readonly<{ sourcePath: string; destinationPath?: string }>[] }>;
type Access = WorkspaceRequestPrincipalAccess | DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess;
export type WorkspacePathImportPreparationPreviewPlan = WorkspacePathImportPreparationPlanV1 | WorkspacePathHtmlNoImportPreparationPlanV2
  | WorkspacePathHtmlNativeDeletePreparationPlanV3 | WorkspacePathPhysicalDeletePreparationPlanV5 | WorkspacePathHtmlImportPreparationPlanV4 | WorkspacePathCohortDeletePreparation;
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

/** A known non-HTML coverage gap is a blocked preview, not invalid source
 * evidence. This error carries diagnostics only and never grants a plan. */
export class WorkspacePathSourceIncompleteError extends Error {
  readonly code = 'PATH_SOURCE_INCOMPLETE';
  readonly status = 409;
  readonly issues: readonly Readonly<{ code: string; path: string }>[];
  readonly issueCount: number;
  readonly retryable: boolean;
  constructor(issues: readonly Readonly<{ code: string; path: string }>[]) {
    super('Workspace link analysis is incomplete. Inspect the reported sources before retrying.');
    this.name = 'WorkspacePathSourceIncompleteError';
    const unique = [...new Map(issues.map(issue => [JSON.stringify([issue.code, issue.path]), issue])).values()];
    this.issueCount = unique.length;
    this.retryable = unique.length > 0 && unique.every(issue =>
      issue.code === 'physical-source-changed' || issue.code === 'physical-scope-changed');
    this.issues = Object.freeze(unique.slice(0, 50).map(({ code, path }) => Object.freeze({ code, path })));
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

/** Read-only preview facts from two fresh principal/admission-fenced scans.
 * Pure planning runs between transactions. The second scan must match every
 * source before returning; the B0 owner still reobserves before actual use. */
export async function readWorkspacePathImportPreparationPlan(supplied: Input): Promise<WorkspacePathImportPreparationPreviewPlan> {
  const captured = captureWorkspacePathImportPreviewInput(supplied);
  if (!authenticatedNativeTextSessionEnabled()) throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_INVALID');
  type Sources = { workspace: Access['workspace']; scope: ReturnType<typeof captureWorkspaceOperationJobScope>;
    observation: Awaited<ReturnType<typeof readWorkspaceLinkSourceAuthorityOnConnection>> };
  const readSources = (expected?: Sources): Promise<Sources> => executeLifecycleTransaction({
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
      const read = async (access: Access): Promise<Sources> => {
        await access.assertCurrent(); const workspace = access.workspace;
        if (workspace.legacy || workspace.status !== 'active' || !workspace.permissions.canRead
          || !workspace.permissions.canWrite || !workspace.permissions.canDelete) {
          throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_ACCESS_DENIED');
        }
        const locked = await database.get('SELECT pg_catalog.pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
          [collaborationAdmissionLockKey(workspace.workspaceId)]) as { locked?: unknown } | undefined;
        if (locked?.locked !== true) throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_BUSY');
        const observation = await readWorkspaceLinkSourceAuthorityOnConnection(database, workspace, { physicalParserVersion: 3 });
        if (requiresWorkspaceLinkSourceAuthorityRevalidation(observation)) {
          await access.assertCurrent();
          throw Object.assign(new WorkspacePreviewStaleError(), { status: 409, code: 'PREVIEW_STALE' });
        }
        // A rejected/incoherent observation intentionally has no catalogue
        // witness. Report its gaps instead of passing it to an evidence parser.
        if (!observation.privateCatalogue) {
          await access.assertCurrent();
          throw new WorkspacePathSourceIncompleteError(observation.stage.coverage.gaps);
        }
        const scope = captureWorkspaceOperationJobScope(workspace);
        if (expected && (!isDeepStrictEqual(scope, expected.scope)
          || !isDeepStrictEqual(observation, expected.observation))) {
          await access.assertCurrent();
          throw Object.assign(new WorkspacePreviewStaleError(), { status: 409, code: 'PREVIEW_STALE' });
        }
        await access.assertCurrent(); return { workspace, scope, observation };
      };
      return captured.principal.kind === 'request'
        ? withWorkspaceRequestPrincipalOnConnection(database, captured.principal.principal, read)
        : captured.principal.kind === 'move'
          ? withDirectMcpWorkspaceMovePrincipalOnConnection(database, captured.principal.principal, read)
          : withDirectMcpWorkspaceDeletePrincipalOnConnection(database, captured.principal.principal, read);
    },
    recoverCommitted: async (_value, cause) => { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_UNAVAILABLE', { cause }); },
  });
  // The plan is pure historical data, not authority. Do not hold a database
  // transaction/admission fence during its CPU-intensive proof construction.
  const first = await readSources();
  const { workspace, scope, observation } = first;
  const calculate = (): WorkspacePathImportPreparationPreviewPlan => {
    const physicalPath = captured.selections.length === 1 ? captured.selections[0].sourcePath : null;
    const physicalNode = physicalPath ? observation.stage.namespace.find(entry => entry.path === physicalPath) : null;
    const physicalDelete = captured.kind === 'delete' && physicalNode?.kind === 'file' && physicalNode.documentId === null
      && physicalNode.filesystemIdentity && !/\.(?:md|markdown|mdx|html?|excalidraw)$/iu.test(physicalNode.path)
      && !observation.nativeBindings.some(binding => binding.expected.path === physicalNode.path)
      && !observation.stage.sources.some(source => source.kind === 'physical' && source.inventory.path === physicalNode.path);
    const cohortDelete = captured.kind==='delete' && isWorkspaceCohortDeleteRequest(observation,captured.selections);
    // The HTML evidence contract accepts only HTML gaps. Other genuine
    // native coverage gaps must remain blocked, with their original cause;
    // do not feed them into evidence capture and lose them as INVALID.
    const nativeGaps = observation.stage.sources.flatMap(source => source.kind === 'native'
      ? source.inventory.coverage.gaps.filter(gap => gap.code !== 'uninspected-html') : []);
    if (!cohortDelete && nativeGaps.length) {
      throw new WorkspacePathSourceIncompleteError(nativeGaps);
    }
    const htmlImport = !cohortDelete && !observation.stage.coverage.complete ? createWorkspacePathHtmlImportPreparationPlanV4({ scope, kind: captured.kind,
      selections: captured.selections.map(value => ({ ...value })), observation }) : null;
    const plan = cohortDelete ? createWorkspacePathCohortDeletePreparation({workspace,selections:captured.selections,observation})
      : htmlImport && (htmlImport.importRequirements.length > 0
      || htmlImport.issues.some(issue => issue.code === 'raw-markdown-html-import-unsupported')) ? htmlImport
      : physicalDelete ? createWorkspacePathPhysicalDeletePreparationPlanV5({ scope, kind: 'delete',
      selections: captured.selections.map(({sourcePath}) => ({sourcePath})), observation }) : !observation.stage.coverage.complete
      ? captured.kind === 'delete' ? createWorkspacePathHtmlNativeDeletePreparationPlanV3({ scope, kind: 'delete',
        selections: captured.selections.map(({ sourcePath }) => ({ sourcePath })), observation })
      : createWorkspacePathHtmlNoImportPreparationPlanV2({ scope, kind: captured.kind,
        selections: captured.selections.map(value => ({ sourcePath: value.sourcePath, destinationPath: value.destinationPath! })), observation })
      : createWorkspacePathImportPreparationPlanV1({ scope, kind: captured.kind,
        selections: captured.selections.map(value => ({ ...value })), observation });
    return plan;
  };
  let plan: WorkspacePathImportPreparationPreviewPlan | undefined;
  let failed = false, failure: unknown;
  try { plan = calculate(); } catch (error) { failed = true; failure = error; }
  // Fresh rights, scope, catalogue, native bytes/metadata and physical evidence
  // must still match under a NEW bounded transaction before any result escapes.
  // Recheck even failed calculations so an error cannot bypass current rights.
  await readSources(first);
  if (failed) throw failure;
  return plan!;
}
