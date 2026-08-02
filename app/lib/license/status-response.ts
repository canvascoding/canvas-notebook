import type { LicenseStatus } from './types';

export type PublicLicenseStatus = Pick<
  LicenseStatus,
  | 'licensed'
  | 'plan'
  | 'instanceId'
  | 'licenseState'
  | 'hostingMode'
  | 'edition'
  | 'deploymentMode'
  | 'databaseProvider'
  | 'vectorProvider'
  | 'postgresRequired'
  | 'capabilities'
  | 'expiresAt'
  | 'features'
  | 'error'
> & {
  code: string;
};

/**
 * Browser-safe license status shared by public onboarding and authenticated UI.
 *
 * Administrative certificate claims deliberately stay out of this payload.
 * Organization owners receive the subset they need through the separately
 * permission-checked Team Seat health response.
 */
export function publicLicenseStatus(
  status: LicenseStatus,
  code: string,
): PublicLicenseStatus {
  return {
    licensed: status.licensed,
    plan: status.plan,
    instanceId: status.instanceId,
    licenseState: status.licenseState,
    hostingMode: status.hostingMode,
    edition: status.edition,
    deploymentMode: status.deploymentMode,
    databaseProvider: status.databaseProvider,
    vectorProvider: status.vectorProvider,
    postgresRequired: status.postgresRequired,
    capabilities: status.capabilities,
    expiresAt: status.expiresAt,
    features: status.features,
    error: status.error,
    code,
  };
}
