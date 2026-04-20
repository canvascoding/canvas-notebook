import { randomUUID } from 'node:crypto';
import { db } from '@/app/lib/db';
import { studioProducts, studioProductImages, studioGenerationProducts } from '@/app/lib/db/schema';
import { eq, and, like, sql, desc, asc } from 'drizzle-orm';
import {
  writeAssetFile,
  readAssetFile,
  deleteAssetFile,
  deleteAssetDir,
  generateProductImagePath,
  ensureStudioAssetsWorkspace,
} from '@/app/lib/integrations/studio-workspace';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

const MAX_IMAGES_PER_PRODUCT = 10;

export async function createProduct(
  userId: string,
  data: { name: string; description?: string }
) {
  await ensureStudioAssetsWorkspace();
  const id = randomUUID();
  const now = new Date();
  const [inserted] = await db.insert(studioProducts).values({
    id,
    userId,
    name: data.name,
    description: data.description ?? null,
    thumbnailPath: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return inserted;
}

export async function getProduct(productId: string) {
  const [product] = await db.select().from(studioProducts).where(eq(studioProducts.id, productId));
  if (!product) return null;
  const images = await db.select().from(studioProductImages)
    .where(eq(studioProductImages.productId, productId))
    .orderBy(asc(studioProductImages.sortOrder));
  return { ...product, images, imageCount: images.length };
}

export async function listProducts(userId: string, search?: string) {
  const conditions = [eq(studioProducts.userId, userId)];
  if (search) {
    conditions.push(like(studioProducts.name, `%${search}%`));
  }
  const products = await db.select().from(studioProducts)
    .where(and(...conditions))
    .orderBy(desc(studioProducts.createdAt));

  const productsWithCounts = await Promise.all(products.map(async (p) => {
    const [imgResult] = await db.select({ count: sql<number>`count(*)` })
      .from(studioProductImages)
      .where(eq(studioProductImages.productId, p.id));
    const imageCount = imgResult?.count ?? 0;
    let thumbnailPath = p.thumbnailPath;
    if (!thumbnailPath && imageCount > 0) {
      const [firstImage] = await db.select().from(studioProductImages)
        .where(eq(studioProductImages.productId, p.id))
        .orderBy(asc(studioProductImages.sortOrder))
        .limit(1);
      thumbnailPath = firstImage?.filePath ?? null;
    }
    return { ...p, imageCount, thumbnailPath };
  }));
  return productsWithCounts;
}

export async function updateProduct(
  productId: string,
  data: { name?: string; description?: string }
) {
  const [existing] = await db.select().from(studioProducts).where(eq(studioProducts.id, productId));
  if (!existing) {
    throw new StudioServiceError('Product not found', 'Produkt nicht gefunden', 'NOT_FOUND');
  }
  const now = new Date();
  const [updated] = await db.update(studioProducts).set({
    ...(data.name !== undefined && { name: data.name }),
    ...(data.description !== undefined && { description: data.description }),
    updatedAt: now,
  }).where(eq(studioProducts.id, productId)).returning();
  return updated;
}

export async function addProductImage(
  productId: string,
  file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number; sourceType: 'upload' | 'url_import'; sourceUrl?: string }
) {
  const [product] = await db.select().from(studioProducts).where(eq(studioProducts.id, productId));
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
  const filePath = generateProductImagePath(productId, sortOrder, ext);
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
      .where(eq(studioProducts.id, productId));
  }
  return insertedImage;
}

export async function deleteProductImage(productId: string, imageId: string) {
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
  imageId: string,
  file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number }
) {
  const [image] = await db.select().from(studioProductImages)
    .where(and(eq(studioProductImages.id, imageId), eq(studioProductImages.productId, productId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  const ext = file.fileName.split('.').pop() || 'jpg';
  const newFilePath = generateProductImagePath(productId, image.sortOrder, ext);
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
      .where(eq(studioProducts.id, productId));
  }
  return updated;
}

export async function getProductImageBuffer(imageId: string) {
  const [image] = await db.select().from(studioProductImages).where(eq(studioProductImages.id, imageId));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  const buffer = await readAssetFile(image.filePath);
  return { buffer, mimeType: image.mimeType, fileName: image.fileName };
}

export async function reorderProductImages(productId: string, imageOrder: string[]) {
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
        .where(eq(studioProducts.id, productId));
    }
  }
}

export async function deleteProduct(productId: string) {
  const [product] = await db.select().from(studioProducts).where(eq(studioProducts.id, productId));
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
    await deleteAssetDir(`products/${productId}/`);
  } catch (err) {
    console.warn(`Failed to delete product directory products/${productId}/:`, err);
  }
  await db.delete(studioProducts).where(eq(studioProducts.id, productId));
  return { success: true, warnings };
}