import type {
  CapabilityReference,
  CapabilityResourceType,
  CapabilityScopeType,
  CapabilitySourceType,
} from './types';

function encodePart(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}

export function createCapabilityResourceId(input: {
  resourceType: CapabilityResourceType;
  scopeType: CapabilityScopeType;
  name: string;
  sourceType: CapabilitySourceType;
  organizationId?: string | null;
  ownerUserId?: string | null;
  sourcePluginName?: string | null;
}): string {
  const scopeKey = input.scopeType === 'organization'
    ? `org:${encodePart(input.organizationId || '')}`
    : input.scopeType === 'user'
      ? `user:${encodePart(input.ownerUserId || '')}`
      : 'system';
  const sourceKey = input.sourceType === 'plugin'
    ? `plugin:${encodePart(input.sourcePluginName || '')}`
    : input.sourceType;
  return [
    'canvas-capability',
    'v1',
    input.resourceType,
    scopeKey,
    sourceKey,
    encodePart(input.name),
  ].join(':');
}

export function createCapabilityReference(input: Omit<CapabilityReference, 'resourceId'> & {
  resourceId?: string;
  sourcePluginName?: string | null;
}): CapabilityReference {
  return {
    ...input,
    resourceId: input.resourceId || createCapabilityResourceId({
      resourceType: input.resourceType,
      scopeType: input.scopeType,
      name: input.name,
      sourceType: input.sourceType,
      organizationId: input.organizationId,
      ownerUserId: input.ownerUserId,
      sourcePluginName: input.sourcePluginName,
    }),
  };
}
