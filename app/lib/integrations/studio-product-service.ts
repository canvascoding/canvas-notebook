import { randomUUID } from 'node:crypto';
import { db } from '@/app/lib/db';
import { studioProducts, studioProductImages, studioGenerationProducts } from '@/app/lib/db/schema';
import { eq, and, like, inArray, sql, desc, asc } from 'drizzle-orm';
import {
  writeAssetFile,
  readAssetFile,
  deleteAssetFile,
  deleteAssetDir,
  generateProductImagePath,
  ensureStudioAssetsWorkspace,
  getStudioAssetEntityPath,
} from '@/app/lib/integrations/studio-workspace';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { studioInsertScope, studioVisibilityCondition, type StudioScope } from '@/app/lib/integrations/studio-scope';

const MAX_IMAGES_PER_PRODUCT = 10;

async function getScopedProduct(productId: string, scope: StudioScope) {
  const [product] = await db.select()
    .from(studioProducts)
    .where(and(eq(studioProducts.id, productId), eq(studioProducts.workspaceId, scope.workspaceId)));
  return product ?? null;
}

async function getVisibleProduct(productId: string, scope: StudioScope) {
  const [product] = await db.select()
    .from(studioProducts)
    .where(and(
      eq(studioProducts.id, productId),
      studioVisibilityCondition(scope, {
        workspaceId: studioProducts.workspaceId,
        createdByUserId: studioProducts.createdByUserId,
      }),
    ));
  return product ?? null;
}

export async function createProduct(
  scope: StudioScope,
  data: { name: string; description?: string }
) {
  await ensureStudioAssetsWorkspace(scope.storage);
  const id = randomUUID();
  const now = new Date();
  const insertScope = studioInsertScope(scope);
  const [inserted] = await db.insert(studioProducts).values({
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

export async function getProduct(productId: string, scope: StudioScope) {
  const product = await getVisibleProduct(productId, scope);
  if (!product) return null;
  const images = await db.select().from(studioProductImages)
    .where(eq(studioProductImages.productId, productId))
    .orderBy(asc(studioProductImages.sortOrder));
  return { ...product, images, imageCount: images.length };
}

export async function listProducts(scope: StudioScope, search?: string) {
  const conditions = [studioVisibilityCondition(scope, {
    workspaceId: studioProducts.workspaceId,
    createdByUserId: studioProducts.createdByUserId,
  })];
  if (search) {
    conditions.push(like(studioProducts.name, `%${search}%`));
  }
  const products = await db.select().from(studioProducts)
    .where(and(...conditions))
    .orderBy(desc(studioProducts.createdAt));

  const allProductIds = products.map((p) => p.id);
  const allImages = allProductIds.length > 0
    ? await db.select().from(studioProductImages)
        .where(inArray(studioProductImages.productId, allProductIds))
        .orderBy(asc(studioProductImages.sortOrder))
    : [];

  const imagesByProduct = new Map<string, typeof allImages>();
  for (const img of allImages) {
    const arr = imagesByProduct.get(img.productId) ?? [];
    arr.push(img);
    imagesByProduct.set(img.productId, arr);
  }

  return products.map((p) => {
    const images = imagesByProduct.get(p.id) ?? [];
    const imageCount = images.length;
    const thumbnailPath = p.thumbnailPath ?? images[0]?.filePath ?? null;
    return { ...p, images, imageCount, thumbnailPath };
  });
}

export async function updateProduct(
  productId: string,
  scope: StudioScope,
  data: { name?: string; description?: string }
) {
  const existing = await getScopedProduct(productId, scope);
  if (!existing) {
    throw new StudioServiceError('Product not found', 'Produkt nicht gefunden', 'NOT_FOUND');
  }
  const now = new Date();
  const [updated] = await db.update(studioProducts).set({
    ...(data.name !== undefined && { name: data.name }),
    ...(data.description !== undefined && { description: data.description }),
    updatedAt: now,
  }).where(and(eq(studioProducts.id, productId), eq(studioProducts.workspaceId, scope.workspaceId))).returning();
  return updated;
}

export async function addProductImage(
  productId: string,
  scope: StudioScope,
  file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number; sourceType: 'upload' | 'url_import' | 'workspace_import'; sourceUrl?: string }
) {
  const product = await getScopedProduct(productId, scope);
  if (!product) {
    throw new StudioServiceError('Product not found', 'Produkt nicht gefunden', 'NOT_FOUND');
  }
  const [countResult] = await db.select({ count: sql<number>`count(*)` })
    .from(studioProductImages)
    .where(eq(studioProductImages.productId, productId));
  const currentCount = countResult?.count ?? 0;
  if (currentCount >= MAX_IMAGES_PER_PRODUCT) {
    throw new StudioServiceError(
      'Max images reached',
      `Maximal ${MAX_IMAGES_PER_PRODUCT} Bilder pro Produkt erlaubt`,
      'LIMIT_EXCEEDED'
    );
  }
  const sortOrder = currentCount;
  const ext = file.fileName.split('.').pop() || 'jpg';
  const filePath = generateProductImagePath(productId, sortOrder, ext, scope.storage);
  await writeAssetFile(filePath, file.buffer);
  const imageId = randomUUID();
  const now = new Date();
  const [insertedImage] = await db.insert(studioProductImages).values({
    id: imageId,
    productId,
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
    await db.update(studioProducts).set({ thumbnailPath: filePath, updatedAt: now })
      .where(and(eq(studioProducts.id, productId), eq(studioProducts.workspaceId, scope.workspaceId)));
  }
  return insertedImage;
}

export async function deleteProductImage(productId: string, scope: StudioScope, imageId: string) {
  const product = await getVisibleProduct(productId, scope);
  if (!product) {
    throw new StudioServiceError('Product not found', 'Produkt nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioProductImages)
    .where(and(eq(studioProductImages.id, imageId), eq(studioProductImages.productId, productId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  await db.delete(studioProductImages).where(eq(studioProductImages.id, imageId));
  try {
    await deleteAssetFile(image.filePath);
  } catch (err) {
    console.warn(`Failed to delete asset file ${image.filePath}:`, err);
  }
  if (image.sortOrder === 0) {
    const [nextImage] = await db.select().from(studioProductImages)
      .where(eq(studioProductImages.productId, productId))
      .orderBy(asc(studioProductImages.sortOrder))
      .limit(1);
    const now = new Date();
    await db.update(studioProducts).set({
      thumbnailPath: nextImage?.filePath ?? null,
      updatedAt: now,
    }).where(eq(studioProducts.id, productId));
  }
}

export async function replaceProductImage(
  productId: string,
  scope: StudioScope,
  imageId: string,
  file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number }
) {
  const product = await getScopedProduct(productId, scope);
  if (!product) {
    throw new StudioServiceError('Product not found', 'Produkt nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioProductImages)
    .where(and(eq(studioProductImages.id, imageId), eq(studioProductImages.productId, productId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  const ext = file.fileName.split('.').pop() || 'jpg';
  const newFilePath = generateProductImagePath(productId, image.sortOrder, ext, scope.storage);
  await writeAssetFile(newFilePath, file.buffer);
  const now = new Date();
  const [updated] = await db.update(studioProductImages).set({
    filePath: newFilePath,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    width: file.width ?? null,
    height: file.height ?? null,
  }).where(eq(studioProductImages.id, imageId)).returning();
  try {
    await deleteAssetFile(image.filePath);
  } catch (err) {
    console.warn(`Failed to delete old asset file ${image.filePath}:`, err);
  }
  if (image.sortOrder === 0) {
    await db.update(studioProducts).set({ thumbnailPath: newFilePath, updatedAt: now })
      .where(and(eq(studioProducts.id, productId), eq(studioProducts.workspaceId, scope.workspaceId)));
  }
  return updated;
}

export async function getProductImageBuffer(productId: string, scope: StudioScope, imageId: string) {
  const product = await getVisibleProduct(productId, scope);
  if (!product) {
    throw new StudioServiceError('Product not found', 'Produkt nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioProductImages)
    .where(and(eq(studioProductImages.id, imageId), eq(studioProductImages.productId, productId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  try {
    const buffer = await readAssetFile(image.filePath);
    return { buffer, mimeType: image.mimeType, fileName: image.fileName };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await db.delete(studioProductImages).where(eq(studioProductImages.id, imageId));
      console.warn(`Auto-cleaned orphaned product image ${imageId}: file missing at ${image.filePath}`);
      throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
    }
    throw error;
  }
}

export async function reorderProductImages(productId: string, scope: StudioScope, imageOrder: string[]) {
  const product = await getScopedProduct(productId, scope);
  if (!product) {
    throw new StudioServiceError('Product not found', 'Produkt nicht gefunden', 'NOT_FOUND');
  }
  const images = await db.select().from(studioProductImages)
    .where(eq(studioProductImages.productId, productId));
  const imageMap = new Map(images.map((img) => [img.id, img]));
  for (let i = 0; i < imageOrder.length; i++) {
    const imgId = imageOrder[i];
    if (!imageMap.has(imgId)) {
      throw new StudioServiceError('Image not found', `Bild ${imgId} nicht gefunden`, 'NOT_FOUND');
    }
    await db.update(studioProductImages).set({ sortOrder: i })
      .where(eq(studioProductImages.id, imgId));
  }
  if (imageOrder.length > 0) {
    const firstImage = imageMap.get(imageOrder[0]);
    if (firstImage) {
      const now = new Date();
      await db.update(studioProducts).set({ thumbnailPath: firstImage.filePath, updatedAt: now })
        .where(and(eq(studioProducts.id, productId), eq(studioProducts.workspaceId, scope.workspaceId)));
    }
  }
}

export async function deleteProduct(productId: string, scope: StudioScope) {
  const product = await getScopedProduct(productId, scope);
  if (!product) {
    throw new StudioServiceError('Product not found', 'Produkt nicht gefunden', 'NOT_FOUND');
  }
  const [refResult] = await db.select({ count: sql<number>`count(*)` })
    .from(studioGenerationProducts)
    .where(eq(studioGenerationProducts.productId, productId));
  const warnings: { type: string; entity: string; id: string; name: string; affectedGenerations: number }[] = [];
  const affectedGenerations = refResult?.count ?? 0;
  if (affectedGenerations > 0) {
    warnings.push({
      type: 'orphaned_reference',
      entity: 'product',
      id: productId,
      name: product.name,
      affectedGenerations,
    });
  }
  try {
    await deleteAssetDir(getStudioAssetEntityPath(scope.storage, 'products', productId));
  } catch (err) {
    console.warn(`Failed to delete product directory products/${productId}/:`, err);
  }
  await db.delete(studioProducts).where(eq(studioProducts.id, productId));
  return { success: true, warnings };
}
