import { randomUUID } from 'node:crypto';
import { db } from '@/app/lib/db';
import { studioPersonas, studioPersonaImages, studioGenerationPersonas } from '@/app/lib/db/schema';
import { eq, and, like, sql, desc, asc } from 'drizzle-orm';
import {
  writeAssetFile,
  readAssetFile,
  deleteAssetFile,
  deleteAssetDir,
  generatePersonaImagePath,
  ensureStudioAssetsWorkspace,
} from '@/app/lib/integrations/studio-workspace';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

const MAX_IMAGES_PER_PERSONA = 10;

async function getOwnedPersona(personaId: string, userId: string) {
  const [persona] = await db.select()
    .from(studioPersonas)
    .where(and(eq(studioPersonas.id, personaId), eq(studioPersonas.userId, userId)));
  return persona ?? null;
}

export async function createPersona(
  userId: string,
  data: { name: string; description?: string }
) {
  await ensureStudioAssetsWorkspace();
  const id = randomUUID();
  const now = new Date();
  const [inserted] = await db.insert(studioPersonas).values({
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

export async function getPersona(personaId: string, userId: string) {
  const persona = await getOwnedPersona(personaId, userId);
  if (!persona) return null;
  const images = await db.select().from(studioPersonaImages)
    .where(eq(studioPersonaImages.personaId, personaId))
    .orderBy(asc(studioPersonaImages.sortOrder));
  return { ...persona, images, imageCount: images.length };
}

export async function listPersonas(userId: string, search?: string) {
  const conditions = [eq(studioPersonas.userId, userId)];
  if (search) {
    conditions.push(like(studioPersonas.name, `%${search}%`));
  }
  const personas = await db.select().from(studioPersonas)
    .where(and(...conditions))
    .orderBy(desc(studioPersonas.createdAt));

  const allPersonaIds = personas.map((p) => p.id);
  const allImages = allPersonaIds.length > 0
    ? await db.select().from(studioPersonaImages)
        .where(sql`${studioPersonaImages.personaId} IN (${sql.join(allPersonaIds.map((id) => sql`${id}`), sql`, `)})`)
        .orderBy(asc(studioPersonaImages.sortOrder))
    : [];

  const imagesByPersona = new Map<string, typeof allImages>();
  for (const img of allImages) {
    const arr = imagesByPersona.get(img.personaId) ?? [];
    arr.push(img);
    imagesByPersona.set(img.personaId, arr);
  }

  return personas.map((p) => {
    const images = imagesByPersona.get(p.id) ?? [];
    const imageCount = images.length;
    const thumbnailPath = p.thumbnailPath ?? images[0]?.filePath ?? null;
    return { ...p, images, imageCount, thumbnailPath };
  });
}

export async function updatePersona(
  personaId: string,
  userId: string,
  data: { name?: string; description?: string }
) {
  const existing = await getOwnedPersona(personaId, userId);
  if (!existing) {
    throw new StudioServiceError('Persona not found', 'Persona nicht gefunden', 'NOT_FOUND');
  }
  const now = new Date();
  const [updated] = await db.update(studioPersonas).set({
    ...(data.name !== undefined && { name: data.name }),
    ...(data.description !== undefined && { description: data.description }),
    updatedAt: now,
  }).where(and(eq(studioPersonas.id, personaId), eq(studioPersonas.userId, userId))).returning();
  return updated;
}

export async function addPersonaImage(
  personaId: string,
  userId: string,
  file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number; sourceType: 'upload' | 'url_import'; sourceUrl?: string }
) {
  const persona = await getOwnedPersona(personaId, userId);
  if (!persona) {
    throw new StudioServiceError('Persona not found', 'Persona nicht gefunden', 'NOT_FOUND');
  }
  const [countResult] = await db.select({ count: sql<number>`count(*)` })
    .from(studioPersonaImages)
    .where(eq(studioPersonaImages.personaId, personaId));
  const currentCount = countResult?.count ?? 0;
  if (currentCount >= MAX_IMAGES_PER_PERSONA) {
    throw new StudioServiceError(
      'Max images reached',
      `Maximal ${MAX_IMAGES_PER_PERSONA} Bilder pro Persona erlaubt`,
      'LIMIT_EXCEEDED'
    );
  }
  const sortOrder = currentCount;
  const ext = file.fileName.split('.').pop() || 'jpg';
  const filePath = generatePersonaImagePath(personaId, sortOrder, ext);
  await writeAssetFile(filePath, file.buffer);
  const imageId = randomUUID();
  const now = new Date();
  const [insertedImage] = await db.insert(studioPersonaImages).values({
    id: imageId,
    personaId,
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
    await db.update(studioPersonas).set({ thumbnailPath: filePath, updatedAt: now })
      .where(and(eq(studioPersonas.id, personaId), eq(studioPersonas.userId, userId)));
  }
  return insertedImage;
}

export async function deletePersonaImage(personaId: string, userId: string, imageId: string) {
  const persona = await getOwnedPersona(personaId, userId);
  if (!persona) {
    throw new StudioServiceError('Persona not found', 'Persona nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioPersonaImages)
    .where(and(eq(studioPersonaImages.id, imageId), eq(studioPersonaImages.personaId, personaId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  await db.delete(studioPersonaImages).where(eq(studioPersonaImages.id, imageId));
  try {
    await deleteAssetFile(image.filePath);
  } catch (err) {
    console.warn(`Failed to delete asset file ${image.filePath}:`, err);
  }
  if (image.sortOrder === 0) {
    const [nextImage] = await db.select().from(studioPersonaImages)
      .where(eq(studioPersonaImages.personaId, personaId))
      .orderBy(asc(studioPersonaImages.sortOrder))
      .limit(1);
    const now = new Date();
    await db.update(studioPersonas).set({
      thumbnailPath: nextImage?.filePath ?? null,
      updatedAt: now,
    }).where(and(eq(studioPersonas.id, personaId), eq(studioPersonas.userId, userId)));
  }
}

export async function replacePersonaImage(
  personaId: string,
  userId: string,
  imageId: string,
  file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number; width?: number; height?: number }
) {
  const persona = await getOwnedPersona(personaId, userId);
  if (!persona) {
    throw new StudioServiceError('Persona not found', 'Persona nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioPersonaImages)
    .where(and(eq(studioPersonaImages.id, imageId), eq(studioPersonaImages.personaId, personaId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  const ext = file.fileName.split('.').pop() || 'jpg';
  const newFilePath = generatePersonaImagePath(personaId, image.sortOrder, ext);
  await writeAssetFile(newFilePath, file.buffer);
  const now = new Date();
  const [updated] = await db.update(studioPersonaImages).set({
    filePath: newFilePath,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    width: file.width ?? null,
    height: file.height ?? null,
  }).where(eq(studioPersonaImages.id, imageId)).returning();
  try {
    await deleteAssetFile(image.filePath);
  } catch (err) {
    console.warn(`Failed to delete old asset file ${image.filePath}:`, err);
  }
  if (image.sortOrder === 0) {
    await db.update(studioPersonas).set({ thumbnailPath: newFilePath, updatedAt: now })
      .where(and(eq(studioPersonas.id, personaId), eq(studioPersonas.userId, userId)));
  }
  return updated;
}

export async function getPersonaImageBuffer(personaId: string, userId: string, imageId: string) {
  const persona = await getOwnedPersona(personaId, userId);
  if (!persona) {
    throw new StudioServiceError('Persona not found', 'Persona nicht gefunden', 'NOT_FOUND');
  }
  const [image] = await db.select().from(studioPersonaImages)
    .where(and(eq(studioPersonaImages.id, imageId), eq(studioPersonaImages.personaId, personaId)));
  if (!image) {
    throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
  }
  try {
    const buffer = await readAssetFile(image.filePath);
    return { buffer, mimeType: image.mimeType, fileName: image.fileName };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await db.delete(studioPersonaImages).where(eq(studioPersonaImages.id, imageId));
      console.warn(`Auto-cleaned orphaned persona image ${imageId}: file missing at ${image.filePath}`);
      throw new StudioServiceError('Image not found', 'Bild nicht gefunden', 'NOT_FOUND');
    }
    throw error;
  }
}

export async function reorderPersonaImages(personaId: string, userId: string, imageOrder: string[]) {
  const persona = await getOwnedPersona(personaId, userId);
  if (!persona) {
    throw new StudioServiceError('Persona not found', 'Persona nicht gefunden', 'NOT_FOUND');
  }
  const images = await db.select().from(studioPersonaImages)
    .where(eq(studioPersonaImages.personaId, personaId));
  const imageMap = new Map(images.map((img) => [img.id, img]));
  for (let i = 0; i < imageOrder.length; i++) {
    const imgId = imageOrder[i];
    if (!imageMap.has(imgId)) {
      throw new StudioServiceError('Image not found', `Bild ${imgId} nicht gefunden`, 'NOT_FOUND');
    }
    await db.update(studioPersonaImages).set({ sortOrder: i })
      .where(eq(studioPersonaImages.id, imgId));
  }
  if (imageOrder.length > 0) {
    const firstImage = imageMap.get(imageOrder[0]);
    if (firstImage) {
      const now = new Date();
      await db.update(studioPersonas).set({ thumbnailPath: firstImage.filePath, updatedAt: now })
        .where(and(eq(studioPersonas.id, personaId), eq(studioPersonas.userId, userId)));
    }
  }
}

export async function deletePersona(personaId: string, userId: string) {
  const persona = await getOwnedPersona(personaId, userId);
  if (!persona) {
    throw new StudioServiceError('Persona not found', 'Persona nicht gefunden', 'NOT_FOUND');
  }
  const [refResult] = await db.select({ count: sql<number>`count(*)` })
    .from(studioGenerationPersonas)
    .where(eq(studioGenerationPersonas.personaId, personaId));
  const warnings: { type: string; entity: string; id: string; name: string; affectedGenerations: number }[] = [];
  const affectedGenerations = refResult?.count ?? 0;
  if (affectedGenerations > 0) {
    warnings.push({
      type: 'orphaned_reference',
      entity: 'persona',
      id: personaId,
      name: persona.name,
      affectedGenerations,
    });
  }
  try {
    await deleteAssetDir(`personas/${personaId}/`);
  } catch (err) {
    console.warn(`Failed to delete persona directory personas/${personaId}/:`, err);
  }
  await db.delete(studioPersonas).where(and(eq(studioPersonas.id, personaId), eq(studioPersonas.userId, userId)));
  return { success: true, warnings };
}
