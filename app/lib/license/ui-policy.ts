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

export function isLicenseUiStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  if (status.success !== true || typeof status.licensed !== 'boolean'
    || typeof status.plan !== 'string' || !status.plan.trim()
    || typeof status.instanceId !== 'string' || !status.instanceId.trim()
    || status.error === 'license_status_unavailable') return false;
  for (const field of ['runtimeDeploymentMode', 'hostingMode', 'deploymentMode'] as const) {
    if (status[field] != null && typeof status[field] !== 'string') return false;
  }
  if (licenseHostingVariant(status as Parameters<typeof licenseHostingVariant>[0]) === null) return false;
  if (status.expiresAt != null && (typeof status.expiresAt !== 'string' || !Number.isFinite(Date.parse(status.expiresAt)))) return false;
  if (status.teamSeatHealth != null) {
    if (typeof status.teamSeatHealth !== 'object' || Array.isArray(status.teamSeatHealth)) return false;
    const health = status.teamSeatHealth as Record<string, unknown>;
    if (!['license', 'sync', 'claim', 'grace', 'recovery'].every((field) =>
      health[field] && typeof health[field] === 'object' && !Array.isArray(health[field]))) return false;
  }
  return true;
}
import type { TeamSeatHealth } from './team-seat-health-types';
