import 'server-only';

import { getLicenseStatus } from './index';
import type { LicensePlan, LicenseStatus } from './types';

export type LicenseEntitlementErrorCode =
  | 'LICENSE_REQUIRED'
  | 'LICENSE_FEATURE_REQUIRED'
  | 'LICENSE_PLAN_REQUIRED'
  | 'LICENSE_QUOTA_REQUIRED';

export class LicenseEntitlementError extends Error {
  constructor(
    message: string,
    public readonly code: LicenseEntitlementErrorCode,
    public readonly statusCode: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LicenseEntitlementError';
  }
}

export async function requireLicensed(): Promise<LicenseStatus> {
  const status = await getLicenseStatus();
  if (!status.licensed) {
    throw new LicenseEntitlementError(
      'License activation required',
      'LICENSE_REQUIRED',
      402,
      { plan: status.plan, source: status.source, error: status.error },
    );
  }
  return status;
}

export async function requireLicensePlan(plans: LicensePlan[]): Promise<LicenseStatus> {
  const status = await requireLicensed();
  if (!plans.includes(status.plan)) {
    throw new LicenseEntitlementError(
      'License plan does not include this feature',
      'LICENSE_PLAN_REQUIRED',
      403,
      { requiredPlans: plans, plan: status.plan },
    );
  }
  return status;
}

export async function requireLicenseFeature(feature: string): Promise<LicenseStatus> {
  const normalized = feature.trim();
  if (!normalized) {
    throw new LicenseEntitlementError(
      'License feature is required',
      'LICENSE_FEATURE_REQUIRED',
      403,
    );
  }

  const status = await requireLicensed();
  if (status.features[normalized] !== true) {
    throw new LicenseEntitlementError(
      'License feature is not enabled',
      'LICENSE_FEATURE_REQUIRED',
      403,
      { feature: normalized, plan: status.plan },
    );
  }
  return status;
}

export async function requireTeamRuntimeLicense(): Promise<LicenseStatus> {
  const status = await requireLicensed();
  const teamFeatureEnabled = status.features.teamWorkspace === true || status.features.multiUser === true;
  const postgresRuntimeEnabled = status.databaseProvider === 'postgres' ||
    status.postgresRequired === true ||
    status.deploymentMode === 'managed-team' ||
    status.deploymentMode === 'enterprise-onprem';

  if (!teamFeatureEnabled || !postgresRuntimeEnabled) {
    throw new LicenseEntitlementError(
      'License does not include Team runtime',
      'LICENSE_FEATURE_REQUIRED',
      403,
      {
        feature: 'teamWorkspace',
        plan: status.plan,
        deploymentMode: status.deploymentMode,
        databaseProvider: status.databaseProvider,
        postgresRequired: status.postgresRequired,
      },
    );
  }

  return status;
}

export async function requireLicenseQuota(quota: string, minimum: number): Promise<LicenseStatus> {
  const normalized = quota.trim();
  const required = Math.max(0, Math.floor(minimum));
  if (!normalized) {
    throw new LicenseEntitlementError(
      'License quota is required',
      'LICENSE_QUOTA_REQUIRED',
      403,
    );
  }

  const status = await requireLicensed();
  const allowed = status.quotas[normalized];
  if (typeof allowed !== 'number' || allowed < required) {
    throw new LicenseEntitlementError(
      'License quota is not sufficient',
      'LICENSE_QUOTA_REQUIRED',
      403,
      { quota: normalized, required, allowed: allowed ?? null, plan: status.plan },
    );
  }
  return status;
}

export function licenseEntitlementErrorPayload(error: LicenseEntitlementError) {
  return {
    success: false,
    error: error.message,
    code: error.code,
    ...error.details,
  };
}
