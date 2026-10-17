import type { CapabilityPolicyEffect, CapabilityPolicyTargetType, CapabilityReadiness, CapabilityReference, CapabilityResourceType, CapabilitySourceType } from '../types';

/** Ownership and the audience of a resource are separate. Team artifacts stay in organization storage. */
export type CapabilityResourceOwnerScope =
  | { type: 'system' }
  | { type: 'user'; ownerUserId: string; organizationId: string | null }
  | { type: 'organization'; organizationId: string }
  | { type: 'team'; organizationId: string; workspaceId: string };

export type CapabilityResourceAccess = {
  canRead: boolean;
  canUse: boolean;
  canEdit: boolean;
  canManage: boolean;
};

/** Flags are explicit and independent. Editing or managing never grants runtime execution. */
export type CapabilityResourceGrantInput = {
  targetType: CapabilityPolicyTargetType;
  targetId: string;
  canUse: boolean;
  canEdit: boolean;
  canManage: boolean;
};

export type CapabilityResourceGrant = CapabilityResourceGrantInput & {
  id: string;
  resourceRef: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: number;
  updatedAt: number;
};

/** No credentials, raw configuration, absolute filesystem paths or artifact contents. */
export type CapabilityResourceMetadata = {
  resourceRef: string;
  legacyResourceId: string;
  resourceType: CapabilityResourceType;
  sourceType: CapabilitySourceType;
  sourcePluginId: string | null;
  ownership: CapabilityResourceOwnerScope;
  displayName: string | null;
  description: string | null;
  responsibleUserId: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  metadataRevision: number;
  grantsRevision: number;
  accessMode: 'inherit' | 'restricted';
  status: 'active' | 'archived';
  createdAt: number | null;
  updatedAt: number | null;
};

export type CapabilityResourceDescriptor = {
  metadata: CapabilityResourceMetadata;
  access: CapabilityResourceAccess;
  /** Safe current package description when no metadata override has been set. */
  description?: string;
  artifact: Pick<CapabilityReference, 'resourceType' | 'resourceId' | 'scopeType' | 'name' | 'version' | 'revision' | 'checksum' | 'sourceType' | 'sourcePluginId'> & {
    /** Does not disclose a path or grant access to the underlying image. */
    hasDeclaredIcon?: boolean;
    pluginSkillRelativeRoot?: string;
  };
  /** Returned only to resource managers; ordinary readers see their effective rights. */
  grants?: CapabilityResourceGrant[];
  /** Labels of people already referenced by this readable resource, never a user directory. */
  people?: Partial<Record<'owner' | 'createdBy' | 'updatedBy' | 'responsible', { userId: string; name: string | null }>>;
  ownershipLabel?: string;
  activation?: { effectivePolicy: CapabilityPolicyEffect; enabled: boolean; readiness: CapabilityReadiness | 'unknown'; blockedReason: string | null };
};

/** Actor identity is supplied by the server. A requested workspace still needs fresh authoritative resolution. */
export type CapabilityResourceActor = { userId: string; workspaceId?: string | null };

export type CapabilityResourceMetadataPatch = {
  displayName?: string | null;
  description?: string | null;
  responsibleUserId?: string | null;
};

export type CapabilityResourceMutation = {
  expectedMetadataRevision: number;
  expectedGrantsRevision: number;
  metadata?: CapabilityResourceMetadataPatch;
  /** Complete desired grant set, replaced atomically. An empty list grants nobody additional rights. */
  grants?: CapabilityResourceGrantInput[];
  accessMode?: 'inherit' | 'restricted';
};

export type CapabilityResourceAdoption = CapabilityResourceMutation & {
  ownership?: Exclude<CapabilityResourceOwnerScope, { type: 'system' }>;
};

/** Public configuration chooses a scope; owner and organization identities come from the installed artifact. */
export type CapabilityResourceConfiguration = CapabilityResourceMutation & {
  ownership?: { type: 'user' | 'organization' } | { type: 'team'; workspaceId: string };
};

/** A storage binding is derived from an installed artifact, never accepted from UI or model arguments. */
export type CapabilityResourceStorageBinding = Pick<CapabilityReference,
  'resourceType' | 'resourceId' | 'scopeType' | 'name' | 'sourceType' | 'organizationId' | 'ownerUserId' | 'sourcePluginId'>;

/** Internal record, including the authoritative artifact lookup binding. Never spread into a public response. */
export type CapabilityResourceRecord = {
  metadata: CapabilityResourceMetadata;
  storage: CapabilityResourceStorageBinding;
};

export type CapabilityResourceAccessEntry = {
  metadata: CapabilityResourceMetadata;
  access: CapabilityResourceAccess;
};

export class CapabilityResourceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'CapabilityResourceError';
  }
}
