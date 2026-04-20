import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { studioPresets } from '@/app/lib/db/schema';
import { getImageGenerationProvider } from '@/app/lib/integrations/image-generation-providers';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import {
  deleteAssetDir,
  ensureStudioAssetsWorkspace,
  generatePresetPreviewPath,
  writeAssetFile,
} from '@/app/lib/integrations/studio-workspace';
import { ensureDefaultStudioPresetsSeeded } from '@/app/lib/integrations/studio-preset-defaults';
import { toMediaUrl } from '@/app/lib/utils/media-url';

const PRESET_CATEGORIES = [
  'fashion',
  'product',
  'food',
  'lifestyle',
  'beauty',
  'tech',
  'interior',
  'automotive',
] as const;

const PRESET_BLOCK_TYPES = ['lighting', 'camera', 'props', 'background', 'subject'] as const;
const PRESET_BLOCK_ORDER = ['lighting', 'camera', 'background', 'props', 'subject'] as const;

type PresetCategory = typeof PRESET_CATEGORIES[number];
type PresetBlockType = typeof PRESET_BLOCK_TYPES[number];

export interface StudioPresetBlockDefinition {
  id: string;
  type: PresetBlockType;
  label: string;
  promptFragment: string;
  category: string;
  description: string;
}

export interface StudioPresetBlockInput {
  id?: string;
  type: string;
  label: string;
  promptFragment: string;
  category?: string;
  description?: string;
  thumbnailPath?: string | null;
}

export interface StudioPresetRecord {
  id: string;
  userId: string | null;
  isDefault: boolean;
  name: string;
  description: string | null;
  category: string | null;
  blocks: StudioPresetBlockInput[];
  previewImagePath: string | null;
  previewImageUrl: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface CreatePresetInput {
  name: string;
  description?: string;
  category?: string | null;
  blocks: StudioPresetBlockInput[];
  tags?: string[];
}

interface UpdatePresetInput {
  name?: string;
  description?: string | null;
  category?: string | null;
  blocks?: StudioPresetBlockInput[];
  tags?: string[];
}

interface GeneratePresetPreviewInput {
  provider?: string;
  model?: string;
  aspectRatio?: string;
}

const BLOCK_CATALOG: Record<PresetBlockType, StudioPresetBlockDefinition[]> = {
  lighting: [
    {
      id: 'lighting-softbox-clean',
      type: 'lighting',
      label: 'Softbox Clean',
      promptFragment: 'softbox key light with clean commercial highlights',
      category: 'commercial',
      description: 'Even studio light with soft reflections for polished product shots.',
    },
    {
      id: 'lighting-golden-hour',
      type: 'lighting',
      label: 'Golden Hour',
      promptFragment: 'warm golden-hour light with long soft shadows',
      category: 'editorial',
      description: 'Warm directional light for lifestyle and fashion scenes.',
    },
    {
      id: 'lighting-neon-contrast',
      type: 'lighting',
      label: 'Neon Contrast',
      promptFragment: 'high-contrast neon rim light with cinematic glow',
      category: 'cinematic',
      description: 'Moody colored light for tech and nightlife aesthetics.',
    },
  ],
  camera: [
    {
      id: 'camera-close-macro',
      type: 'camera',
      label: 'Close Macro',
      promptFragment: 'macro lens close-up with crisp texture detail',
      category: 'detail',
      description: 'Tight framing that emphasizes texture and material quality.',
    },
    {
      id: 'camera-editorial-three-quarter',
      type: 'camera',
      label: 'Editorial 3/4',
      promptFragment: 'editorial three-quarter camera angle with natural perspective',
      category: 'editorial',
      description: 'Balanced hero angle for products, portraits, and interiors.',
    },
    {
      id: 'camera-top-down',
      type: 'camera',
      label: 'Top Down',
      promptFragment: 'top-down flat-lay composition with symmetrical framing',
      category: 'layout',
      description: 'Flat-lay perspective for food, beauty, and tabletop scenes.',
    },
  ],
  props: [
    {
      id: 'props-minimal-accent',
      type: 'props',
      label: 'Minimal Accent',
      promptFragment: 'minimal styling props with subtle premium accents',
      category: 'minimal',
      description: 'A restrained prop setup that supports the subject without clutter.',
    },
    {
      id: 'props-organic-texture',
      type: 'props',
      label: 'Organic Texture',
      promptFragment: 'organic textural props like linen, stone, and ceramic',
      category: 'organic',
      description: 'Natural supporting materials for lifestyle and interior moods.',
    },
    {
      id: 'props-tech-precision',
      type: 'props',
      label: 'Tech Precision',
      promptFragment: 'precision-engineered props with metallic and glass accents',
      category: 'tech',
      description: 'Structured prop styling for devices and futuristic products.',
    },
  ],
  background: [
    {
      id: 'background-seamless-white',
      type: 'background',
      label: 'Seamless White',
      promptFragment: 'seamless white studio backdrop',
      category: 'studio',
      description: 'Clean isolated backdrop for catalog and ecommerce imagery.',
    },
    {
      id: 'background-muted-gradient',
      type: 'background',
      label: 'Muted Gradient',
      promptFragment: 'muted tonal gradient background with depth',
      category: 'studio',
      description: 'Subtle color transitions that feel elevated without distraction.',
    },
    {
      id: 'background-architectural',
      type: 'background',
      label: 'Architectural Space',
      promptFragment: 'architectural interior background with modern lines',
      category: 'environment',
      description: 'Structured background for interior, automotive, and lifestyle setups.',
    },
  ],
  subject: [
    {
      id: 'subject-hero-product',
      type: 'subject',
      label: 'Hero Product',
      promptFragment: 'hero product centered as the clear visual focus',
      category: 'product',
      description: 'Puts the product in primary focus for commercial hero renders.',
    },
    {
      id: 'subject-editorial-model',
      type: 'subject',
      label: 'Editorial Model',
      promptFragment: 'editorial model pose with confident natural posture',
      category: 'fashion',
      description: 'Human-centered composition for fashion and beauty imagery.',
    },
    {
      id: 'subject-styled-scene',
      type: 'subject',
      label: 'Styled Scene',
      promptFragment: 'styled scene composition with a cohesive narrative focal point',
      category: 'lifestyle',
      description: 'Narrative scene framing for interior and lifestyle presets.',
    },
  ],
};

function normalizeOptionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateCategory(category?: string | null): string | null {
  if (category === undefined) return null;
  if (category === null) return null;
  const trimmed = category.trim().toLowerCase();
  if (!trimmed) return null;
  if (!PRESET_CATEGORIES.includes(trimmed as PresetCategory)) {
    throw new StudioServiceError(
      `Unsupported preset category: ${category}`,
      `Ungültige Preset-Kategorie. Erlaubt sind: ${PRESET_CATEGORIES.join(', ')}`,
      'INVALID_CATEGORY',
    );
  }
  return trimmed;
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized.slice(0, 20);
}

function normalizeBlocks(blocks: StudioPresetBlockInput[]): StudioPresetBlockInput[] {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new StudioServiceError(
      'Preset blocks are required',
      'Ein Preset muss mindestens einen Block enthalten.',
      'INVALID_BLOCKS',
    );
  }

  return blocks.map((block, index) => {
    if (!block || typeof block !== 'object') {
      throw new StudioServiceError(
        'Invalid preset block',
        `Block ${index + 1} ist ungültig.`,
        'INVALID_BLOCKS',
      );
    }

    const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
    const label = typeof block.label === 'string' ? block.label.trim() : '';
    const promptFragment = typeof block.promptFragment === 'string' ? block.promptFragment.trim() : '';

    if (!PRESET_BLOCK_TYPES.includes(type as PresetBlockType)) {
      throw new StudioServiceError(
        `Unsupported preset block type: ${block.type}`,
        `Ungültiger Block-Typ. Erlaubt sind: ${PRESET_BLOCK_TYPES.join(', ')}`,
        'INVALID_BLOCKS',
      );
    }

    if (!label || !promptFragment) {
      throw new StudioServiceError(
        'Preset block is missing required fields',
        `Block ${index + 1} braucht Label und Prompt-Fragment.`,
        'INVALID_BLOCKS',
      );
    }

    return {
      id: block.id?.trim() || randomUUID(),
      type,
      label,
      promptFragment,
      category: block.category?.trim() || type,
      description: block.description?.trim() || undefined,
      thumbnailPath: block.thumbnailPath ?? null,
    };
  });
}

function parseBlocks(raw: string): StudioPresetBlockInput[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

function serializeBlocks(blocks: StudioPresetBlockInput[]): string {
  return JSON.stringify(normalizeBlocks(blocks));
}

function serializeTags(tags?: string[]): string | null {
  const normalized = normalizeTags(tags);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function toPresetRecord(
  preset: typeof studioPresets.$inferSelect,
): StudioPresetRecord {
  return {
    id: preset.id,
    userId: preset.userId,
    isDefault: preset.isDefault,
    name: preset.name,
    description: preset.description,
    category: preset.category,
    blocks: parseBlocks(preset.blocks),
    previewImagePath: preset.previewImagePath,
    previewImageUrl: preset.previewImagePath ? toMediaUrl(preset.previewImagePath) : null,
    tags: parseTags(preset.tags),
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

function ensurePresetOwnership(preset: StudioPresetRecord, userId: string): void {
  if (preset.isDefault || preset.userId !== userId) {
    throw new StudioServiceError(
      `User ${userId} cannot modify preset ${preset.id}`,
      'Dieses Preset kann nicht bearbeitet werden.',
      'FORBIDDEN',
    );
  }
}

function composePresetPrompt(blocks: StudioPresetBlockInput[]): string {
  const ordered = [...blocks].sort((a, b) => {
    const indexA = PRESET_BLOCK_ORDER.indexOf(a.type as typeof PRESET_BLOCK_ORDER[number]);
    const indexB = PRESET_BLOCK_ORDER.indexOf(b.type as typeof PRESET_BLOCK_ORDER[number]);
    return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
  });

  return ordered
    .map((block) => block.promptFragment?.trim())
    .filter((fragment): fragment is string => Boolean(fragment))
    .join(', ');
}

function extensionFromMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

export function getStudioPresetCategories(): readonly string[] {
  return PRESET_CATEGORIES;
}

export function getStudioPresetBlockCatalog() {
  return {
    blockTypes: PRESET_BLOCK_TYPES.map((type) => ({
      type,
      label: type.charAt(0).toUpperCase() + type.slice(1),
      blocks: BLOCK_CATALOG[type],
    })),
    categories: PRESET_CATEGORIES,
  };
}

export async function createPreset(userId: string, data: CreatePresetInput): Promise<StudioPresetRecord> {
  await ensureStudioAssetsWorkspace();
  const name = data.name.trim();
  if (!name) {
    throw new StudioServiceError('Preset name is required', 'Name ist erforderlich.', 'INVALID_NAME');
  }

  const id = randomUUID();
  const now = new Date();

  const [inserted] = await db.insert(studioPresets).values({
    id,
    userId,
    isDefault: false,
    name,
    description: normalizeOptionalText(data.description),
    category: validateCategory(data.category),
    blocks: serializeBlocks(data.blocks),
    previewImagePath: null,
    tags: serializeTags(data.tags),
    createdAt: now,
    updatedAt: now,
  }).returning();

  return toPresetRecord(inserted);
}

export async function getPreset(presetId: string): Promise<StudioPresetRecord | null> {
  const [preset] = await db.select().from(studioPresets).where(eq(studioPresets.id, presetId));
  return preset ? toPresetRecord(preset) : null;
}

export async function listPresets(userId: string, category?: string): Promise<StudioPresetRecord[]> {
  await ensureDefaultStudioPresetsSeeded();
  const categoryFilter = validateCategory(category);
  const visibilityCondition = or(
    eq(studioPresets.userId, userId),
    eq(studioPresets.isDefault, true),
  );

  const whereClause = categoryFilter
    ? and(visibilityCondition, eq(studioPresets.category, categoryFilter))
    : visibilityCondition;

  const presets = await db.select()
    .from(studioPresets)
    .where(whereClause)
    .orderBy(desc(studioPresets.isDefault), asc(studioPresets.name), desc(studioPresets.updatedAt));

  return presets.map(toPresetRecord);
}

export async function updatePreset(
  presetId: string,
  data: UpdatePresetInput,
): Promise<StudioPresetRecord> {
  const [existing] = await db.select().from(studioPresets).where(eq(studioPresets.id, presetId));
  if (!existing) {
    throw new StudioServiceError('Preset not found', 'Preset nicht gefunden.', 'NOT_FOUND');
  }

  const updates: Partial<typeof studioPresets.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) {
      throw new StudioServiceError('Preset name is required', 'Name ist erforderlich.', 'INVALID_NAME');
    }
    updates.name = name;
  }

  if (data.description !== undefined) {
    updates.description = normalizeOptionalText(data.description);
  }

  if (data.category !== undefined) {
    updates.category = validateCategory(data.category);
  }

  if (data.blocks !== undefined) {
    updates.blocks = serializeBlocks(data.blocks);
  }

  if (data.tags !== undefined) {
    updates.tags = serializeTags(data.tags);
  }

  const [updated] = await db.update(studioPresets)
    .set(updates)
    .where(eq(studioPresets.id, presetId))
    .returning();

  return toPresetRecord(updated);
}

export async function deletePreset(presetId: string): Promise<void> {
  const [existing] = await db.select().from(studioPresets).where(eq(studioPresets.id, presetId));
  if (!existing) {
    throw new StudioServiceError('Preset not found', 'Preset nicht gefunden.', 'NOT_FOUND');
  }

  await db.delete(studioPresets).where(eq(studioPresets.id, presetId));

  try {
    await deleteAssetDir(`presets/${presetId}/`);
  } catch (error) {
    console.warn(`Failed to delete preset directory presets/${presetId}/:`, error);
  }
}

export async function generatePresetPreview(
  userId: string,
  presetId: string,
  input: GeneratePresetPreviewInput = {},
): Promise<StudioPresetRecord> {
  const preset = await getPreset(presetId);
  if (!preset) {
    throw new StudioServiceError('Preset not found', 'Preset nicht gefunden.', 'NOT_FOUND');
  }

  ensurePresetOwnership(preset, userId);

  const providerId = input.provider?.trim() || 'gemini';
  const provider = getImageGenerationProvider(providerId);
  if (!provider) {
    throw new StudioServiceError(
      `Unsupported preview provider: ${providerId}`,
      `Unbekannter Provider '${providerId}'.`,
      'INVALID_PROVIDER',
    );
  }

  const model = input.model?.trim() || provider.models[0]?.id;
  if (!model || !provider.models.some((entry) => entry.id === model)) {
    throw new StudioServiceError(
      `Unsupported preview model: ${input.model}`,
      `Ungültiges Modell für ${provider.name}.`,
      'INVALID_MODEL',
    );
  }

  const aspectRatio = input.aspectRatio?.trim() || '1:1';
  if (!provider.supportedAspectRatios.includes(aspectRatio)) {
    throw new StudioServiceError(
      `Unsupported preview aspect ratio: ${aspectRatio}`,
      `Seitenverhältnis '${aspectRatio}' wird von ${provider.name} nicht unterstützt.`,
      'INVALID_ASPECT_RATIO',
    );
  }

  const presetPrompt = composePresetPrompt(preset.blocks);
  if (!presetPrompt) {
    throw new StudioServiceError(
      'Preset preview prompt is empty',
      'Für dieses Preset fehlen nutzbare Prompt-Blöcke.',
      'INVALID_BLOCKS',
    );
  }

  try {
    const result = await provider.generate({
      prompt: `Create a polished square preview image for the studio preset "${preset.name}". ${preset.description ? `${preset.description}. ` : ''}Visual direction: ${presetPrompt}. High-end commercial aesthetics, no text, no watermark.`,
      model,
      aspectRatio,
      referenceImages: [],
    });

    await ensureStudioAssetsWorkspace();
    await deleteAssetDir(`presets/${presetId}/`);

    const previewPath = generatePresetPreviewPath(presetId, extensionFromMime(result.mimeType));
    await writeAssetFile(previewPath, Buffer.from(result.imageBytes, 'base64'));

    const [updated] = await db.update(studioPresets)
      .set({
        previewImagePath: previewPath,
        updatedAt: new Date(),
      })
      .where(eq(studioPresets.id, presetId))
      .returning();

    return toPresetRecord(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview generation failed';
    throw new StudioServiceError(
      message,
      `Preview-Bild konnte nicht generiert werden: ${message}`,
      'PREVIEW_GENERATION_FAILED',
    );
  }
}

export async function assertPresetEditableByUser(presetId: string, userId: string): Promise<StudioPresetRecord> {
  const preset = await getPreset(presetId);
  if (!preset) {
    throw new StudioServiceError('Preset not found', 'Preset nicht gefunden.', 'NOT_FOUND');
  }
  ensurePresetOwnership(preset, userId);
  return preset;
}
