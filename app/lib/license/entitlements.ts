import 'server-only';

import { getLicenseStatus } from './index';
import type { LicensePlan, LicenseStatus } from './types';
import {
  capabilitiesFromFeatures,
  resolveNotebookRuntimeProfile,
  type NotebookDatabaseProvider,
  type NotebookRuntimeCapabilityKey,
  type NotebookVectorProvider,
} from '@/app/lib/runtime/notebook-runtime';

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

function licenseCapabilities(status: LicenseStatus) {
  const inferred = capabilitiesFromFeatures(status.features);
  return {
    multiUser: status.capabilities.multiUser ?? inferred.multiUser,
    teamWorkspace: status.capabilities.teamWorkspace ?? inferred.teamWorkspace,
    vectorSearch: status.capabilities.vectorSearch ?? inferred.vectorSearch,
    liveCollaboration: status.capabilities.liveCollaboration ?? inferred.liveCollaboration,
  };
}

function licenseDatabaseProvider(status: LicenseStatus): NotebookDatabaseProvider | null {
  return status.databaseProvider === 'sqlite' || status.databaseProvider === 'postgres' ? status.databaseProvider : null;
}

function licenseVectorProvider(status: LicenseStatus): NotebookVectorProvider | null {
  if (status.vectorProvider === 'none' || status.vectorProvider === 'pgvector' || status.vectorProvider === 'external') {
    return status.vectorProvider;
  }
  return null;
}

function licenseRuntimeProfile(status: LicenseStatus) {
  return resolveNotebookRuntimeProfile({
    deploymentMode: status.deploymentMode,
    databaseProvider: licenseDatabaseProvider(status),
    vectorProvider: licenseVectorProvider(status),
    postgresRequired: status.postgresRequired,
    capabilities: licenseCapabilities(status),
  });
}

function assertRuntimeCapability(status: LicenseStatus, capability: NotebookRuntimeCapabilityKey): void {
  const capabilities = licenseCapabilities(status);
  if (capabilities[capability] !== true) {
    throw new LicenseEntitlementError(
      'License does not include required runtime capability',
      'LICENSE_FEATURE_REQUIRED',
      403,
      {
        feature: capability,
        plan: status.plan,
        deploymentMode: status.deploymentMode,
        databaseProvider: status.databaseProvider,
        vectorProvider: status.vectorProvider,
        postgresRequired: status.postgresRequired,
      },
    );
  }
}

export async function requireRuntimeCapability(capability: NotebookRuntimeCapabilityKey): Promise<LicenseStatus> {
  const status = await requireLicensed();
  assertRuntimeCapability(status, capability);
  return status;
}

export async function requireDatabaseProvider(provider: NotebookDatabaseProvider): Promise<LicenseStatus> {
  const status = await requireLicensed();
  if (licenseDatabaseProvider(status) !== provider) {
    throw new LicenseEntitlementError(
      'License does not include required database provider',
      'LICENSE_FEATURE_REQUIRED',
      403,
      {
        provider,
        plan: status.plan,
        deploymentMode: status.deploymentMode,
        databaseProvider: status.databaseProvider,
        postgresRequired: status.postgresRequired,
      },
    );
  }
  return status;
}

export async function requireVectorProvider(provider: NotebookVectorProvider): Promise<LicenseStatus> {
  const status = await requireLicensed();
  if (licenseVectorProvider(status) !== provider) {
    throw new LicenseEntitlementError(
      'License does not include required vector provider',
      'LICENSE_FEATURE_REQUIRED',
      403,
      {
        provider,
        plan: status.plan,
        deploymentMode: status.deploymentMode,
        databaseProvider: status.databaseProvider,
        vectorProvider: status.vectorProvider,
      },
    );
  }
  return status;
}

export async function requireTeamRuntimeLicense(): Promise<LicenseStatus> {
  const status = await requireLicensed();
  assertRuntimeCapability(status, 'teamWorkspace');
  assertRuntimeCapability(status, 'multiUser');
  const profile = licenseRuntimeProfile(status);

  if (profile.databaseProvider !== 'postgres' || profile.compatible !== true) {
    throw new LicenseEntitlementError(
      'License does not include Team runtime',
      'LICENSE_FEATURE_REQUIRED',
      403,
      {
        feature: 'teamWorkspace',
        plan: status.plan,
        deploymentMode: status.deploymentMode,
        databaseProvider: status.databaseProvider,
        vectorProvider: status.vectorProvider,
        postgresRequired: status.postgresRequired,
        blockers: profile.blockers.map((blocker) => blocker.code),
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
