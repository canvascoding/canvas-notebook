import { z } from 'zod';
import { extensionPackagePinSchema, type ExtensionPackagePin } from '../extensions/contracts';
import type { CapabilityPolicyEffect, CapabilityPolicyTargetType, CapabilityReadiness } from '../types';

const identity = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value));
export const capabilityPackageUseAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('users'), userIds: z.array(identity).max(100).refine(value => new Set(value).size === value.length) }).strict(),
  z.object({ kind: z.literal('organization') }).strict(),
]);
export type CapabilityPackageUseAudience = z.infer<typeof capabilityPackageUseAudienceSchema>;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const expected = { expectedMetadataRevision: revision, expectedGrantsRevision: revision, expectedPackageRevision: revision,
  expectedPublishedRevisionRef: extensionPackagePinSchema.shape.publishedRevisionRef, expectedDefaultEnabled: z.boolean() };
export const capabilityPackageProvisioningQuerySchema = extensionPackagePinSchema.omit({ resourceRef: true });
export const capabilityPackageProvisioningRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('set_use_audience'), pin: extensionPackagePinSchema, ...expected, audience: capabilityPackageUseAudienceSchema }).strict(),
  z.object({ operation: z.literal('activate'), pin: extensionPackagePinSchema, ...expected }).strict(),
  z.object({ operation: z.literal('enable_for_me'), pin: extensionPackagePinSchema, ...expected, expectedPersonalActivationRevision: revision }).strict(),
]);
export type CapabilityPackageProvisioning = {
  schemaVersion: 1; pin: ExtensionPackagePin; kind: 'plugin' | 'skill'; name: string; version: string;
  ownership: { type: 'organization'; organizationId: string };
  currentHead: { packageRevision: number; publishedRevisionRef: string; matchesPin: boolean };
  expected: z.infer<z.ZodObject<typeof expected>>;
  defaultEnabled: boolean;
  personalActivation: { resourceId: string; revision: number; enabled: boolean | null };
  audience: CapabilityPackageUseAudience;
  otherUseTargets: Array<{ targetType: Exclude<CapabilityPolicyTargetType, 'user'>; targetId: string }>;
  targets: { users: Array<{userId: string; name: string | null; email: string | null; role: string}> };
  /** Current actor observation; neither this status nor activation grants another user's Use or provider readiness. */
  policy: { canUse: boolean; effectivePolicy: CapabilityPolicyEffect; enabled: boolean; readiness: CapabilityReadiness | 'unknown'; blockedReason: string | null };
};
