import 'server-only';

import {
  addPersonaImage,
  createPersona,
  deletePersona,
  getPersona,
  listPersonas,
  updatePersona,
} from '@/app/lib/integrations/studio-persona-service';
import {
  addProductImage,
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
} from '@/app/lib/integrations/studio-product-service';
import type { StudioScope } from '@/app/lib/integrations/studio-scope';
import {
  addStyleImage,
  createStyle,
  deleteStyle,
  getStyle,
  listStyles,
  updateStyle,
} from '@/app/lib/integrations/studio-style-service';

import { MobileStudioError } from './studio';

export type MobileStudioLibraryKind = 'products' | 'personas' | 'styles';

type LibraryImage = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  fileSize: number;
  width?: number;
  height?: number;
  sourceType: 'upload';
};

export function parseMobileStudioLibraryKind(value: unknown): MobileStudioLibraryKind {
  if (value === 'products' || value === 'personas' || value === 'styles') return value;
  throw new MobileStudioError('Studio library kind is invalid.', 400, 'INVALID_LIBRARY_KIND');
}

function serializeEntity(entity: {
  id: string;
  name: string;
  description?: string | null;
  imageCount?: number;
  thumbnailPath?: string | null;
  updatedAt: Date | string | number;
}) {
  return {
    id: entity.id,
    name: entity.name,
    description: entity.description || '',
    imageCount: entity.imageCount || 0,
    hasPreview: Boolean(entity.thumbnailPath),
    updatedAt: new Date(entity.updatedAt).toISOString(),
  };
}

function entityInput(value: unknown, partial = false): { name?: string; description?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MobileStudioError('Studio library input is invalid.', 400, 'INVALID_LIBRARY_INPUT');
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : undefined;
  const description = typeof record.description === 'string' ? record.description.trim().slice(0, 2_000) : undefined;
  if ((!partial || record.name !== undefined) && (!name || name.length > 240)) {
    throw new MobileStudioError('Studio library name is invalid.', 400, 'INVALID_LIBRARY_INPUT');
  }
  if (partial && name === undefined && description === undefined) {
    throw new MobileStudioError('No Studio library changes were provided.', 400, 'INVALID_LIBRARY_INPUT');
  }
  return { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) };
}

export async function listMobileStudioLibrary(kind: MobileStudioLibraryKind, scope: StudioScope) {
  const rows = kind === 'products' ? await listProducts(scope) : kind === 'personas' ? await listPersonas(scope) : await listStyles(scope);
  return rows.map(serializeEntity);
}

export async function createMobileStudioLibraryEntity(kind: MobileStudioLibraryKind, scope: StudioScope, value: unknown) {
  const input = entityInput(value);
  const created = kind === 'products'
    ? await createProduct(scope, { name: input.name!, description: input.description })
    : kind === 'personas'
      ? await createPersona(scope, { name: input.name!, description: input.description })
      : await createStyle(scope, { name: input.name!, description: input.description });
  const detail = kind === 'products' ? await getProduct(created.id, scope) : kind === 'personas' ? await getPersona(created.id, scope) : await getStyle(created.id, scope);
  return serializeEntity(detail || { ...created, imageCount: 0 });
}

export async function updateMobileStudioLibraryEntity(kind: MobileStudioLibraryKind, entityId: string, scope: StudioScope, value: unknown) {
  const input = entityInput(value, true);
  if (kind === 'products') await updateProduct(entityId, scope, input);
  else if (kind === 'personas') await updatePersona(entityId, scope, input);
  else await updateStyle(entityId, scope, input);
  const detail = kind === 'products' ? await getProduct(entityId, scope) : kind === 'personas' ? await getPersona(entityId, scope) : await getStyle(entityId, scope);
  if (!detail) throw new MobileStudioError('Studio library item was not found.', 404, 'LIBRARY_ITEM_NOT_FOUND');
  return serializeEntity(detail);
}

export async function deleteMobileStudioLibraryEntity(kind: MobileStudioLibraryKind, entityId: string, scope: StudioScope) {
  if (kind === 'products') return deleteProduct(entityId, scope);
  if (kind === 'personas') return deletePersona(entityId, scope);
  return deleteStyle(entityId, scope);
}

export async function addMobileStudioLibraryImage(kind: MobileStudioLibraryKind, entityId: string, scope: StudioScope, image: LibraryImage) {
  if (!image.mimeType.startsWith('image/') || image.fileSize <= 0 || image.fileSize > 10 * 1024 * 1024) {
    throw new MobileStudioError('Library images must be images up to 10 MB.', 400, 'INVALID_LIBRARY_IMAGE');
  }
  if (kind === 'products') await addProductImage(entityId, scope, image);
  else if (kind === 'personas') await addPersonaImage(entityId, scope, image);
  else await addStyleImage(entityId, scope, image);
  const detail = kind === 'products' ? await getProduct(entityId, scope) : kind === 'personas' ? await getPersona(entityId, scope) : await getStyle(entityId, scope);
  if (!detail) throw new MobileStudioError('Studio library item was not found.', 404, 'LIBRARY_ITEM_NOT_FOUND');
  return serializeEntity(detail);
}
