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
  deploymentMode: string | null;
  expiresAt: string | null;
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
    deploymentMode: input.status.deploymentMode,
    expiresAt: input.status.expiresAt,
    code: codeFromLicenseStatus(input.status),
    activation: {
      mode: input.managedConfigured ? 'managed' : 'community',
      canManage: input.canManage,
      canRequestKey: input.canManage && !input.managedConfigured && !input.status.licensed,
      canActivateKey: input.canManage,
    },
  };
}
