import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import {
  studioGenerationOutputs,
  studioGenerations,
  studioPersonaImages,
  studioPersonas,
  studioPresets,
  studioProductImages,
  studioProducts,
  studioStyleImages,
  studioStyles,
} from '@/app/lib/db/schema';
import type { StudioScope } from '@/app/lib/integrations/studio-scope';
import {
  getStudioAssetsRoot,
  getStudioOutputsRoot,
  getStudioWorkspaceVirtualRoot,
  resolveStudioFilePath,
} from '@/app/lib/integrations/studio-workspace';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { resolvePathInside } from '@/app/lib/security/safe-paths';

const migrations = new Map<string, Promise<void>>();

function scopedAssetPath(scope: StudioScope, legacyPath: string): string | null {
  const normalized = legacyPath.replace(/^\/+/, '');
  if (normalized.startsWith(`${getStudioWorkspaceVirtualRoot(scope.storage)}/assets/`)) return null;
  const relative = normalized.startsWith('studio/assets/')
    ? normalized.slice('studio/assets/'.length)
    : normalized;
  if (!/^(products|personas|styles|presets|references)\//.test(relative)) return null;
  return path.posix.join(getStudioWorkspaceVirtualRoot(scope.storage), 'assets', relative);
}

function scopedOutputPath(scope: StudioScope, generationId: string, legacyPath: string): string | null {
  const normalized = legacyPath.replace(/^\/+/, '');
  if (normalized.startsWith(`${getStudioWorkspaceVirtualRoot(scope.storage)}/outputs/`)) return null;
  const fileName = path.posix.basename(normalized);
  if (!fileName) return null;
  return path.posix.join(getStudioWorkspaceVirtualRoot(scope.storage), 'outputs', generationId, fileName);
}

async function copyLegacyFile(sourcePath: string, targetPath: string, legacyRoot?: string): Promise<boolean> {
  const source = resolveStudioFilePath(sourcePath, legacyRoot);
  const target = resolveStudioFilePath(targetPath);
  if (!source || !target || source === target) return false;

  try {
    await fs.access(target);
    return true;
  } catch {
    // Copy below.
  }

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function migrateProductImages(scope: StudioScope): Promise<void> {
  const rows = await db.select({
    imageId: studioProductImages.id,
    productId: studioProductImages.productId,
    filePath: studioProductImages.filePath,
    thumbnailPath: studioProducts.thumbnailPath,
  })
    .from(studioProductImages)
    .innerJoin(studioProducts, eq(studioProductImages.productId, studioProducts.id))
    .where(eq(studioProducts.workspaceId, scope.workspaceId));

  for (const row of rows) {
    const targetPath = scopedAssetPath(scope, row.filePath);
    if (!targetPath || !(await copyLegacyFile(row.filePath, targetPath, getStudioAssetsRoot()))) continue;
    await db.update(studioProductImages)
      .set({ filePath: targetPath })
      .where(eq(studioProductImages.id, row.imageId));
    if (row.thumbnailPath === row.filePath) {
      await db.update(studioProducts)
        .set({ thumbnailPath: targetPath })
        .where(and(
          eq(studioProducts.id, row.productId),
          eq(studioProducts.workspaceId, scope.workspaceId),
        ));
    }
  }
}

async function migratePersonaImages(scope: StudioScope): Promise<void> {
  const rows = await db.select({
    imageId: studioPersonaImages.id,
    personaId: studioPersonaImages.personaId,
    filePath: studioPersonaImages.filePath,
    thumbnailPath: studioPersonas.thumbnailPath,
  })
    .from(studioPersonaImages)
    .innerJoin(studioPersonas, eq(studioPersonaImages.personaId, studioPersonas.id))
    .where(eq(studioPersonas.workspaceId, scope.workspaceId));

  for (const row of rows) {
    const targetPath = scopedAssetPath(scope, row.filePath);
    if (!targetPath || !(await copyLegacyFile(row.filePath, targetPath, getStudioAssetsRoot()))) continue;
    await db.update(studioPersonaImages).set({ filePath: targetPath }).where(eq(studioPersonaImages.id, row.imageId));
    if (row.thumbnailPath === row.filePath) {
      await db.update(studioPersonas)
        .set({ thumbnailPath: targetPath })
        .where(and(eq(studioPersonas.id, row.personaId), eq(studioPersonas.workspaceId, scope.workspaceId)));
    }
  }
}

async function migrateStyleImages(scope: StudioScope): Promise<void> {
  const rows = await db.select({
    imageId: studioStyleImages.id,
    styleId: studioStyleImages.styleId,
    filePath: studioStyleImages.filePath,
    thumbnailPath: studioStyles.thumbnailPath,
  })
    .from(studioStyleImages)
    .innerJoin(studioStyles, eq(studioStyleImages.styleId, studioStyles.id))
    .where(eq(studioStyles.workspaceId, scope.workspaceId));

  for (const row of rows) {
    const targetPath = scopedAssetPath(scope, row.filePath);
    if (!targetPath || !(await copyLegacyFile(row.filePath, targetPath, getStudioAssetsRoot()))) continue;
    await db.update(studioStyleImages).set({ filePath: targetPath }).where(eq(studioStyleImages.id, row.imageId));
    if (row.thumbnailPath === row.filePath) {
      await db.update(studioStyles)
        .set({ thumbnailPath: targetPath })
        .where(and(eq(studioStyles.id, row.styleId), eq(studioStyles.workspaceId, scope.workspaceId)));
    }
  }
}

async function migratePresetPreviews(scope: StudioScope): Promise<void> {
  const rows = await db.select({ id: studioPresets.id, previewImagePath: studioPresets.previewImagePath })
    .from(studioPresets)
    .where(eq(studioPresets.workspaceId, scope.workspaceId));

  for (const row of rows) {
    if (!row.previewImagePath) continue;
    const targetPath = scopedAssetPath(scope, row.previewImagePath);
    if (!targetPath || !(await copyLegacyFile(row.previewImagePath, targetPath, getStudioAssetsRoot()))) continue;
    await db.update(studioPresets)
      .set({ previewImagePath: targetPath })
      .where(and(eq(studioPresets.id, row.id), eq(studioPresets.workspaceId, scope.workspaceId)));
  }
}

async function migrateGenerationOutputs(scope: StudioScope): Promise<Map<string, string>> {
  const rows = await db.select({
    id: studioGenerationOutputs.id,
    generationId: studioGenerationOutputs.generationId,
    filePath: studioGenerationOutputs.filePath,
  })
    .from(studioGenerationOutputs)
    .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
    .where(eq(studioGenerations.workspaceId, scope.workspaceId));
  const migratedPaths = new Map<string, string>();

  for (const row of rows) {
    if (!row.filePath) continue;
    const targetPath = scopedOutputPath(scope, row.generationId, row.filePath);
    if (!targetPath || !(await copyLegacyFile(row.filePath, targetPath, getStudioOutputsRoot()))) continue;
    await db.update(studioGenerationOutputs)
      .set({
        filePath: targetPath,
        mediaUrl: null,
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
        customerId: scope.customerId,
        projectId: scope.projectId,
      })
      .where(eq(studioGenerationOutputs.id, row.id));
    migratedPaths.set(row.filePath, targetPath);
    if (!row.filePath.startsWith('studio/outputs/')) {
      migratedPaths.set(`studio/outputs/${row.filePath}`, targetPath);
    }
  }

  return migratedPaths;
}

function legacyUploadAbsolutePath(filePath: string): string | null {
  const normalized = filePath.replace(/^\/+/, '');
  if (!normalized.startsWith('user-uploads/studio-references/')) return null;
  return resolvePathInside(resolveCanvasDataRoot(), path.normalize(normalized));
}

function storedStudioPath(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed, 'http://canvas.local');
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath.startsWith('/api/studio/media/')) {
      return decodedPath.slice('/api/studio/media/'.length).replace(/^\/+/, '');
    }
    if (decodedPath.startsWith('/studio/')) return decodedPath.slice(1);
  } catch {
    // Fall through to plain-path handling.
  }
  return trimmed.split(/[?#]/, 1)[0]?.replace(/^\/+/, '') ?? trimmed;
}

async function migrateLegacyStudioReference(value: string, scope: StudioScope): Promise<string | null> {
  const storedPath = storedStudioPath(value);
  const workspaceRoot = getStudioWorkspaceVirtualRoot(scope.storage);
  if (storedPath.startsWith(`${workspaceRoot}/`) || storedPath.startsWith('studio/system/')) return null;

  let targetPath: string | null = null;
  let legacyRoot: string | undefined;
  if (storedPath.startsWith('studio/assets/')) {
    targetPath = path.posix.join(workspaceRoot, 'assets', storedPath.slice('studio/assets/'.length));
  } else if (/^(products|personas|styles|presets|references)\//.test(storedPath)) {
    targetPath = path.posix.join(workspaceRoot, 'assets', storedPath);
    legacyRoot = getStudioAssetsRoot();
  } else if (storedPath.startsWith('studio/edits/')) {
    targetPath = path.posix.join(workspaceRoot, 'edits', storedPath.slice('studio/edits/'.length));
  }

  if (!targetPath) return null;
  return await copyLegacyFile(storedPath, targetPath, legacyRoot) ? targetPath : null;
}

async function migrateMetadataPath(
  value: unknown,
  scope: StudioScope,
  outputPaths: Map<string, string>,
): Promise<unknown> {
  if (typeof value !== 'string') return value;
  const storedPath = storedStudioPath(value);
  const mappedOutput = outputPaths.get(value) ?? outputPaths.get(storedPath);
  if (mappedOutput) return mappedOutput;

  const migratedStudioReference = await migrateLegacyStudioReference(value, scope);
  if (migratedStudioReference) return migratedStudioReference;

  const source = legacyUploadAbsolutePath(storedPath);
  if (!source) return value;
  const targetPath = path.posix.join(
    getStudioWorkspaceVirtualRoot(scope.storage),
    'assets',
    'references',
    path.posix.basename(storedPath),
  );
  const target = resolveStudioFilePath(targetPath);
  if (!target) return value;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    return targetPath;
  } catch {
    return value;
  }
}

async function migrateGenerationMetadata(scope: StudioScope, outputPaths: Map<string, string>): Promise<void> {
  const rows = await db.select({ id: studioGenerations.id, metadata: studioGenerations.metadata })
    .from(studioGenerations)
    .where(eq(studioGenerations.workspaceId, scope.workspaceId));
  const arrayKeys = ['extraReferenceUrls', 'videoReferenceUrls', 'audioReferenceUrls'] as const;
  const scalarKeys = ['startFramePath', 'endFramePath', 'videoExtendSourcePath'] as const;

  for (const row of rows) {
    if (!row.metadata) continue;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      continue;
    }
    let changed = false;
    for (const key of arrayKeys) {
      if (!Array.isArray(metadata[key])) continue;
      const next = await Promise.all(metadata[key].map((value) => migrateMetadataPath(value, scope, outputPaths)));
      if (JSON.stringify(next) !== JSON.stringify(metadata[key])) changed = true;
      metadata[key] = next;
    }
    for (const key of scalarKeys) {
      const next = await migrateMetadataPath(metadata[key], scope, outputPaths);
      if (next !== metadata[key]) changed = true;
      metadata[key] = next;
    }
    if (changed) {
      await db.update(studioGenerations)
        .set({ metadata: JSON.stringify(metadata) })
        .where(and(eq(studioGenerations.id, row.id), eq(studioGenerations.workspaceId, scope.workspaceId)));
    }
  }
}

async function migrateWorkspaceFiles(scope: StudioScope): Promise<void> {
  await Promise.all([
    migrateProductImages(scope),
    migratePersonaImages(scope),
    migrateStyleImages(scope),
    migratePresetPreviews(scope),
  ]);
  const outputPaths = await migrateGenerationOutputs(scope);
  await migrateGenerationMetadata(scope, outputPaths);
}

export async function ensureStudioWorkspaceFilesMigrated(scope: StudioScope): Promise<void> {
  const existing = migrations.get(scope.workspaceId);
  if (existing) return existing;

  const migration = migrateWorkspaceFiles(scope).catch((error) => {
    migrations.delete(scope.workspaceId);
    throw error;
  });
  migrations.set(scope.workspaceId, migration);
  return migration;
}
