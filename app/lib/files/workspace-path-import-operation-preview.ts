import { createWorkspacePathPhysicalDeletePreparationPlanV5, type WorkspacePathPhysicalDeletePreparationPlanV5 } from './workspace-path-physical-delete-preparation-v5';
import 'server-only';
import { isWorkspaceCohortDeleteRequest, createWorkspacePathCohortDeletePreparation, type WorkspacePathCohortDeletePreparation } from './workspace-path-cohort-delete-preparation';

import { isDeepStrictEqual, types } from 'node:util';
import { NextRequest } from 'next/server';
import { openDb, type SqlConnection } from '../db';
import { withWorkspaceSourceScanObserver } from '../observability/workspace-source-scan';
import { directMcpCorrelationId } from '../mcp/server/diagnostics';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { readWorkspaceLinkSourcePreviewObservation, requiresWorkspaceLinkSourceAuthorityRevalidation } from '../markdown/workspace-source-authority-stage';
import { WorkspacePreviewStaleError } from '../markdown/workspace-file-operation-preview';
import { isWorkspaceExternalMarkdownAutolink } from '../markdown/workspace-local-link-parser';
import { WorkspaceRequestPrincipalError, withWorkspaceRequestPrincipalOnConnection, withWorkspaceRequestPrincipalOriginalOrigin,
  type WorkspaceRequestPrincipal, type WorkspaceRequestPrincipalAccess, type WorkspaceRequestHistoricalOrigin } from '../workspaces/request-principal';
import { withDirectMcpWorkspaceMovePrincipalOnConnection, withDirectMcpWorkspaceDeletePrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { createWorkspacePathImportPreparationPlanV1,
  type WorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import { createWorkspacePathHtmlNoImportPreparationPlanV2,
  type WorkspacePathHtmlNoImportPreparationPlanV2 } from './workspace-path-html-no-import-preparation';
import { createWorkspacePathHtmlNativeDeletePreparationPlanV3,
  type WorkspacePathHtmlNativeDeletePreparationPlanV3 } from './workspace-path-html-native-delete-preparation';
import { createWorkspacePathHtmlImportPreparationPlanV4, type WorkspacePathHtmlImportPreparationPlanV4 } from './workspace-path-html-import-preparation';
import type { WorkspacePathImportPreparationPrincipal } from './workspace-path-import-preparation-phase';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';

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
const retryableRequestPreviewReads = new WeakSet<WorkspacePathImportPreviewError>();

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

/** Historical preview observations only. Every SQL read has its own bounded
 * current-principal/admission phase; filesystem and parsing work hold no SQL
 * transaction. Both complete scans must agree before returning a result.
 * Callers retain the projection kernel fence; execution owners reobserve. */
export async function readWorkspacePathImportPreparationPlan(supplied: Input): Promise<WorkspacePathImportPreparationPreviewPlan> {
  const captured = captureWorkspacePathImportPreviewInput(supplied);
  return readCapturedWorkspacePathImportPreparationPlan(captured);
}

type RequestPreviewReadPhase = <T>(read: (principal: WorkspaceRequestPrincipal) => Promise<T>) => Promise<T>;

// Only the fixed Web entry below can supply a fresh phase. Keep this private:
// public plan data cannot inject an authorizer or replace the original actor.
async function readCapturedWorkspacePathImportPreparationPlan(captured: Input,
  requestReadPhase?: RequestPreviewReadPhase): Promise<WorkspacePathImportPreparationPreviewPlan> {
  if (!authenticatedNativeTextSessionEnabled()) throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_INVALID');
  type Sources = { workspace: Access['workspace']; scope: ReturnType<typeof captureWorkspaceOperationJobScope>;
    observation: Awaited<ReturnType<typeof readWorkspaceLinkSourcePreviewObservation>> };
  const readSources = async (expected?: Sources): Promise<Sources> => {
    let scope: Sources['scope'] | undefined;
    let workspace: Access['workspace'] | undefined;
    let phaseFailed = false;
    let phaseFailure: unknown;
    let phaseMs = 0, sqlMs = 0, sqlPhases = 0, maxPhaseMs = 0;
    const readPhase = async <T>(operation: (database: SqlConnection) => Promise<T>): Promise<T> => {
      if (phaseFailed) throw phaseFailure;
      const phaseStarted = performance.now(); sqlPhases++;
      let rollbackClosedError: unknown;
      try {
        const execute = (freshRequestPrincipal?: WorkspaceRequestPrincipal) => executeLifecycleTransaction({
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
            const read = async (access: Access): Promise<T> => {
              await access.assertCurrent(); const currentWorkspace = access.workspace;
              if (currentWorkspace.legacy || currentWorkspace.status !== 'active' || !currentWorkspace.permissions.canRead
                || !currentWorkspace.permissions.canWrite || !currentWorkspace.permissions.canDelete) {
                throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_ACCESS_DENIED');
              }
              const locked = await database.get('SELECT pg_catalog.pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
                [collaborationAdmissionLockKey(currentWorkspace.workspaceId)]) as { locked?: unknown } | undefined;
              if (locked?.locked !== true) throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_BUSY');
              const currentScope = captureWorkspaceOperationJobScope(currentWorkspace);
              if (scope && !isDeepStrictEqual(currentScope, scope)
                || expected && !isDeepStrictEqual(currentScope, expected.scope)) {
                throw Object.assign(new WorkspacePreviewStaleError(), { status: 409, code: 'PREVIEW_STALE' });
              }
              scope ??= currentScope; workspace ??= currentWorkspace;
              const value = await operation(database);
              await access.assertCurrent(); return value;
            };
            return captured.principal.kind === 'request'
              ? withWorkspaceRequestPrincipalOnConnection(database, freshRequestPrincipal ?? captured.principal.principal, read)
              : captured.principal.kind === 'move'
                ? withDirectMcpWorkspaceMovePrincipalOnConnection(database, captured.principal.principal, read)
                : withDirectMcpWorkspaceDeletePrincipalOnConnection(database, captured.principal.principal, read);
          },
          recoverCommitted: async (_value, cause) => { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_UNAVAILABLE', { cause }); },
          afterRollbackClosed: error => { rollbackClosedError = error; },
        });
        // Authenticate before opening this phase's transaction. Parsing and
        // unrelated authentication must not keep its SQL connection occupied.
        return await (captured.principal.kind === 'request' && requestReadPhase
          ? requestReadPhase(principal => execute(principal)) : execute());
      } catch (error) {
        phaseFailed = true;
        // Keep provenance private until the whole failed factory has unwound.
        // Its poisoned principal is never reused by the fixed Web reader.
        if (error === rollbackClosedError && (error instanceof WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_BUSY'
          || error instanceof WorkspacePathImportPreviewError && error.code === 'PATH_IMPORT_PREVIEW_BUSY')) {
          const busy = error instanceof WorkspacePathImportPreviewError ? error
            : new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_BUSY', { cause: error });
          if (captured.principal.kind === 'request') retryableRequestPreviewReads.add(busy);
          phaseFailure = busy;
        } else {
          phaseFailure = error;
        }
        throw phaseFailure;
      } finally {
        const duration = performance.now() - phaseStarted;
        phaseMs += duration; maxPhaseMs = Math.max(maxPhaseMs, duration);
      }
    };
    await readPhase(async () => undefined);
    // This facade is private to the fixed collector and never reaches a
    // writer, receipt owner or caller. It grants observations, not a reusable
    // connection/transaction authority. Even swallowed collector errors must
    // preserve the original failed authorization/SQL phase below.
    const query = <T>(operation: (database: SqlConnection) => Promise<T>) => readPhase(async database => {
      const started = performance.now();
      try { return await operation(database); }
      finally { sqlMs += performance.now() - started; }
    });
    const readOnly: SqlConnection = {
      get: (sql, values) => query(database => Promise.resolve(database.get(sql, values))),
      all: (sql, values) => query(database => Promise.resolve(database.all(sql, values))),
      run: () => { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_INVALID'); },
      close: () => { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_INVALID'); },
    };
    const correlationId = directMcpCorrelationId();
    const observation = await withWorkspaceSourceScanObserver(measurement => {
      console.info('[source-preview]', JSON.stringify({ ...measurement, correlation_id: correlationId,
        principal_kind: captured.principal.kind, sql_ms: Math.round(sqlMs), authority_phase_ms: Math.round(phaseMs),
        sql_phases: sqlPhases, max_phase_ms: Math.round(maxPhaseMs) }));
    }, () => readWorkspaceLinkSourcePreviewObservation(readOnly, workspace!));
    if (phaseFailed) throw phaseFailure;
    await readPhase(async () => undefined);
    if (requiresWorkspaceLinkSourceAuthorityRevalidation(observation)
      || expected && !isDeepStrictEqual(observation, expected.observation)) {
      throw Object.assign(new WorkspacePreviewStaleError(), { status: 409, code: 'PREVIEW_STALE' });
    }
    if (!observation.privateCatalogue) throw new WorkspacePathSourceIncompleteError(observation.stage.coverage.gaps);
    return { workspace: workspace!, scope: scope!, observation };
  };
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
      ? source.inventory.coverage.gaps.filter(gap => gap.code !== 'uninspected-html'
        && !(gap.code === 'unsupported-target' && typeof gap.raw === 'string' && isWorkspaceExternalMarkdownAutolink(gap.raw))) : []);
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

/** Only the fixed read question may restart, after real rollback/close and
 * factory completion. Every attempt freshly authenticates the original origin.
 * No Apply, mutation callback or already-poisoned principal enters this loop. */
export async function readRequestWorkspacePathImportPreparationPlan(request: NextRequest,
  supplied: Readonly<{ workspaceId: string; kind: Input['kind']; selections: Input['selections'];
    expected: Readonly<{ userId: string; sessionId: string; impersonatedBy: string | null;
      scope: ReturnType<typeof captureWorkspaceOperationJobScope> }> }>
): Promise<WorkspacePathImportPreparationPreviewPlan> {
  const invalid = (): never => { throw new WorkspacePathImportPreviewError('PATH_IMPORT_PREVIEW_INVALID'); };
  if (!(request instanceof NextRequest)) invalid();
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const captured = captureWorkspaceOperationNativePlanData(supplied, invalid, 16 * 1024 * 1024) as typeof supplied;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)
    || Object.keys(captured).length !== 4 || !['workspaceId', 'kind', 'selections', 'expected'].every(key => Object.hasOwn(captured, key))
    || typeof captured.workspaceId !== 'string' || !captured.workspaceId || captured.workspaceId.length > 256
    || captured.workspaceId !== captured.workspaceId.trim() || /[\u0000-\u001f\u007f]/u.test(captured.workspaceId)) invalid();
  const expected = captured.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length !== 4
    || !['userId', 'sessionId', 'impersonatedBy', 'scope'].every(key => Object.hasOwn(expected, key))
    || [expected.userId, expected.sessionId].some(value => typeof value !== 'string' || !value || value.length > 256
      || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
    || expected.impersonatedBy !== null && (typeof expected.impersonatedBy !== 'string' || !expected.impersonatedBy
      || expected.impersonatedBy.length > 256 || expected.impersonatedBy !== expected.impersonatedBy.trim()
      || /[\u0000-\u001f\u007f]/u.test(expected.impersonatedBy))) invalid();
  let expectedScope: ReturnType<typeof parseWorkspaceOperationJobScope>;
  try { expectedScope = parseWorkspaceOperationJobScope(expected.scope); } catch { return invalid(); }
  if (expectedScope.workspaceId !== captured.workspaceId) invalid();
  let origin: WorkspaceRequestHistoricalOrigin | undefined;
  const observe = (current: WorkspaceRequestHistoricalOrigin): void => {
    // Expected history is a comparison bound, never an authority replacement.
    // The genuine factory still validates all current credentials and rights.
    if (current.userId !== expected.userId || current.sessionId !== expected.sessionId
      || current.impersonatedBy !== expected.impersonatedBy
      || Object.entries(expectedScope).some(([key, value]) => key !== 'version' && (Reflect.get(current, key) ?? null) !== value)
      || origin && !isDeepStrictEqual(origin, current)) {
      throw Object.assign(new WorkspacePreviewStaleError(), { status: 409, code: 'PREVIEW_STALE' });
    }
    origin ??= current;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await withWorkspaceRequestPrincipalOriginalOrigin(original, { permission: 'canWrite', workspaceId: captured.workspaceId }, observe,
        principal => readCapturedWorkspacePathImportPreparationPlan(captureWorkspacePathImportPreviewInput({
          principal: { kind: 'request', principal }, kind: captured.kind, selections: captured.selections }),
        read => withWorkspaceRequestPrincipalOriginalOrigin(original,
          { permission: 'canWrite', workspaceId: captured.workspaceId }, observe, read)));
    } catch (error) {
      if (error instanceof WorkspaceRequestPrincipalError
        && (error.code === 'PRINCIPAL_AUTH_REVOKED' || error.code === 'PRINCIPAL_ACCESS_DENIED')) {
        throw Object.assign(error, { status: error.code === 'PRINCIPAL_AUTH_REVOKED' ? 401 : 403 });
      }
      if (!(error instanceof WorkspacePathImportPreviewError) || !retryableRequestPreviewReads.delete(error)
        || !origin || attempt === 2) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }
}
