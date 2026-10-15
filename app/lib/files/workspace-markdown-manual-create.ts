import 'server-only';

import { NextRequest } from 'next/server';
import { recordAuditEvent } from '../audit/audit-service';
import { invalidateWorkspaceFileViews } from '../api/route-helpers';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { classifyCollaborationProjectionError, inCollaborationProjectionPhase } from '../collaboration/projection-errors';
import { logCollaborationDiagnostic } from '../collaboration/diagnostics';
import { assertAuthenticatedManualMarkdownCreateRawRealm, assertAuthenticatedManualMarkdownCreateScope, captureAuthenticatedManualMarkdownCreateScope,
  observeAuthenticatedMarkdownManualCreateCompletion, persistAndProjectAuthenticatedMarkdownManualCreate,
  type ManualMarkdownCreateSelection } from '../collaboration/markdown-file-import-persistence';
import { openDb } from '../db';
import { fileVersionHistoryService } from '../file-version-center/history-service';
import { requireRequestWorkspace, workspaceFileOptions } from '../workspaces/request';
import { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } from '../workspaces/request-principal';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { isInternalWorkspaceStagingPath } from './internal-staging-path';
import type { ManualMarkdownCreateCompletion } from './markdown-create-result';
import { withWorkspaceFileLifecycleGuard } from './workspace-file-lifecycle-guard';
import { MarkdownCreateBirthError } from './markdown-create-birth';

export class MarkdownManualCreateError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = 'MarkdownManualCreateError'; }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const pendingCodes = { projection_pending: 'MARKDOWN_CREATE_PROJECTION_PENDING', recovery_required: 'MARKDOWN_CREATE_RECOVERY_REQUIRED',
  unavailable: 'MARKDOWN_CREATE_NATIVE_UNAVAILABLE' } as const;

/** The request ID is a public lookup, bound inside one workspace to the real
 * actor/session. No request coordinates or stored record confer permission. */
export async function completeManualMarkdownCreate(request: NextRequest, selection: ManualMarkdownCreateSelection): Promise<ManualMarkdownCreateCompletion> {
  if (!(request instanceof NextRequest) || !selection || typeof selection.requestId !== 'string' || !uuid.test(selection.requestId)) {
    throw new MarkdownManualCreateError('MARKDOWN_CREATE_REQUEST_ID_REQUIRED', 400, 'A stable UUID requestId is required to create a Markdown document.');
  }
  if (!isCanonicalAdmissionPath(selection.path) || isInternalWorkspaceStagingPath(selection.path) || !/\.(?:md|markdown)$/iu.test(selection.path)) {
    throw new MarkdownManualCreateError('MARKDOWN_CREATE_INVALID_TARGET', 400, 'A valid Markdown document path is required.');
  }
  const selected = Object.freeze({ workspaceId: selection.workspaceId, path: selection.path, requestId: selection.requestId });
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const current = await requireRequestWorkspace(original, { workspaceId: selected.workspaceId, permissions: 'canWrite' });
  if (current.response) throw new MarkdownManualCreateError('MARKDOWN_CREATE_ACCESS_REQUIRED', current.response.status, 'Current document write permission is required.');
  const result = (status: ManualMarkdownCreateCompletion['status']): ManualMarkdownCreateCompletion => {
    const coordinates = { requestId: selected.requestId, workspaceId: selected.workspaceId, targetPath: selected.path };
    if (status === 'completed') return { ...coordinates, status };
    if (status === 'projection_pending') return { ...coordinates, status, code: pendingCodes.projection_pending };
    if (status === 'unavailable') return { ...coordinates, status, code: pendingCodes.unavailable };
    return { ...coordinates, status: 'recovery_required', code: pendingCodes.recovery_required };
  };
  if (current.workspace.legacy || current.workspace.status !== 'active') return result('unavailable');
  const expectedScope = await captureAuthenticatedManualMarkdownCreateScope(original, selected.workspaceId);
  const dependencies = { openConnection: openDb, expectedRequestScope: expectedScope };
  const observe = () => inCollaborationProjectionPhase('create_observe', () => observeAuthenticatedMarkdownManualCreateCompletion(original, selected, dependencies));
  try {
    const before = await observe();
    if (!authenticatedNativeTextSessionEnabled()) return result(before === 'projection_pending' ? 'projection_pending'
      : before === 'completed' ? 'recovery_required' : 'unavailable');
    if (before !== 'completed') {
      await inCollaborationProjectionPhase('create_native', () => persistAndProjectAuthenticatedMarkdownManualCreate(original, selected, dependencies));
    }
    // Native/Birth and every real Source/Owner/helper descriptor have closed.
    // Reacquire only genuine lifecycle authority for normal Create effects.
    let closeFailure: unknown, hasCloseFailure = false;
    const openVerified = async () => {
      const actual = await openDb();
      try { await assertAuthenticatedManualMarkdownCreateRawRealm(actual, expectedScope); return actual; }
      catch (error) {
        try { await actual.close(new Error('Discarding mismatched manual create effects realm.', { cause: error })); }
        catch (closeError) { throw new AggregateError([error, closeError], 'Manual create effects realm discard failed.'); }
        throw error;
      }
    };
    const openOwner = async () => {
      const actual = await openVerified();
      return { ...actual, close: async (error?: Error) => {
        try { await actual.close(error); } catch (failure) { hasCloseFailure = true; closeFailure = failure; throw failure; }
      } };
    };
    let failure: unknown, hasFailure = false, completion: ManualMarkdownCreateCompletion | undefined;
    try { completion = await inCollaborationProjectionPhase('create_effects', () => withWorkspaceFileLifecycleGuard({ workspaceId: selected.workspaceId, paths: [selected.path] }, async () => {
      if (await observe() !== 'completed') return result('recovery_required');
      await withWorkspaceRequestPrincipal(original, { workspaceId: selected.workspaceId, permission: 'canWrite' }, principal =>
        executeLifecycleTransaction({ openConnection: openVerified,
          execute: async database => {
            await database.run("SELECT set_config('search_path',quote_ident($1)||', pg_catalog, pg_temp',true)", [expectedScope.schema]);
            return withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
            await assertAuthenticatedManualMarkdownCreateScope(database, access, expectedScope);
            await fileVersionHistoryService.capture({ workspace: access.workspace, path: selected.path, content: '', source: 'initial',
              actorUserId: access.userId, actorType: 'user', sourceSessionId: access.sessionId });
            invalidateWorkspaceFileViews({ fileOptions: workspaceFileOptions(access.workspace), fullTree: true,
              mutations: [{ path: selected.path, type: 'add' }] });
            await recordAuditEvent({ organizationId: access.workspace.organizationId, workspaceId: selected.workspaceId,
              userId: access.userId, source: 'files', eventType: 'file', entityType: 'workspace_path', entityId: selected.path,
              action: 'file.create', status: 'success', summary: `file created at ${selected.path}.`,
              metadata: { path: selected.path, type: 'file', template: null, workspaceType: access.workspace.workspaceType, requestId: selected.requestId } });
            await access.assertCurrent();
            await assertAuthenticatedManualMarkdownCreateScope(database, access, expectedScope);
          }); },
          recoverCommitted: async () => { throw new MarkdownManualCreateError('MARKDOWN_CREATE_RECOVERY_REQUIRED', 409, 'The document creation result could not be confirmed.'); },
        }));
      return result(await observe() === 'completed' ? 'completed' : 'recovery_required');
    }, openOwner)); } catch (error) { hasFailure = true; failure = error; }
    if (hasCloseFailure) {
      if (hasFailure) throw new AggregateError([failure, closeFailure], 'Manual create owner closure failed.');
      throw closeFailure;
    }
    if (hasFailure) throw failure;
    return completion!;
  } catch (error) {
    // Preserve a real current denial; uncertainty is never upgraded to success
    // or used to invoke the old raw file writer.
    const stillCurrent = await requireRequestWorkspace(original, { workspaceId: selected.workspaceId, permissions: 'canWrite' });
    if (stillCurrent.response) throw new MarkdownManualCreateError('MARKDOWN_CREATE_ACCESS_REQUIRED', stillCurrent.response.status, 'Current document write permission is required.');
    if (error instanceof MarkdownManualCreateError) throw error;
    if (error instanceof MarkdownCreateBirthError && error.code === 'MARKDOWN_CREATE_BIRTH_MANUAL_PATH_EXISTS') {
      throw new MarkdownManualCreateError('PATH_EXISTS', 409, 'A file or folder already exists at this path.');
    }
    const diagnostic = classifyCollaborationProjectionError(error);
    logCollaborationDiagnostic('warn', { event: 'projection_recovery_failed', phase: `manual_create:${diagnostic.phase}`, code: diagnostic.code,
      causeCode: diagnostic.causeCode, permanent: diagnostic.permanent });
    let observed: 'absent' | 'projection_pending' | 'completed' | undefined;
    try { observed = await observe(); } catch { /* Retain the public attempt for explicit recovery. */ }
    return result(observed === 'projection_pending' ? 'projection_pending' : 'recovery_required');
  }
}
