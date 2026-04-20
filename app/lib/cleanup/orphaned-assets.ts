import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { db } from '@/app/lib/db';
import { studioProductImages, studioPersonaImages, studioGenerationOutputs } from '@/app/lib/db/schema';
import { getStudioAssetsRoot, getStudioOutputsRoot, deleteAssetFile } from '@/app/lib/integrations/studio-workspace';

async function listFilesRecursive(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await listFilesRecursive(fullPath, baseDir);
      results.push(...subFiles);
    } else {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results;
}

function toRelativePath(absoluteOrRelativePath: string, root: string): string {
  if (absoluteOrRelativePath.startsWith(root)) {
    return path.relative(root, absoluteOrRelativePath).replace(/\\/g, '/');
  }
  return absoluteOrRelativePath.replace(/\\/g, '/');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export async function cleanupOrphanedStudioAssets(): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  let deleted = 0;

  try {
    const assetsRoot = getStudioAssetsRoot();
    const outputsRoot = getStudioOutputsRoot();

    const assetsFiles = await listFilesRecursive(assetsRoot, assetsRoot).catch(() => [] as string[]);
    const outputsFiles = await listFilesRecursive(outputsRoot, outputsRoot).catch(() => [] as string[]);

    const allDiskFiles = new Set(
      [...assetsFiles, ...outputsFiles].map(normalizePath)
    );

    const dbFilePaths = new Set<string>();

    const productImages = await db.select({ filePath: studioProductImages.filePath }).from(studioProductImages);
    for (const row of productImages) {
      dbFilePaths.add(normalizePath(row.filePath));
    }

    const personaImages = await db.select({ filePath: studioPersonaImages.filePath }).from(studioPersonaImages);
    for (const row of personaImages) {
      dbFilePaths.add(normalizePath(row.filePath));
    }

    const generationOutputs = await db.select({ filePath: studioGenerationOutputs.filePath }).from(studioGenerationOutputs);
    for (const row of generationOutputs) {
      dbFilePaths.add(normalizePath(row.filePath));
    }

    for (const diskFile of allDiskFiles) {
      if (!dbFilePaths.has(diskFile)) {
        try {
          const isAsset = assetsFiles.map(normalizePath).includes(diskFile);
          const relativePath = diskFile;
          await deleteAssetFile(relativePath);
          deleted++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to delete ${diskFile}: ${msg}`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Cleanup job error: ${msg}`);
  }

  console.log(`[orphaned-assets] Cleanup complete: ${deleted} files deleted, ${errors.length} errors`);
  if (errors.length > 0) {
    console.warn('[orphaned-assets] Errors:', errors);
  }

  return { deleted, errors };
}