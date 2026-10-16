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
  z.object({ operation: z.literal('create'), kind: z.enum(['skill', 'plugin']), targetName: z.string().min(1).max(64), requestId: z.uuid() }).strict(),
  z.object({ operation: z.literal('edit'), resourceRef, ...resourceRevisions, ...head }).strict(),
  z.object({ operation: z.literal('fork'), resourceRef, targetName: z.string().min(1).max(64),
    ownership: capabilityPackageOwnershipSchema, expectedSourceMetadataRevision: revision, expectedSourceGrantsRevision: revision,
    expectedSourcePackageRevision: revision, expectedSourcePublishedRevisionRef: revisionRef.nullable() }).strict(),
]);
export const capabilityPackagePublishSchema = z.object({ draftRef, requestId: z.uuid().optional(), ...resourceRevisions, ...head, ...draftRevision }).strict();
export const capabilityPackageOwnedDraftListQuerySchema = z.object({ limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(1_024).optional() }).strict();
export const capabilityPackageOperationQuerySchema = z.union([
  z.object({ requestId: z.uuid() }).strict(), z.object({ draftRef }).strict(),
]);
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

const compositionPath = z.string().min(1).max(1_024).refine(value => !value.startsWith('/') && !/^[A-Za-z]:|[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..'));
const checksum = z.string().regex(/^[a-f0-9]{64}$/u);
export const capabilityPackageSkillCompositionSchema = z.object({ ...draftRevision,
  skills: z.array(z.object({ source: z.object({ resourceRef, revisionRef: revisionRef.optional(), expectedChecksum: checksum,
    childRelativeRoot: z.union([z.literal('.'),compositionPath]).optional(), expectedParentChecksum: checksum.optional() }).strict(),
    targetName: z.string().min(1).max(64).optional(), targetVersion: z.string().min(1).max(200).optional() }).strict()).min(1).max(32),
}).strict();
export const capabilityPackageWorkspaceDraftQuerySchema = z.object({ kind: z.enum(['skill','plugin']),
  workspaceDraftId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/u).refine(value => value !== '.' && value !== '..'),
  packageName: z.string().min(1).max(64),
}).strict();
export const capabilityPackageWorkspaceDraftImportSchema = z.object({ ...draftRevision,
  source: capabilityPackageWorkspaceDraftQuerySchema, expectedChecksum: checksum,
}).strict();
