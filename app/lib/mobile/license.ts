import 'server-only';

import { codeFromLicenseStatus } from '@/app/lib/license/error-codes';
import type { LicenseStatus } from '@/app/lib/license/types';
import { createPublicMobileInstanceId } from './compatibility';

export type MobileLicenseStatus = {
  success: true;
  instanceId: string;
  licensed: boolean;
  plan: LicenseStatus['plan'];
  source: LicenseStatus['source'];
  licenseState: LicenseStatus['licenseState'];
  hostingMode: LicenseStatus['hostingMode'];
  edition: LicenseStatus['edition'];
  seatLimit: LicenseStatus['seatLimit'];
  deploymentMode: string | null;
  expiresAt: string | null;
  graceExpiresAt: string | null;
  capabilities: Record<string, boolean>;
  features: Record<string, boolean>;
  refresh: Pick<NonNullable<LicenseStatus['refresh']>, 'phase' | 'lastSuccessAt' | 'nextAttemptAt' | 'lastErrorCode'> | null;
  code: string;
  activation: {
    mode: 'managed' | 'community';
    canManage: boolean;
    canRequestKey: boolean;
    canActivateKey: boolean;
  };
};

export function mobileLicenseStatus(input: {
  status: LicenseStatus;
  canManage: boolean;
  managedConfigured: boolean;
}): MobileLicenseStatus {
  return {
    success: true,
    instanceId: createPublicMobileInstanceId(input.status.instanceId),
    licensed: input.status.licensed,
    plan: input.status.plan,
    source: input.status.source,
    licenseState: input.status.licenseState,
    hostingMode: input.status.hostingMode,
    edition: input.status.edition,
    seatLimit: input.status.seatLimit,
    deploymentMode: input.status.deploymentMode,
    expiresAt: input.status.expiresAt,
    graceExpiresAt: input.status.graceExpiresAt,
    capabilities: input.status.capabilities,
    features: input.status.features,
    refresh: input.status.refresh
      ? {
        phase: input.status.refresh.phase,
        lastSuccessAt: input.status.refresh.lastSuccessAt,
        nextAttemptAt: input.status.refresh.nextAttemptAt,
        lastErrorCode: input.status.refresh.lastErrorCode,
      }
      : null,
    code: codeFromLicenseStatus(input.status),
    activation: {
      mode: input.managedConfigured ? 'managed' : 'community',
      canManage: input.canManage,
      canRequestKey: input.canManage && !input.managedConfigured && !input.status.licensed,
      canActivateKey: input.canManage,
    },
  };
}
