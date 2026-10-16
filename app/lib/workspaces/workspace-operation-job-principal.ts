import 'server-only';

/** Fixed same-connection durable-job policy adapter. This exports neither a
 * generic actor/permission adapter nor SQL, session or lifecycle ownership.
 * Capture a fresh policy outside each transaction; the genuine owner-B caller
 * must await the complete phase, rollback on failure and confirm COMMIT. */
export { captureWorkspaceOperationJobPolicy, withWorkspaceOperationJobPolicyOnConnection,
  type WorkspaceOperationJobPolicy, type WorkspaceOperationJobPolicyAccess } from './request-principal';
