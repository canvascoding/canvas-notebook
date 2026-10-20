// Pure server-diagnostic projection only. These labels grant no authority and
// must never replace the original error or determine a public status/retry.
const fixedCodes = [
  // WorkspaceOperationJobLifecycleError / WorkspaceRequestPrincipalError.
  'JOB_LIFECYCLE_REQUIRED', 'JOB_LIFECYCLE_INVALID', 'JOB_LIFECYCLE_REENTRANT', 'JOB_LIFECYCLE_CHANGED',
  'JOB_LIFECYCLE_DETACHED', 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED', 'JOB_LIFECYCLE_DISPOSAL_UNCONFIRMED',
  'PRINCIPAL_REQUIRED', 'PRINCIPAL_INVALID', 'PRINCIPAL_BUSY', 'PRINCIPAL_SCOPE_CHANGED', 'PRINCIPAL_AUTH_REVOKED',
  'PRINCIPAL_ACCESS_DENIED', 'PRINCIPAL_WORKSPACE_UNCONFIRMED', 'PRINCIPAL_TOO_LARGE', 'PRINCIPAL_DETACHED',
  'PRINCIPAL_REENTRANT', 'PRINCIPAL_SCHEMA_INVALID', 'PRINCIPAL_EXPIRED',
  // Fixed implicit preparation / admission labels; payload and paths stay private.
  'IMPLICIT_MOVE_PHASE_CHANGED', 'IMPLICIT_MOVE_SELECTION_CHANGED', 'IMPLICIT_MOVE_HISTORY_CHANGED',
  'IMPLICIT_MOVE_OUTCOME_UNCONFIRMED', 'IMPLICIT_MOVE_HISTORY_UNCONFIRMED',
  'ADMISSION_INVALID_REQUEST', 'ADMISSION_REQUEST_CHANGED', 'ADMISSION_SCOPE_CHANGED',
  'ADMISSION_STATE_CHANGED', 'ADMISSION_RECOVERY_REQUIRED', 'ADMISSION_CONFLICT',
  'NATIVE_MOVE_PLAN_CHANGED', 'NATIVE_MOVE_PLAN_UNSUPPORTED',
  'NATIVE_MOVE_PLAN_INVALID', 'NATIVE_MOVE_PLAN_TOO_LARGE',
  'NATIVE_SOURCE_EVIDENCE_INVALID', 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE',
  'NATIVE_SOURCE_IMPORT_REQUIRED', 'NATIVE_SOURCE_EVIDENCE_CHANGED',
  // Original Delete/native/link DAL and existing lifecycle/room/kernel errors.
  'ORIGINAL_DELETE_INVALID', 'ORIGINAL_DELETE_CHANGED', 'ORIGINAL_DELETE_BUSY', 'ORIGINAL_DELETE_UNSUPPORTED',
  'ORIGINAL_DELETE_UNPROVEN', 'ORIGINAL_DELETE_POSTCONDITION',
  'ORIGINAL_NATIVE_DELETE_INVALID', 'ORIGINAL_NATIVE_DELETE_CHANGED', 'ORIGINAL_NATIVE_DELETE_BUSY',
  'ORIGINAL_NATIVE_DELETE_TOO_LARGE', 'ORIGINAL_NATIVE_DELETE_POSTCONDITION',
  'NATIVE_LINK_INVALID_PREPARED', 'NATIVE_LINK_SOURCE_CHANGED', 'NATIVE_LINK_REQUEST_CONFLICT',
  'NATIVE_LINK_MUTATION_BUSY', 'NATIVE_LINK_COMMIT_UNCONFIRMED',
  'COLLABORATION_FILE_LIFECYCLE_BUSY', 'ROOM_OWNER_BUSY', 'ROOM_OWNER_LOST', 'ROOM_OWNER_SCOPE_CHANGED', 'ROOM_OWNER_UNAVAILABLE',
  'FILE_MUTATION_LOCK_TIMEOUT', 'FILE_MUTATION_LOCK_BUSY', 'FILE_MUTATION_LOCK_UNAVAILABLE',
  'FILE_LIFECYCLE_SOURCE_INVALID', 'FILE_LIFECYCLE_SOURCE_DETACHED', 'FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED',
] as const;
const aliases = {
  '25P04': 'SQLSTATE_25P04', '57014': 'SQLSTATE_57014', '55P03': 'SQLSTATE_55P03',
  '08003': 'SQLSTATE_08003', '08006': 'SQLSTATE_08006', '57P01': 'SQLSTATE_57P01',
  postgres_unavailable: 'DATABASE_UNAVAILABLE',
  // PreparedSingleFileTrashError's finite codes; never its paths or messages.
  'invalid-input': 'FILESYSTEM_INVALID_INPUT', 'invalid-lifetime': 'FILESYSTEM_INVALID_LIFETIME',
  'reentrant-operation': 'FILESYSTEM_REENTRANT_OPERATION', 'already-moved': 'FILESYSTEM_ALREADY_MOVED',
  'scope-changed': 'FILESYSTEM_SCOPE_CHANGED', 'unsafe-path': 'FILESYSTEM_UNSAFE_PATH',
  'source-changed': 'FILESYSTEM_SOURCE_CHANGED', 'destination-occupied': 'FILESYSTEM_DESTINATION_OCCUPIED',
  'unawaited-operation': 'FILESYSTEM_UNAWAITED_OPERATION', 'cross-device-move': 'FILESYSTEM_CROSS_DEVICE_MOVE',
  'move-unconfirmed': 'FILESYSTEM_MOVE_UNCONFIRMED', 'recovery-conflict': 'FILESYSTEM_RECOVERY_CONFLICT',
  'disposal-unconfirmed': 'FILESYSTEM_DISPOSAL_UNCONFIRMED',
} as const;
export type WorkspaceOperationFailureDiagnosticCode = typeof fixedCodes[number]
  | typeof aliases[keyof typeof aliases] | 'UNCLASSIFIED';
export type WorkspaceOperationFailureDiagnosticNode = Readonly<{
  code: WorkspaceOperationFailureDiagnosticCode;
  cause?: WorkspaceOperationFailureDiagnosticNode;
  errors?: readonly WorkspaceOperationFailureDiagnosticNode[];
}>;
export type WorkspaceOperationFailureDiagnostics = Readonly<{
  version: 1; tree: WorkspaceOperationFailureDiagnosticNode | null; truncated: boolean;
}>;
const allowed = new Set<string>(fixedCodes), maximumNodes = 16, maximumDepth = 4;
const unclassified: WorkspaceOperationFailureDiagnosticNode = Object.freeze({ code: 'UNCLASSIFIED' });
const unavailable: WorkspaceOperationFailureDiagnostics = Object.freeze({ version: 1, tree: unclassified, truncated: true });

/** A bounded code tree from own data descriptors only. Never reads name,
 * message, stack, iterator, toString, SQL, IDs, paths or caller-defined getters.
 * Proxy descriptor traps can reject inspection; they cannot escape this helper. */
export function workspaceOperationFailureDiagnostics(error: unknown): WorkspaceOperationFailureDiagnostics {
  try {
    const seen = new WeakSet<object>();
    let count = 0, truncated = false;
    const ownData = (value: object, name: string): { present: boolean; value?: unknown } => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor) return { present: false };
        if (!Object.hasOwn(descriptor, 'value')) { truncated = true; return { present: false }; }
        return { present: true, value: descriptor.value };
      } catch { truncated = true; return { present: false }; }
    };
    const visit = (value: unknown, depth: number): WorkspaceOperationFailureDiagnosticNode | null => {
      if (count >= maximumNodes || depth > maximumDepth) { truncated = true; return null; }
      if (!value || typeof value !== 'object') { count++; return unclassified; }
      if (seen.has(value)) { truncated = true; return null; }
      seen.add(value); count++;
      const ownCode = ownData(value, 'code').value;
      const code: WorkspaceOperationFailureDiagnosticCode = typeof ownCode !== 'string' ? 'UNCLASSIFIED'
        : allowed.has(ownCode) ? ownCode as typeof fixedCodes[number]
          : Object.hasOwn(aliases, ownCode) ? aliases[ownCode as keyof typeof aliases] : 'UNCLASSIFIED';
      const node: { code: WorkspaceOperationFailureDiagnosticCode; cause?: WorkspaceOperationFailureDiagnosticNode;
        errors?: readonly WorkspaceOperationFailureDiagnosticNode[] } = { code };
      // Prefer the primary causal chain before secondary aggregate cleanup.
      const cause = ownData(value, 'cause');
      if (cause.present) { const child = visit(cause.value, depth + 1); if (child) node.cause = child; }
      const aggregate = ownData(value, 'errors').value;
      let isArray = false;
      try { isArray = Array.isArray(aggregate); } catch { truncated = true; }
      if (isArray) {
        const length = ownData(aggregate as object, 'length').value;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) truncated = true;
        else {
          const children: WorkspaceOperationFailureDiagnosticNode[] = [];
          if (length > maximumNodes) truncated = true;
          for (let index = 0; index < Math.min(length, maximumNodes); index++) {
            if (count >= maximumNodes) { truncated = true; break; }
            const item = ownData(aggregate as object, String(index));
            if (!item.present) continue;
            const child = visit(item.value, depth + 1); if (child) children.push(child);
          }
          if (children.length) node.errors = Object.freeze(children);
        }
      }
      return Object.freeze(node);
    };
    return Object.freeze({ version: 1, tree: visit(error, 0), truncated });
  } catch { return unavailable; }
}

/** Synchronous diagnostic sink only. A broken logger cannot mask the failure. */
export function reportWorkspaceOperationFailureDiagnostics(error: unknown,
  emit: (diagnostic: WorkspaceOperationFailureDiagnostics) => void): void {
  try { emit(workspaceOperationFailureDiagnostics(error)); } catch { /* Preserve the caller's original error. */ }
}
