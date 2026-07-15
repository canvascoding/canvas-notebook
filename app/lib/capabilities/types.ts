export type CapabilityResourceType = 'skill' | 'plugin';

export type CapabilityScopeType = 'system' | 'organization' | 'user';

export type CapabilitySourceType = 'core' | 'standalone' | 'plugin';

export type CapabilityPolicyEffect = 'optional' | 'default-enabled' | 'required' | 'blocked';

export type CapabilityPolicyTargetType = 'organization' | 'role' | 'workspace' | 'project' | 'user';

export type CapabilityReadiness =
  | 'available'
  | 'disabled'
  | 'blocked'
  | 'conflict'
  | 'personal-connection-required';

export type CapabilityReference = {
  resourceType: CapabilityResourceType;
  scopeType: CapabilityScopeType;
  resourceId: string;
  name: string;
  version: string;
  revision: number;
  checksum: string;
  sourceType: CapabilitySourceType;
  organizationId: string | null;
  ownerUserId: string | null;
  sourcePluginId: string | null;
};

export type CapabilityPolicy = {
  id: string;
  organizationId: string;
  resourceType: CapabilityResourceType;
  resourceId: string;
  targetType: CapabilityPolicyTargetType;
  targetId: string;
  effect: CapabilityPolicyEffect;
  revision: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export type CapabilityResolutionContext = {
  organizationId: string;
  userId: string;
  role?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
};

export type CapabilityCandidate = {
  ref: CapabilityReference;
  description: string;
  enabled: boolean;
  userPreference?: 'unset' | 'enabled' | 'disabled';
  runtimePath: string | null;
  pluginResourceId?: string | null;
  connectionRequirementCount?: number;
  connectionReady?: boolean;
};

export type EffectiveCapability = CapabilityCandidate & {
  effectivePolicy: CapabilityPolicyEffect;
  matchedPolicies: CapabilityPolicy[];
  readiness: CapabilityReadiness;
  effectiveEnabled: boolean;
  blockedReason: string | null;
  conflictResourceIds: string[];
};

export type CapabilityConflict = {
  resourceType: CapabilityResourceType;
  name: string;
  protectedResourceId: string | null;
  resourceIds: string[];
  reason: string;
};

export type EffectiveCapabilitySnapshot = {
  schemaVersion: 1;
  snapshotId: string;
  organizationId: string;
  userId: string;
  workspaceId: string | null;
  projectId: string | null;
  createdAt: string;
  capabilities: EffectiveCapability[];
  conflicts: CapabilityConflict[];
};
