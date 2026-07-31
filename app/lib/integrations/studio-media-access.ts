import 'server-only';

import { and, eq, or } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import {
  studioPersonaImages,
  studioPersonas,
  studioPresets,
  studioProductImages,
  studioProducts,
  studioStyleImages,
  studioStyles,
} from '@/app/lib/db/schema';
import type { StudioScope } from '@/app/lib/integrations/studio-scope';
import { canReadStudioOutputPath } from '@/app/lib/integrations/studio-generation-service';
import {
  getStudioWorkspaceVirtualRoot,
  STUDIO_SYSTEM_PRESETS_DIR,
} from '@/app/lib/integrations/studio-workspace';
import type { ResolvedMediaReference } from '@/app/lib/integrations/media-reference-resolver';

function assetPathCandidates(filePath: string): string[] {
  const normalized = filePath.replace(/^\/+/, '');
  const legacyPrefix = 'studio/assets/';
  return normalized.startsWith(legacyPrefix)
    ? [normalized, normalized.slice(legacyPrefix.length)]
    : [normalized, `${legacyPrefix}${normalized}`];
}

async function canAccessLegacyStudioAssetPath(
  filePath: string,
  scope: StudioScope,
  options: { includeDefaultPresets: boolean },
): Promise<boolean> {
  const candidates = assetPathCandidates(filePath);

  for (const candidate of candidates) {
    const [productImage] = await db.select({ id: studioProductImages.id })
      .from(studioProductImages)
      .innerJoin(studioProducts, eq(studioProductImages.productId, studioProducts.id))
      .where(and(
        eq(studioProductImages.filePath, candidate),
        eq(studioProducts.workspaceId, scope.workspaceId),
      ))
      .limit(1);
    if (productImage) return true;

    const [personaImage] = await db.select({ id: studioPersonaImages.id })
      .from(studioPersonaImages)
      .innerJoin(studioPersonas, eq(studioPersonaImages.personaId, studioPersonas.id))
      .where(and(
        eq(studioPersonaImages.filePath, candidate),
        eq(studioPersonas.workspaceId, scope.workspaceId),
      ))
      .limit(1);
    if (personaImage) return true;

    const [styleImage] = await db.select({ id: studioStyleImages.id })
      .from(studioStyleImages)
      .innerJoin(studioStyles, eq(studioStyleImages.styleId, studioStyles.id))
      .where(and(
        eq(studioStyleImages.filePath, candidate),
        eq(studioStyles.workspaceId, scope.workspaceId),
      ))
      .limit(1);
    if (styleImage) return true;

    const [preset] = await db.select({ id: studioPresets.id })
      .from(studioPresets)
      .where(and(
        eq(studioPresets.previewImagePath, candidate),
        options.includeDefaultPresets
          ? or(
              eq(studioPresets.workspaceId, scope.workspaceId),
              eq(studioPresets.isDefault, true),
            )
          : eq(studioPresets.workspaceId, scope.workspaceId),
      ))
      .limit(1);
    if (preset) return true;
  }

  return false;
}

export async function canReadLegacyStudioAssetPath(filePath: string, scope: StudioScope): Promise<boolean> {
  return canAccessLegacyStudioAssetPath(filePath, scope, { includeDefaultPresets: true });
}

export async function canWriteLegacyStudioAssetPath(filePath: string, scope: StudioScope): Promise<boolean> {
  return canAccessLegacyStudioAssetPath(filePath, scope, { includeDefaultPresets: false });
}

export async function canReadStudioMediaPath(filePath: string, scope: StudioScope): Promise<boolean> {
  const normalized = filePath.replace(/^\/+/, '');
  const workspaceRoot = getStudioWorkspaceVirtualRoot(scope.storage);

  if (normalized.startsWith(`${STUDIO_SYSTEM_PRESETS_DIR}/`)) return true;
  if (normalized.startsWith(`${workspaceRoot}/outputs/`)) {
    return canReadStudioOutputPath(normalized, scope);
  }
  if (
    normalized.startsWith(`${workspaceRoot}/assets/`)
    || normalized.startsWith(`${workspaceRoot}/edits/`)
  ) {
    return true;
  }
  if (normalized.startsWith('studio/outputs/')) {
    return canReadStudioOutputPath(normalized, scope);
  }
  if (normalized.startsWith('studio/assets/')) {
    return canReadLegacyStudioAssetPath(normalized, scope);
  }

  return false;
}

export async function canWriteStudioMediaReference(
  reference: ResolvedMediaReference,
  scope: StudioScope,
): Promise<boolean> {
  if (reference.kind === 'external_url' || reference.kind === 'workspace_relative' || reference.kind === 'workspace_absolute') {
    return false;
  }

  const normalized = reference.relativePath.replace(/^\/+/, '');
  const workspaceRoot = getStudioWorkspaceVirtualRoot(scope.storage);

  if (normalized.startsWith(`${STUDIO_SYSTEM_PRESETS_DIR}/`)) return false;

  if (normalized.startsWith(`${workspaceRoot}/assets/`) || normalized.startsWith(`${workspaceRoot}/edits/`)) {
    return true;
  }
  if (normalized.startsWith(`${workspaceRoot}/outputs/`)) {
    return canReadStudioOutputPath(normalized, scope);
  }

  if (reference.kind === 'studio_output') {
    return canReadStudioOutputPath(`studio/outputs/${normalized}`, scope);
  }
  if (reference.kind === 'studio_asset') {
    return canWriteLegacyStudioAssetPath(normalized, scope);
  }
  if (reference.kind === 'user_upload') {
    return canWriteLegacyStudioAssetPath(`user-uploads/studio-references/${normalized}`, scope);
  }

  return false;
}
