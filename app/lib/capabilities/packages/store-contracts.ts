import { z } from 'zod';
import { capabilityPackageOwnershipSchema } from './schemas';
import type { CapabilityPackagePublishedSummary, CapabilityPackageState } from './contracts';
import type { CapabilityResourceMetadata } from '../resources/contracts';

const boundedText = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const checksum = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const publishedRef = z.string().regex(/^canvas-package-revision:[a-f0-9-]{36}$/u);
export const capabilityPackageStoreSelectionSchema = z.object({
  kind: z.enum(['plugin', 'skill']), registryId: boundedText(256), entryKey: boundedText(64),
  version: boundedText(200), checksum,
}).strict();
const grant = z.object({ targetType: z.enum(['organization', 'role', 'workspace', 'project', 'user']),
  targetId: boundedText(200), canUse: z.boolean(), canEdit: z.boolean(), canManage: z.boolean() }).strict();

export const capabilityPackageStoreListSchema = z.object({ kind: z.enum(['plugin', 'skill']).optional(),
  q: z.string().max(512).optional(), page: z.number().int().positive().max(100_000).optional(),
  limit: z.number().int().positive().max(50).optional() }).strict();
export const capabilityPackageStoreInstallSchema = z.object({ source: capabilityPackageStoreSelectionSchema,
  ownership: capabilityPackageOwnershipSchema, grants: z.array(grant).max(200).default([]),
  responsibleUserId: boundedText(200).nullable().optional() }).strict();
export const capabilityPackageStoreUpdateReviewSchema = z.object({ source: capabilityPackageStoreSelectionSchema }).strict();
export const capabilityPackageStoreUpdateSchema = z.object({ source: capabilityPackageStoreSelectionSchema,
  expectedMetadataRevision: revision, expectedGrantsRevision: revision,
  expectedPackageRevision: revision, expectedPublishedRevisionRef: publishedRef.nullable(),
  expectedLocalChecksum: checksum, replaceLocalChanges: z.boolean() }).strict();

export type CapabilityPackageStoreSelection = z.infer<typeof capabilityPackageStoreSelectionSchema>;
export type CapabilityPackageStoreInstallRequest = z.infer<typeof capabilityPackageStoreInstallSchema>;
export type CapabilityPackageStoreUpdateRequest = z.infer<typeof capabilityPackageStoreUpdateSchema>;
export type CapabilityPackageStoreUpdateReview = {
  schemaVersion: 1; resourceRef: string; source: CapabilityPackageStoreSelection;
  current: { version: string; checksum: string; upstreamVersion: string };
  localChanges: 'unchanged' | 'modified';
  expectedMetadataRevision: number; expectedGrantsRevision: number;
  expectedPackageRevision: number; expectedPublishedRevisionRef: string | null;
  expectedLocalChecksum: string; requiresLocalChangesConfirmation: boolean;
  canUpdate: boolean;
};
export type CapabilityPackageStoreApplicationResult = {
  schemaVersion: 1; resource: CapabilityResourceMetadata; state: CapabilityPackageState;
  published: CapabilityPackagePublishedSummary;
};
