import 'server-only';

import type { EnvStorageScope } from '@/app/lib/integrations/env-config';
import {
  resolveEffectiveComposioProfile,
  type ComposioConnectionProfile,
  type EffectiveComposioProfile,
} from './composio-profiles';

export interface ResolvedComposioContext {
  readonly kind: 'resolved_composio_context';
  readonly userId: string;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly profileSource: 'default' | 'workspace_override';
  readonly composioUserId: string;
  readonly cacheRevision: string;
  readonly storageScope: EnvStorageScope;
}

export interface PublicComposioProfile {
  id: string;
  name: string;
  isDefault: boolean;
  status: 'active' | 'archived';
  workspaceOverrideCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toPublicComposioProfile(profile: ComposioConnectionProfile): PublicComposioProfile {
  return {
    id: profile.id,
    name: profile.name,
    isDefault: profile.isDefault,
    status: profile.status,
    workspaceOverrideCount: profile.workspaceOverrideCount,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export function composioContextFromEffectiveProfile(
  userId: string,
  profile: EffectiveComposioProfile,
): ResolvedComposioContext {
  return Object.freeze({
    kind: 'resolved_composio_context' as const,
    userId,
    workspaceId: profile.workspaceId,
    profileId: profile.id,
    profileName: profile.name,
    profileSource: profile.source,
    composioUserId: profile.composioUserId,
    cacheRevision: profile.cacheRevision,
    storageScope: Object.freeze({ secretScope: 'user' as const, userId }),
  });
}

export async function resolveComposioContext(input: {
  userId: string;
  workspaceId?: string | null;
}): Promise<ResolvedComposioContext> {
  const userId = input.userId.trim();
  const effective = await resolveEffectiveComposioProfile({
    userId,
    workspaceId: input.workspaceId,
  });
  return composioContextFromEffectiveProfile(userId, effective);
}

export function composioContextCacheKey(context: ResolvedComposioContext): string {
  return `${context.profileId}:${context.composioUserId}:${context.cacheRevision}`;
}

export function toPublicEffectiveComposioContext(context: ResolvedComposioContext) {
  return {
    id: context.profileId,
    name: context.profileName,
    source: context.profileSource,
    workspaceId: context.workspaceId,
    isDefault: context.profileSource === 'default',
  };
}

export function assertResolvedComposioContext(
  context: ResolvedComposioContext | null | undefined,
): asserts context is ResolvedComposioContext {
  if (!context || context.kind !== 'resolved_composio_context') {
    throw new Error('A resolved user and workspace Composio context is required.');
  }
}
