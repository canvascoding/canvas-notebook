import type { StudioPreset } from './presets';

export type StudioGenerationMode = 'image' | 'video';
export type StudioGenerationStatus = 'pending' | 'generating' | 'completed' | 'failed';

export interface StudioGenerationOutput {
  id: string;
  generationId: string;
  variationIndex: number;
  type: 'image' | 'video';
  filePath: string;
  mediaUrl: string | null;
  fileSize: number | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  isFavorite: boolean;
  createdAt: string;
  metadata?: string | null;
}

export interface StudioGeneration {
  id: string;
  userId: string;
  mode: StudioGenerationMode;
  prompt: string | null;
  rawPrompt: string | null;
  studioPresetId: string | null;
  aspectRatio: string;
  provider: string;
  model: string;
  status: StudioGenerationStatus;
  outputs: StudioGenerationOutput[];
  products?: string[];
  personas?: string[];
  product_ids?: string[];
  persona_ids?: string[];
  studioPreset?: StudioPreset | null;
  createdAt: string;
  updatedAt: string;
  metadata?: string | null;
}

export interface StudioGeneratePayload {
  prompt: string;
  mode?: StudioGenerationMode;
  product_ids?: string[];
  persona_ids?: string[];
  preset_id?: string;
  aspect_ratio?: string;
  count?: number;
  provider?: string;
  model?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  output_format?: 'png' | 'jpeg' | 'webp';
  background?: 'transparent' | 'opaque' | 'auto';
  source_output_id?: string;
  extra_reference_urls?: string[];
}

export interface StudioReferenceUrl {
  localUrl: string;
  originalUrl: string;
  status: 'loading' | 'error' | 'success';
  errorMessage?: string;
}

export interface StudioGenerateResponse {
  success: boolean;
  generationId: string;
  status: StudioGenerationStatus;
  mode: StudioGenerationMode;
  prompt: string;
  outputs: StudioGenerationOutput[];
}
