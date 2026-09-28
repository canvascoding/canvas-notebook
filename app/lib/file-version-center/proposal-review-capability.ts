import 'server-only';

export type ProposalReviewCapabilityMode = 'off' | 'canary' | 'full' | 'local_test';

export type ProposalReviewCapabilityReason =
  | 'enabled'
  | 'mode_unset'
  | 'explicitly_off'
  | 'invalid_mode'
  | 'invalid_allowlist'
  | 'invalid_workspace'
  | 'workspace_not_allowlisted'
  | 'local_test_environment_required';

export interface ProposalReviewCapability {
  mode: ProposalReviewCapabilityMode;
  enabled: boolean;
  reason: ProposalReviewCapabilityReason;
}

const MAX_ALLOWLIST_LENGTH = 32_768;
const MAX_ALLOWLIST_ENTRIES = 256;
const STABLE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isValidWorkspaceId(workspaceId: unknown): workspaceId is string {
  return typeof workspaceId === 'string' && STABLE_WORKSPACE_ID.test(workspaceId);
}

function parseWorkspaceAllowlist(value: string): Set<string> | null {
  if (value.length > MAX_ALLOWLIST_LENGTH) return null;

  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.length > MAX_ALLOWLIST_ENTRIES) return null;
  if (entries.some((entry) => !isValidWorkspaceId(entry))) return null;

  return new Set(entries);
}

/**
 * Resolve the server-side proposal review write policy without exposing workspace IDs or env values.
 * This is a feature gate only; callers must still perform their normal authorization checks.
 */
export function resolveProposalReviewCapability(options?: { workspaceId?: string }): ProposalReviewCapability {
  const configuredMode = process.env.CANVAS_PROPOSAL_GRAPH_MODE;
  const configuredAllowlist = process.env.CANVAS_PROPOSAL_GRAPH_WORKSPACE_IDS;
  const workspaceId = options?.workspaceId;

  let allowlist: Set<string> | undefined;
  if (configuredAllowlist !== undefined) {
    const parsedAllowlist = parseWorkspaceAllowlist(configuredAllowlist);
    if (!parsedAllowlist) {
      return { mode: 'off', enabled: false, reason: 'invalid_allowlist' };
    }
    allowlist = parsedAllowlist;
  }

  if (configuredMode !== undefined) {
    if (configuredMode !== 'off' && configuredMode !== 'canary' && configuredMode !== 'full') {
      return { mode: 'off', enabled: false, reason: 'invalid_mode' };
    }
    if (configuredMode === 'off') {
      return { mode: 'off', enabled: false, reason: 'explicitly_off' };
    }
    if (!isValidWorkspaceId(workspaceId)) {
      return { mode: configuredMode, enabled: false, reason: 'invalid_workspace' };
    }
    if (configuredMode === 'canary' && !allowlist?.has(workspaceId)) {
      return { mode: 'canary', enabled: false, reason: 'workspace_not_allowlisted' };
    }
    return { mode: configuredMode, enabled: true, reason: 'enabled' };
  }

  if (process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST === '1') {
    if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
      return { mode: 'off', enabled: false, reason: 'local_test_environment_required' };
    }
    if (!isValidWorkspaceId(workspaceId)) {
      return { mode: 'local_test', enabled: false, reason: 'invalid_workspace' };
    }
    return { mode: 'local_test', enabled: true, reason: 'enabled' };
  }

  return { mode: 'off', enabled: false, reason: 'mode_unset' };
}

/** Production rollout stays closed unless the central workspace-scoped policy enables it. */
export function proposalReviewWritesEnabled(options?: { workspaceId: string }): boolean {
  return resolveProposalReviewCapability(options).enabled;
}
