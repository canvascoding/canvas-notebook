import { z } from 'zod';

const resourceRef = z.string().trim().min(1).max(2_048);
const revisionRef = z.string().regex(/^canvas-package-revision:[a-f0-9-]{36}$/u);
const draftRef = z.string().regex(/^canvas-package-draft:[a-f0-9-]{36}$/u);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resourceRevisions = { expectedMetadataRevision: revision, expectedGrantsRevision: revision };
const head = { expectedPackageRevision: revision, expectedPublishedRevisionRef: revisionRef.nullable() };
const draftRevision = { expectedDraftRevision: revision.positive() };
const relativePath = z.string().min(1).max(1_024);

export const capabilityPackageOwnershipSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user') }).strict(),
  z.object({ type: z.literal('organization') }).strict(),
  z.object({ type: z.literal('team'), workspaceId: z.string().min(1).max(200) }).strict(),
]);
export const capabilityPackageDraftCreationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('edit'), resourceRef, ...resourceRevisions, ...head }).strict(),
  z.object({ operation: z.literal('fork'), resourceRef, targetName: z.string().min(1).max(64),
    ownership: capabilityPackageOwnershipSchema, expectedSourceMetadataRevision: revision, expectedSourceGrantsRevision: revision,
    expectedSourcePackageRevision: revision, expectedSourcePublishedRevisionRef: revisionRef.nullable() }).strict(),
]);
export const capabilityPackagePublishSchema = z.object({ draftRef, ...resourceRevisions, ...head, ...draftRevision }).strict();
export const capabilityPackageActivationSchema = z.object({ enabled: z.boolean(), expectedDefaultEnabled: z.boolean(),
  ...resourceRevisions, expectedPackageRevision: revision, expectedPublishedRevisionRef: revisionRef }).strict();
export const capabilityPackageFileWriteSchema = z.object({ path: relativePath, encoding: z.literal('base64'),
  content: z.string(), ...draftRevision }).strict();
export const capabilityPackageFileDeleteSchema = z.object({ path: relativePath, ...draftRevision }).strict();
export const capabilityPackageDiscardSchema = z.object(draftRevision).strict();
export const capabilityPackageFileReadSchema = z.object({ path: relativePath, offset: revision.optional(),
  maxBytes: z.number().int().positive().max(8 * 1024 * 1024).optional() }).strict();
export const capabilityPackagePublishedFileSchema = capabilityPackageFileReadSchema.extend({ revisionRef: revisionRef.optional() }).strict();
export const capabilityPackagePublishedTreeSchema = z.object({ revisionRef: revisionRef.optional() }).strict();
export const capabilityPackageReferenceSchema = resourceRef;
export const capabilityPackageDraftReferenceSchema = draftRef;
