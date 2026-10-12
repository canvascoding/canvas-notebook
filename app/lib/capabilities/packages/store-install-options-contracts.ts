import { z } from 'zod';
import type { OrganizationPolicyTargetCatalog } from '@/app/lib/organization/policy-targets';
import type { CapabilityResourceOwnerScope } from '../resources/contracts';
import { capabilityPackageOwnershipSchema } from './schemas';
import { capabilityPackageStoreSelectionSchema, type CapabilityPackageStoreSelection } from './store-contracts';

export const capabilityPackageStoreInstallOptionsSchema = z.object({
  source: capabilityPackageStoreSelectionSchema,
  ownership: capabilityPackageOwnershipSchema,
}).strict();

export type CapabilityPackageStoreInstallOptionsRequest = z.infer<typeof capabilityPackageStoreInstallOptionsSchema>;
export type CapabilityPackageStoreInstallOptions = {
  schemaVersion: 1;
  /** The requested source remains a selection; installation verifies the configured Store separately. */
  source: CapabilityPackageStoreSelection;
  ownership: Exclude<CapabilityResourceOwnerScope, { type: 'system' }>;
  ownershipLabel: string;
  targets: OrganizationPolicyTargetCatalog;
};
