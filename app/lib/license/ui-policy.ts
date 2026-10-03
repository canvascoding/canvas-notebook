export function licenseHostingVariant(status: {
  runtimeDeploymentMode?: string | null;
  hostingMode?: string | null;
  deploymentMode?: string | null;
  plan?: string;
} | null): 'managed' | 'self-hosted' | null {
  if (!status) return null;
  const mode = (status.runtimeDeploymentMode ?? status.deploymentMode)?.trim().toLowerCase().replaceAll('_', '-');
  if (status.runtimeDeploymentMode) return mode?.startsWith('managed-') ? 'managed' : 'self-hosted';
  if (!status.hostingMode && !status.plan && !mode) return null;
  return status.hostingMode === 'cloud' || status.plan === 'managed' || mode?.startsWith('managed-')
    ? 'managed' : 'self-hosted';
}

export function isTeamLicenseApplicable(status: {
  runtimeDeploymentMode?: string | null;
  edition?: string | null;
  capabilities?: Record<string, boolean>;
  features?: Record<string, boolean>;
} | null): boolean {
  if (!status) return false;
  return status.edition === 'team'
    || (status.capabilities?.multiUser === true && status.capabilities?.teamWorkspace === true)
    || (status.features?.multiUser === true && status.features?.teamWorkspace === true)
    || status.runtimeDeploymentMode?.trim().toLowerCase().replaceAll('_', '-') === 'managed-team';
}

export function teamHealthAttentionReason(health: TeamSeatHealth, now = Date.now()):
  'restricted' | 'grace' | 'capacity' | 'expiring' | 'sync' | 'email' | null {
  if (health.managedAccessPolicy?.state === 'restricted'
    || ['restricted', 'expired', 'revoked'].includes(health.grace.licenseState)) return 'restricted';
  if (health.managedAccessPolicy?.state === 'grace'
    || ['grace', 'grace_required'].includes(health.grace.licenseState)) return 'grace';
  if (health.sync.licensedQuantity !== null && health.sync.licensedQuantity > 0
    && health.sync.observedQuantity !== null
    && health.sync.observedQuantity >= health.sync.licensedQuantity) return 'capacity';
  const termEnd = health.license.termEndsAt ? Date.parse(health.license.termEndsAt) : NaN;
  if (Number.isFinite(termEnd) && termEnd - now <= 30 * 24 * 60 * 60 * 1000) return 'expiring';
  if (health.sync.state !== 'healthy' || health.sync.blocker || health.sync.lastError
    || health.sync.failedOperations > 0 || health.sync.supportRequired || health.recovery.reconnectRequired
    || (health.mode === 'managed-team' && health.sync.managedState !== 'current')) return 'sync';
  if ((health.emailDelivery?.manualReview ?? 0) > 0) return 'email';
  return null;
}
import type { TeamSeatHealth } from './team-seat-health-types';
