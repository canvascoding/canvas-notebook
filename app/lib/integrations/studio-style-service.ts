import { randomUUID } from 'node:crypto';
import { db } from '@/app/lib/db';
import { studioStyles, studioStyleImages, studioGenerationStyles } from '@/app/lib/db/schema';
import { eq, and, like, inArray, sql, desc, asc } from 'drizzle-orm';
import {
  writeAssetFile,
  readAssetFile,
  deleteAssetFile,
  deleteAssetDir,
  generateStyleImagePath,
  ensureStudioAssetsWorkspace,
  getStudioAssetEntityPath,
} from '@/app/lib/integrations/studio-workspace';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { studioInsertScope, studioVisibilityCondition, type StudioScope } from '@/app/lib/integrations/studio-scope';

const MAX_IMAGES_PER_STYLE = 10;

async function getScopedStyle(styleId: string, scope: StudioScope) {
  const [style] = await db.select()
    .from(studioStyles)
    .where(and(eq(studioStyles.id, styleId), eq(studioStyles.workspaceId, scope.workspaceId)));
  return style ?? null;
}

async function getVisibleStyle(styleId: string, scope: StudioScope) {
  const [style] = await db.select()
    .from(studioStyles)
    .where(and(
      eq(studioStyles.id, styleId),
      studioVisibilityCondition(scope, {
        workspaceId: studioStyles.workspaceId,
        createdByUserId: studioStyles.createdByUserId,
      }),
    ));
  return style ?? null;
}

export async function createStyle(
  scope: StudioScope,
  data: { name: string; description?: string }
) {
  await ensureStudioAssetsWorkspace(scope.storage);
  const id = randomUUID();
  const now = new Date();
  const insertScope = studioInsertScope(scope);
  const [inserted] = await db.insert(studioStyles).values({
    id,
    userId: scope.actorUserId,
    ...insertScope,
    name: data.name,
    description: data.description ?? null,
    thumbnailPath: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return inserted;
}

export async function getStyle(styleId: string, scope: StudioScope) {
  const style = await getVisibleStyle(styleId, scope);
  if (!style) return null;
  const images = await db.select().from(studioStyleImages)
    .where(eq(studioStyleImages.styleId, styleId))
    .orderBy(asc(studioStyleImages.sortOrder));
  return { ...style, images, imageCount: images.length };
}

export async function listStyles(scope: StudioScope, search?: string) {
  const conditions = [studioVisibilityCondition(scope, {
    workspaceId: studioStyles.workspaceId,
    createdByUserId: studioStyles.createdByUserId,
  })];
  if (search) {
    conditions.push(like(studioStyles.name, `%${search}%`));
  }
  const styles = await db.select().from(studioStyles)
    .where(and(...conditions))
    .orderBy(desc(studioStyles.createdAt));

  const allStyleIds = styles.map((s) => s.id);
  const allImages = allStyleIds.length > 0
    ? await db.select().from(studioStyleImages)
        .where(inArray(studioStyleImages.styleId, allStyleIds))
        .orderBy(asc(studioStyleImages.sortOrder))
    : [];

  const imagesByStyle = new Map<string, typeof allImages>();
  for (const img of allImages) {
    const arr = imagesByStyle.get(img.styleId) ?? [];
    arr.push(img);
    imagesByStyle.set(img.styleId, arr);
  }

  return styles.map((s) => {
    const images = imagesByStyle.get(s.id) ?? [];
    const imageCount = images.length;
    const thumbnailPath = s.thumbnailPath ?? images[0]?.filePath ?? null;
    return { ...s, images, imageCount, thumbnailPath };
  });
}

export async function updateStyle(
  styleId: string,
  scope: StudioScope,
  data: { name?: string; description?: string }
) {
  const existing = await getScopedStyle(styleId, scope);
  if (!existing) {
    throw new StudioServiceError('Style not found', 'Style nicht gefunden', 'NOT_FOUND');
  }
  const now = new Date();
  const [updated] = await db.update(studioStyles).set({
    ...(data.name !== undefined && { name: data.name }),
    ...(data.description !== undefined && { description: data.description }),
    updatedAt: now,
  }).where(and(eq(studioStyles.id, styleId), eq(studioStyles.workspaceId, scope.workspaceId))).returning();
  return updated;
}

export async function addStyleImage(
  styleId: string,
  scope: StudioScope,
  file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number; sourceType: 'upload' | 'url_import' | 'workspace_import'; sourceUrl?: string }
) {
  const style = await getScopedStyle(styleId, scope);
  if (!style) {
    throw new StudioServiceError('Style not found', 'Style nicht gefunden', 'NOT_FOUND');
  }
  const [countResult] = await db.select({ count: sql<number>`count(*)` })
    .from(studioStyleImages)
    .where(eq(studioStyleImages.styleId, styleId));
  const currentCount = countResult?.count ?? 0;
  if (currentCount >= MAX_IMAGES_PER_STYLE) {
    throw new StudioServiceError(
      'Max images reached',
      `Maximal ${MAX_IMAGES_PER_STYLE} Bilder pro Style erlaubt`,
      'LIMIT_EXCEEDED'
    );
  }
  const sortOrder = currentCount;
  const ext = file.fileName.split('.').pop() || 'jpg';
  const filePath = generateStyleImagePath(styleId, sortOrder, ext, scope.storage);
  await writeAssetFile(filePath, file.buffer);
  const imageId = randomUUID();
  const now = new Date();
  const [insertedImage] = await db.insert(studioStyleImages).values({
    id: imageId,
    styleId,
    filePath,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    sourceType: file.sourceType,
    sourceUrl: file.sourceUrl ?? null,
    sortOrder,
    width: file.width ?? null,
    height: file.height ?? null,
    createdAt: now,
  }).returning();
  if (sortOrder === 0) {
    await db.update(studioStyles).set({ thumbnailPath: filePath, updatedAt: now })
      .where(and(eq(studioStyles.id, styleId), eq(studioStyles.workspaceId, scope.workspaceId)));
  }
  return insertedImage;
}

export async function deleteStyleImage(styleId: string, scope: StudioScope, imageId: string) {
  const style = await getVisibleStyle(styleId, scope);
  if (!style) {
    throw new StudioServiceError('Style not found', 'Style nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioStyleImages)
    .where(and(eq(studioStyleImages.id, imageId), eq(studioStyleImages.styleId, styleId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  await db.delete(studioStyleImages).where(eq(studioStyleImages.id, imageId));
  try {
    await deleteAssetFile(image.filePath);
  } catch (err) {
    console.warn(`Failed to delete asset file ${image.filePath}:`, err);
  }
  if (image.sortOrder === 0) {
    const [nextImage] = await db.select().from(studioStyleImages)
      .where(eq(studioStyleImages.styleId, styleId))
      .orderBy(asc(studioStyleImages.sortOrder))
      .limit(1);
    const now = new Date();
    await db.update(studioStyles).set({
      thumbnailPath: nextImage?.filePath ?? null,
      updatedAt: now,
    }).where(eq(studioStyles.id, styleId));
  }
}

export async function replaceStyleImage(
  styleId: string,
  scope: StudioScope,
  imageId: string,
  file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number }
) {
  const style = await getScopedStyle(styleId, scope);
  if (!style) {
    throw new StudioServiceError('Style not found', 'Style nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioStyleImages)
    .where(and(eq(studioStyleImages.id, imageId), eq(studioStyleImages.styleId, styleId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  const ext = file.fileName.split('.').pop() || 'jpg';
  const newFilePath = generateStyleImagePath(styleId, image.sortOrder, ext, scope.storage);
  await writeAssetFile(newFilePath, file.buffer);
  const now = new Date();
  const [updated] = await db.update(studioStyleImages).set({
    filePath: newFilePath,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    width: file.width ?? null,
    height: file.height ?? null,
  }).where(eq(studioStyleImages.id, imageId)).returning();
  try {
    await deleteAssetFile(image.filePath);
  } catch (err) {
    console.warn(`Failed to delete old asset file ${image.filePath}:`, err);
  }
  if (image.sortOrder === 0) {
    await db.update(studioStyles).set({ thumbnailPath: newFilePath, updatedAt: now })
      .where(and(eq(studioStyles.id, styleId), eq(studioStyles.workspaceId, scope.workspaceId)));
  }
  return updated;
}

export async function getStyleImageBuffer(styleId: string, scope: StudioScope, imageId: string) {
  const style = await getVisibleStyle(styleId, scope);
  if (!style) {
    throw new StudioServiceError('Style not found', 'Style nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioStyleImages)
    .where(and(eq(studioStyleImages.id, imageId), eq(studioStyleImages.styleId, styleId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  try {
    const buffer = await readAssetFile(image.filePath);
    return { buffer, mimeType: image.mimeType, fileName: image.fileName };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await db.delete(studioStyleImages).where(eq(studioStyleImages.id, imageId));
      console.warn(`Auto-cleaned orphaned style image ${imageId}: file missing at ${image.filePath}`);
      throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
    }
    throw error;
  }
}

export async function reorderStyleImages(styleId: string, scope: StudioScope, imageOrder: string[]) {
  const style = await getScopedStyle(styleId, scope);
  if (!style) {
    throw new StudioServiceError('Style not found', 'Style nicht gefunden', 'NOT_FOUND');
  }
  const images = await db.select().from(studioStyleImages)
    .where(eq(studioStyleImages.styleId, styleId));
  const imageMap = new Map(images.map((img) => [img.id, img]));
  for (let i = 0; i < imageOrder.length; i++) {
    const imgId = imageOrder[i];
    if (!imageMap.has(imgId)) {
      throw new StudioServiceError('Image not found', `Bild ${imgId} nicht gefunden`, 'NOT_FOUND');
    }
    await db.update(studioStyleImages).set({ sortOrder: i })
      .where(eq(studioStyleImages.id, imgId));
  }
  if (imageOrder.length > 0) {
    const firstImage = imageMap.get(imageOrder[0]);
    if (firstImage) {
      const now = new Date();
      await db.update(studioStyles).set({ thumbnailPath: firstImage.filePath, updatedAt: now })
        .where(and(eq(studioStyles.id, styleId), eq(studioStyles.workspaceId, scope.workspaceId)));
    }
  }
}

export async function deleteStyle(styleId: string, scope: StudioScope) {
  const style = await getScopedStyle(styleId, scope);
  if (!style) {
    throw new StudioServiceError('Style not found', 'Style nicht gefunden', 'NOT_FOUND');
  }
  const [refResult] = await db.select({ count: sql<number>`count(*)` })
    .from(studioGenerationStyles)
    .where(eq(studioGenerationStyles.styleId, styleId));
  const warnings: { type: string; entity: string; id: string; name: string; affectedGenerations: number }[] = [];
  const affectedGenerations = refResult?.count ?? 0;
  if (affectedGenerations > 0) {
    warnings.push({
      type: 'orphaned_reference',
      entity: 'style',
      id: styleId,
      name: style.name,
      affectedGenerations,
    });
  }
  try {
    await deleteAssetDir(getStudioAssetEntityPath(scope.storage, 'styles', styleId));
  } catch (err) {
    console.warn(`Failed to delete style directory styles/${styleId}/:`, err);
  }
  await db.delete(studioStyles).where(eq(studioStyles.id, styleId));
  return { success: true, warnings };
}
