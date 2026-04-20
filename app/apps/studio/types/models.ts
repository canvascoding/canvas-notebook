export interface StudioProduct {
  id: string;
  userId: string;
  name: string;
  description?: string;
  thumbnailPath?: string;
  metadata?: Record<string, unknown>;
  images: StudioProductImage[];
  imageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioProductImage {
  id: string;
  productId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  sourceType: 'upload' | 'url_import';
  sourceUrl?: string;
  sortOrder: number;
  width?: number;
  height?: number;
  createdAt: string;
}

export interface StudioPersona {
  id: string;
  userId: string;
  name: string;
  description?: string;
  thumbnailPath?: string;
  metadata?: Record<string, unknown>;
  images: StudioPersonaImage[];
  imageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioPersonaImage {
  id: string;
  personaId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  sourceType: 'upload' | 'url_import';
  sourceUrl?: string;
  sortOrder: number;
  width?: number;
  height?: number;
  createdAt: string;
}