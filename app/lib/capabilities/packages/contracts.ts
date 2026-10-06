import type {
  CapabilityResourceAccess,
  CapabilityResourceActor,
  CapabilityResourceMetadata,
  CapabilityResourceOwnerScope,
  CapabilityResourceRecord,
  CapabilityResourceStorageBinding,
} from '../resources/contracts';

export const CAPABILITY_PACKAGE_CONTRACT_VERSION = 1 as const;
export type CapabilityPackageKind = 'skill' | 'plugin';
export type CapabilityPackageOperation = 'read' | 'use' | 'edit' | 'publish';

export const CAPABILITY_PACKAGE_LIMITS = Object.freeze({
  maxFiles: 2_000,
  maxTotalBytes: 250 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxReadBytes: 8 * 1024 * 1024,
  maxDepth: 32,
  maxRelativePathLength: 1_024,
});

/** The semantic version is a package label; revisionRef selects exact immutable bytes. */
export type CapabilityPackageRevisionIdentity = {
  revisionRef: string;
  resourceRef: string;
  kind: CapabilityPackageKind;
  name: string;
  version: string;
  checksum: string;
};

export type CapabilityPackageFileEntry = {
  path: string;
  size: number;
  checksum: string;
  mediaType?: string;
};
export type CapabilityPackageTreeEntry =
  | { path: string; type: 'directory' }
  | (CapabilityPackageFileEntry & { type: 'file' });

/** No absolute paths or package bytes are part of published metadata. */
export type CapabilityPackagePublishedRevision = CapabilityPackageRevisionIdentity & {
  contractVersion: typeof CAPABILITY_PACKAGE_CONTRACT_VERSION;
  files: CapabilityPackageFileEntry[];
  totalBytes: number;
  publishedByUserId: string | null;
  publishedAt: number;
  baseRevisionRef: string | null;
  sourceResourceRef: string;
  sourceRevisionRef: string | null;
  sourceChecksum: string;
  sourceStamp: CapabilityPackageSourceStamp;
};
export type CapabilityPackagePublishedSummary = CapabilityPackageRevisionIdentity & {
  publishedByUserId:string|null;publishedAt:number;baseRevisionRef:string|null;fileCount:number;totalBytes:number;
};

/** A registry observation is a compatibility boundary, never permission or filesystem authority. */
export type CapabilityPackageSourceStamp = {
  resourceId: string;
  kind: CapabilityPackageKind;
  name: string;
  version: string;
  artifactRevision: number | null;
  /** Registry digest and actual bytes may differ after an untracked legacy edit. */
  registryChecksum: string;
  checksum: string;
  sourcePluginId: string | null;
  parentResourceRef?: string | null;
  parentRevisionRef?: string | null;
  relativeRoot?: string | null;
  dependencies?: Array<{resourceId:string;name:string;version:string;checksum:string;relativeRoot:string}>;
};

/** Metadata/grant revisions are intentionally independent from the content head. */
export type CapabilityPackageState = {
  contractVersion: typeof CAPABILITY_PACKAGE_CONTRACT_VERSION;
  resourceRef: string;
  kind: CapabilityPackageKind;
  name: string;
  packageRevision: number;
  currentPublishedRevisionRef: string | null;
  currentSourceStamp: CapabilityPackageSourceStamp;
  updatedByUserId: string | null;
  updatedAt: number;
};

export type CapabilityPackageExpectedResourceRevisions = {
  expectedMetadataRevision: number;
  expectedGrantsRevision: number;
};
export type CapabilityPackageExpectedHead = {
  expectedPackageRevision: number;
  expectedPublishedRevisionRef: string | null;
};
export type CapabilityPackageExpectedDraft = { expectedDraftRevision: number };

/** Drafts belong to one actual actor and remain outside generic workspace read/write roots. */
export type CapabilityPackageDraft = {
  contractVersion: typeof CAPABILITY_PACKAGE_CONTRACT_VERSION;
  draftRef: string;
  resourceRef: string;
  kind: CapabilityPackageKind;
  name: string;
  operation: 'edit' | 'fork';
  actorUserId: string;
  draftRevision: number;
  basePackageRevision: number;
  basePublishedRevisionRef: string | null;
  baseSourceStamp: CapabilityPackageSourceStamp;
  sourceResourceRef: string;
  sourceMetadataRevision: number;
  sourceGrantsRevision: number;
  sourcePackageRevision: number;
  sourcePublishedRevisionRef: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CapabilityPackageDescriptor = {
  resource: CapabilityResourceMetadata;
  access: CapabilityResourceAccess;
  state: CapabilityPackageState | null;
  published: CapabilityPackagePublishedRevision | null;
  sourceStamp: CapabilityPackageSourceStamp;
  readOnly: boolean;
  defaultEnabled: boolean;
};

export type CapabilityPackageValidation = {
  valid: boolean;
  kind: CapabilityPackageKind;
  name: string | null;
  version: string | null;
  checksum: string | null;
  files: CapabilityPackageFileEntry[];
  totalBytes: number;
  errors: string[];
  warnings: string[];
};

/** Byte ranges keep asset reads bounded; bytes are encoded explicitly for the public API. */
export type CapabilityPackageFileRead = {
  path: string;
  encoding: 'base64';
  content: string;
  size: number;
  checksum: string;
  offset: number;
  byteLength: number;
  eof: boolean;
  mediaType?: string;
};
export type CapabilityPackageFileWrite = CapabilityPackageExpectedDraft & {
  path: string;
  encoding: 'base64';
  content: string;
};
export type CapabilityPackageFileDelete = CapabilityPackageExpectedDraft & { path: string };

export type CapabilityPackageDraftCreation = CapabilityPackageExpectedResourceRevisions & CapabilityPackageExpectedHead & {
  operation: 'edit';
  resourceRef: string;
} | {
  operation: 'fork';
  resourceRef: string;
  targetName: string;
  ownership: { type: 'user' | 'organization' } | { type: 'team'; workspaceId: string };
  expectedSourceMetadataRevision: number;
  expectedSourceGrantsRevision: number;
  expectedSourcePackageRevision: number;
  expectedSourcePublishedRevisionRef: string | null;
};
export type CapabilityPackagePublishRequest = CapabilityPackageExpectedResourceRevisions
  & CapabilityPackageExpectedHead & CapabilityPackageExpectedDraft & { draftRef: string };
export type CapabilityPackageDefaultActivationRequest = CapabilityPackageExpectedResourceRevisions & CapabilityPackageExpectedHead & {
  enabled:boolean;expectedDefaultEnabled:boolean;
};

/** Internal locations are derived and issued by the server; never accepted from request JSON. */
export type CapabilityPackagePrivateLocation = {
  rootPath: string;
  resourceRef: string;
  owner: CapabilityResourceOwnerScope;
  kind: CapabilityPackageKind;
  name: string;
};
export type CapabilityPackageDraftLocation = CapabilityPackagePrivateLocation & {
  draftRef: string;
  actorUserId: string;
  draftRevision: number;
};
export type CapabilityPackagePublishedLocation = CapabilityPackagePrivateLocation & CapabilityPackageRevisionIdentity;

export type CapabilityPackageSnapshotMarker = {
  contractVersion: typeof CAPABILITY_PACKAGE_CONTRACT_VERSION;
  resourceRef: string;
  revisionRef: string;
  checksum: string;
};
export type CapabilityPackagePreparedSnapshot = {
  location: CapabilityPackagePublishedLocation;
  marker: CapabilityPackageSnapshotMarker;
  validation: CapabilityPackageValidation;
};

/** This receipt needs private provenance plus current rights; cloning its JSON cannot authorize IO. */
export type AuthorizedCapabilityPackageResource = {
  actor: CapabilityResourceActor;
  record: CapabilityResourceRecord;
  access: CapabilityResourceAccess;
  operation: CapabilityPackageOperation;
};

/** Exact source resolved under current read rights, including a plugin child's parent authority. */
export type AuthorizedCapabilityPackageSource = {
  authorization: AuthorizedCapabilityPackageResource;
  storage: CapabilityResourceStorageBinding;
  sourceStamp: CapabilityPackageSourceStamp;
  location: CapabilityPackagePrivateLocation;
  readOnly: boolean;
  parentStorage?: CapabilityResourceStorageBinding;
};

/** Publication returns the exact registry observation to commit with the immutable content head. */
export type CapabilityPackagePublicationResult = {
  snapshot: CapabilityPackagePreparedSnapshot;
  sourceStamp: CapabilityPackageSourceStamp;
};

export type CapabilityPackageDraftSeed = {
  source: AuthorizedCapabilityPackageSource;
  /** Required only for a new fork; issued under current target management authority. */
  target?: AuthorizedCapabilityPackageResource;
};

export type CapabilityPackageErrorCode =
  | 'PACKAGE_NOT_FOUND' | 'PACKAGE_ACCESS_DENIED' | 'PACKAGE_READ_ONLY'
  | 'PACKAGE_REQUEST_INVALID' | 'PACKAGE_PATH_INVALID' | 'PACKAGE_LIMIT_EXCEEDED'
  | 'PACKAGE_REVISION_CONFLICT' | 'PACKAGE_DRAFT_CONFLICT' | 'PACKAGE_SOURCE_CHANGED'
  | 'PACKAGE_INVALID' | 'PACKAGE_SNAPSHOT_UNAVAILABLE' | 'PACKAGE_NAMESPACE_CONFLICT';

export class CapabilityPackageError extends Error {
  constructor(readonly code: CapabilityPackageErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = 'CapabilityPackageError';
    Object.defineProperty(this, Symbol.for('canvas.capability.package-error.v1'), { value: true });
  }
}

export function isCapabilityPackageError(value: unknown): value is CapabilityPackageError {
  return value instanceof Error && Reflect.get(value, Symbol.for('canvas.capability.package-error.v1')) === true
    && typeof (value as CapabilityPackageError).code === 'string'
    && Number.isInteger((value as CapabilityPackageError).status);
}
