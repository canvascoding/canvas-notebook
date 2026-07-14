import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

import { db } from '@/app/lib/db';
import {
  studioGenerationOutputs,
  studioPersonaImages,
  studioPresets,
  studioProductImages,
  studioStyleImages,
} from '@/app/lib/db/schema';
import {
  getStudioRoot,
  resolveStudioFilePath,
} from '@/app/lib/integrations/studio-workspace';
import { normalizeDataScopeId } from '@/app/lib/runtime-data-paths';

type CleanupOptions = {
  organizationId?: string | null;
};

async function listFilesRecursive(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return results;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function addReferencedPath(
  paths: Set<string>,
  rawPath: string | null,
  legacyRoot: 'assets' | 'outputs',
): void {
  if (!rawPath) return;
  const normalized = normalizePath(rawPath).replace(/^data\//, '');
  if (!normalized) return;
  paths.add(normalized.startsWith('studio/')
    ? normalized
    : path.posix.join('studio', legacyRoot, normalized));
}

function isManagedStudioFile(virtualPath: string): boolean {
  return (
    /(?:^|\/)assets\/(?:products|personas|styles|presets)\//.test(virtualPath)
    || /(?:^|\/)outputs\//.test(virtualPath)
  );
}

function getCleanupScanRoot(options: CleanupOptions): { absoluteRoot: string; virtualRoot: string } {
  if (!options.organizationId) {
    return { absoluteRoot: getStudioRoot(), virtualRoot: 'studio' };
  }

  const organizationId = normalizeDataScopeId(options.organizationId, 'organizationId');
  return {
    absoluteRoot: path.join(getStudioRoot(), 'organizations', organizationId),
    virtualRoot: path.posix.join('studio', 'organizations', organizationId),
  };
}

export async function cleanupOrphanedStudioAssets(
  options: CleanupOptions = {},
): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  let deleted = 0;

  try {
    const referencedPaths = new Set<string>();

    const productImages = await db.select({ filePath: studioProductImages.filePath }).from(studioProductImages);
    for (const row of productImages) addReferencedPath(referencedPaths, row.filePath, 'assets');

    const personaImages = await db.select({ filePath: studioPersonaImages.filePath }).from(studioPersonaImages);
    for (const row of personaImages) addReferencedPath(referencedPaths, row.filePath, 'assets');

    const styleImages = await db.select({ filePath: studioStyleImages.filePath }).from(studioStyleImages);
    for (const row of styleImages) addReferencedPath(referencedPaths, row.filePath, 'assets');

    const presets = await db.select({ previewImagePath: studioPresets.previewImagePath }).from(studioPresets);
    for (const row of presets) addReferencedPath(referencedPaths, row.previewImagePath, 'assets');

    const generationOutputs = await db.select({ filePath: studioGenerationOutputs.filePath }).from(studioGenerationOutputs);
    for (const row of generationOutputs) addReferencedPath(referencedPaths, row.filePath, 'outputs');

    const scanRoot = getCleanupScanRoot(options);
    const diskFiles = await listFilesRecursive(scanRoot.absoluteRoot, scanRoot.absoluteRoot);

    for (const relativeFile of diskFiles) {
      const virtualPath = path.posix.join(scanRoot.virtualRoot, normalizePath(relativeFile));
      if (!isManagedStudioFile(virtualPath) || referencedPaths.has(virtualPath)) continue;

      const absolutePath = resolveStudioFilePath(virtualPath);
      if (!absolutePath) {
        errors.push(`Failed to delete ${virtualPath}: invalid Studio path`);
        continue;
      }

      try {
        await fs.rm(absolutePath, { force: true });
        deleted++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to delete ${virtualPath}: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Cleanup job error: ${message}`);
  }

  console.log(`[orphaned-assets] Cleanup complete: ${deleted} files deleted, ${errors.length} errors`);
  if (errors.length > 0) {
    console.warn('[orphaned-assets] Errors:', errors);
  }

  return { deleted, errors };
}
