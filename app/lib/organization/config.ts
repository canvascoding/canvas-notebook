export { LOCAL_ORGANIZATION_ID_PREFIX } from './contracts';

function isTruthyEnv(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function normalizeDeploymentMode(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

export function getConfiguredOrganizationId(): string | null {
  const value = process.env.CANVAS_ORGANIZATION_ID?.trim();
  return value || null;
}

export function getDeploymentMode(): string {
  const explicit = process.env.CANVAS_DEPLOYMENT_MODE?.trim();
  if (explicit) return explicit;
  if (process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' || process.env.CANVAS_INSTANCE_TOKEN?.trim()) {
    return 'managed-single';
  }
  return 'single_user';
}

export function isSingleUserDeploymentMode(deploymentMode = getDeploymentMode()): boolean {
  const normalized = normalizeDeploymentMode(deploymentMode);
  return normalized === 'community' || normalized === 'single-user' || normalized === 'singleuser' || normalized === 'managed-single' || normalized === 'local' || normalized === 'development' || normalized === 'dev';
}

export function isTeamDeploymentMode(deploymentMode = getDeploymentMode()): boolean {
  const normalized = normalizeDeploymentMode(deploymentMode);
  if (isSingleUserDeploymentMode(normalized)) return false;
  return normalized.includes('team') || normalized.includes('enterprise') || normalized.includes('advanced');
}

export function canEnableTeamFeaturesForDeployment(deploymentMode = getDeploymentMode()): boolean {
  return !isSingleUserDeploymentMode(deploymentMode);
}

export function areTeamFeaturesEnabled(deploymentMode = getDeploymentMode()): boolean {
  if (!canEnableTeamFeaturesForDeployment(deploymentMode)) return false;
  return isTruthyEnv(process.env.CANVAS_TEAM_FEATURES_ENABLED) || isTeamDeploymentMode(deploymentMode);
}
