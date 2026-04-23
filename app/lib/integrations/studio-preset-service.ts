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

export type PresetCategory = typeof PRESET_CATEGORIES[number];

export interface StudioPresetBlockDefinition {
  id: string;
  type: string;
  label: string;
  promptFragment: string;
  category: string;
  description: string;
  icon: string;
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
  enabled?: boolean;
}

export const BLOCK_CATALOG: Record<string, StudioPresetBlockDefinition[]> = {
  lighting: [
    {
      id: 'lighting-softbox-clean',
      type: 'lighting',
      label: 'Softbox Clean',
      promptFragment: 'softbox key light with clean commercial highlights',
      category: 'commercial',
      description: 'Even studio light with soft reflections for polished product shots.',
      icon: 'Lamp',
    },
    {
      id: 'lighting-golden-hour',
      type: 'lighting',
      label: 'Golden Hour',
      promptFragment: 'warm golden-hour light with long soft shadows',
      category: 'editorial',
      description: 'Warm directional light for lifestyle and fashion scenes.',
      icon: 'Lamp',
    },
    {
      id: 'lighting-neon-contrast',
      type: 'lighting',
      label: 'Neon Contrast',
      promptFragment: 'high-contrast neon rim light with cinematic glow',
      category: 'cinematic',
      description: 'Moody colored light for tech and nightlife aesthetics.',
      icon: 'Lamp',
    },
    {
      id: 'lighting-spot-focused',
      type: 'lighting',
      label: 'Focused Spot',
      promptFragment: 'focused warm spotlight with dramatic falloff',
      category: 'cinematic',
      description: 'Dramatic spotlight for moody scenes.',
      icon: 'Lamp',
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
      icon: 'Crosshair',
    },
    {
      id: 'camera-editorial-three-quarter',
      type: 'camera',
      label: 'Editorial 3/4',
      promptFragment: 'editorial three-quarter camera angle with natural perspective',
      category: 'editorial',
      description: 'Balanced hero angle for products, portraits, and interiors.',
      icon: 'Crosshair',
    },
    {
      id: 'camera-top-down',
      type: 'camera',
      label: 'Top Down',
      promptFragment: 'top-down flat-lay composition with symmetrical framing',
      category: 'layout',
      description: 'Flat-lay perspective for food, beauty, and tabletop scenes.',
      icon: 'Crosshair',
    },
    {
      id: 'camera-low-angle',
      type: 'camera',
      label: 'Low Angle',
      promptFragment: 'dramatic low angle looking upward with bold perspective',
      category: 'dramatic',
      description: 'Majestic low angle for heroic compositions.',
      icon: 'Crosshair',
    },
  ],
  surfaces: [
    {
      id: 'surface-marble',
      type: 'surfaces',
      label: 'Marble',
      promptFragment: 'polished marble surface with soft reflections',
      category: 'premium',
      description: 'Elegant marble for luxury product setups.',
      icon: 'Square',
    },
    {
      id: 'surface-concrete',
      type: 'surfaces',
      label: 'Concrete',
      promptFragment: 'rough concrete texture with subtle patina',
      category: 'industrial',
      description: 'Raw concrete surface with industrial character.',
      icon: 'Square',
    },
    {
      id: 'surface-linen',
      type: 'surfaces',
      label: 'Linen',
      promptFragment: 'natural linen fabric texture with soft folds',
      category: 'organic',
      description: 'Warm linen textile for lifestyle and organic scenes.',
      icon: 'Square',
    },
  ],
  filmTypes: [
    {
      id: 'film-35mm',
      type: 'filmTypes',
      label: '35mm Film',
      promptFragment: '35mm Kodak film emulation with subtle grain',
      category: 'analog',
      description: 'Classic film grain for nostalgic warmth.',
      icon: 'Clapperboard',
    },
    {
      id: 'film-instant',
      type: 'filmTypes',
      label: 'Instant Film',
      promptFragment: 'polaroid instant film look with rich contrast',
      category: 'analog',
      description: 'Instant film aesthetic with bold colors.',
      icon: 'Clapperboard',
    },
    {
      id: 'film-cinematic',
      type: 'filmTypes',
      label: 'Cinematic',
      promptFragment: 'cinematic color grading with teal-orange contrast',
      category: 'digital',
      description: 'Modern cinematic grade with dramatic color separation.',
      icon: 'Clapperboard',
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
      icon: 'Flower2',
    },
    {
      id: 'props-organic-texture',
      type: 'props',
      label: 'Organic Texture',
      promptFragment: 'organic textural props like linen, stone, and ceramic',
      category: 'organic',
      description: 'Natural supporting materials for lifestyle and interior moods.',
      icon: 'Flower2',
    },
    {
      id: 'props-tech-precision',
      type: 'props',
      label: 'Tech Precision',
      promptFragment: 'precision-engineered props with metallic and glass accents',
      category: 'tech',
      description: 'Structured prop styling for devices and futuristic products.',
      icon: 'Flower2',
    },
  ],
  cameraAngles: [
    {
      id: 'angle-front',
      type: 'cameraAngles',
      label: 'Front View',
      promptFragment: 'straight-on front view with centered symmetry',
      category: 'product',
      description: 'Clean frontal perspective for catalog imagery.',
      icon: 'Crosshair',
    },
    {
      id: 'angle-profile',
      type: 'cameraAngles',
      label: 'Profile',
      promptFragment: 'clean side profile with silhouette clarity',
      category: 'editorial',
      description: 'Side angle for elegant product and model shots.',
      icon: 'Crosshair',
    },
    {
      id: 'angle-overhead',
      type: 'cameraAngles',
      label: 'Overhead',
      promptFragment: 'elevated overhead angle with depth perspective',
      category: 'layout',
      description: 'Elevated view for food and lifestyle flatlays.',
      icon: 'Crosshair',
    },
  ],
  weather: [
    {
      id: 'weather-misty',
      type: 'weather',
      label: 'Misty Atmosphere',
      promptFragment: 'misty overcast atmosphere with soft diffused light',
      category: 'mood',
      description: 'Ethereal mist for dreamy landscapes and interiors.',
      icon: 'Cloud',
    },
    {
      id: 'weather-golden-sun',
      type: 'weather',
      label: 'Golden Sun',
      promptFragment: 'golden coastal sun with gentle lens glow',
      category: 'lifestyle',
      description: 'Warm golden sunlight for aspirational scenes.',
      icon: 'Cloud',
    },
    {
      id: 'weather-stormy',
      type: 'weather',
      label: 'Stormy',
      promptFragment: 'dramatic stormy clouds with moody lighting',
      category: 'cinematic',
      description: 'Dark storm atmosphere for dramatic compositions.',
      icon: 'Cloud',
    },
  ],
  characters: [
    {
      id: 'char-professional',
      type: 'characters',
      label: 'Professional',
      promptFragment: 'young professional in modern business casual',
      category: 'corporate',
      description: 'Modern business look for corporate imagery.',
      icon: 'Users',
    },
    {
      id: 'char-casual',
      type: 'characters',
      label: 'Casual',
      promptFragment: 'relaxed casual styling with authentic expression',
      category: 'lifestyle',
      description: 'Natural casual style for authentic lifestyle shots.',
      icon: 'Users',
    },
    {
      id: 'char-luxury',
      type: 'characters',
      label: 'Luxury',
      promptFragment: 'high-fashion editorial model with confident posture',
      category: 'fashion',
      description: 'Fashion-forward styling for luxury campaigns.',
      icon: 'Users',
    },
  ],
  backgrounds: [
    {
      id: 'background-seamless-white',
      type: 'backgrounds',
      label: 'Seamless White',
      promptFragment: 'seamless white studio backdrop',
      category: 'studio',
      description: 'Clean isolated backdrop for catalog and ecommerce imagery.',
      icon: 'Image',
    },
    {
      id: 'background-muted-gradient',
      type: 'backgrounds',
      label: 'Muted Gradient',
      promptFragment: 'muted tonal gradient background with depth',
      category: 'studio',
      description: 'Subtle color transitions that feel elevated without distraction.',
      icon: 'Image',
    },
    {
      id: 'background-architectural',
      type: 'backgrounds',
      label: 'Architectural Space',
      promptFragment: 'architectural interior background with modern lines',
      category: 'environment',
      description: 'Structured background for interior, automotive, and lifestyle setups.',
      icon: 'Image',
    },
    {
      id: 'background-gradient-shift',
      type: 'backgrounds',
      label: 'Color Shift',
      promptFragment: 'seamless gradient backdrop with subtle color shift',
      category: 'studio',
      description: 'Smooth color transition for modern product visuals.',
      icon: 'Image',
    },
  ],
  lenses: [
    {
      id: 'lens-shallow-dof',
      type: 'lenses',
      label: 'Shallow DOF',
      promptFragment: 'shallow depth of field with creamy bokeh',
      category: 'portrait',
      description: 'Dreamy blur for isolating subjects.',
      icon: 'Aperture',
    },
    {
      id: 'lens-wide',
      type: 'lenses',
      label: 'Wide Angle',
      promptFragment: 'wide angle lens with environmental context',
      category: 'environment',
      description: 'Expansive wide view for landscapes and interiors.',
      icon: 'Aperture',
    },
    {
      id: 'lens-telephoto',
      type: 'lenses',
      label: 'Telephoto',
      promptFragment: 'telephoto compression with sharp subject isolation',
      category: 'detail',
      description: 'Compressed perspective for focused detail shots.',
      icon: 'Aperture',
    },
  ],
  actions: [
    {
      id: 'action-dynamic',
      type: 'actions',
      label: 'Dynamic Motion',
      promptFragment: 'dynamic action pose with natural motion blur',
      category: 'energy',
      description: 'Sense of movement and energy.',
      icon: 'Sparkles',
    },
    {
      id: 'action-static',
      type: 'actions',
      label: 'Static Calm',
      promptFragment: 'still composition with meditative calmness',
      category: 'calm',
      description: 'Peaceful stillness for product and interior shots.',
      icon: 'Sparkles',
    },
    {
      id: 'action-interaction',
      type: 'actions',
      label: 'Hand Interaction',
      promptFragment: 'human hands interacting with the subject naturally',
      category: 'lifestyle',
      description: 'Authentic hand placement for lifestyle context.',
      icon: 'Sparkles',
    },
  ],
  colorPalettes: [
    {
      id: 'color-earth',
      type: 'colorPalettes',
      label: 'Earth Tones',
      promptFragment: 'muted earth-tone color palette with warm contrast',
      category: 'warm',
      description: 'Natural browns, tans, and ochres.',
      icon: 'Palette',
    },
    {
      id: 'color-pastel',
      type: 'colorPalettes',
      label: 'Pastel Soft',
      promptFragment: 'soft pastel color palette with gentle tonal harmony',
      category: 'soft',
      description: 'Delicate pastel hues for airy aesthetics.',
      icon: 'Palette',
    },
    {
      id: 'color-monochrome',
      type: 'colorPalettes',
      label: 'Monochrome',
      promptFragment: 'monochrome grayscale palette with tonal depth',
      category: 'minimal',
      description: 'Black and white with rich tonal gradation.',
      icon: 'Palette',
    },
    {
      id: 'color-vibrant',
      type: 'colorPalettes',
      label: 'Vibrant Pop',
      promptFragment: 'vibrant saturated colors with high contrast',
      category: 'bold',
      description: 'Bold saturated colors for eye-catching visuals.',
      icon: 'Palette',
    },
  ],
  composition: [
    {
      id: 'composition-rule-thirds',
      type: 'composition',
      label: 'Rule of Thirds',
      promptFragment: 'rule of thirds composition with balanced subject placement',
      category: 'classic',
      description: 'Classic balanced framing.',
      icon: 'Layout',
    },
    {
      id: 'composition-center',
      type: 'composition',
      label: 'Centered Hero',
      promptFragment: 'centered subject with breathing space around',
      category: 'bold',
      description: 'Bold center-focused composition.',
      icon: 'Layout',
    },
    {
      id: 'composition-leading',
      type: 'composition',
      label: 'Leading Lines',
      promptFragment: 'composition with strong leading lines directing to subject',
      category: 'dynamic',
      description: 'Lines guide the eye to the focal point.',
      icon: 'Layout',
    },
  ],
  feeling: [
    {
      id: 'feeling-serene',
      type: 'feeling',
      label: 'Serene',
      promptFragment: 'serene and contemplative atmosphere',
      category: 'calm',
      description: 'Peaceful, quiet mood.',
      icon: 'Heart',
    },
    {
      id: 'feeling-bold',
      type: 'feeling',
      label: 'Bold',
      promptFragment: 'bold and confident energy with striking presence',
      category: 'power',
      description: 'Strong, commanding presence.',
      icon: 'Heart',
    },
    {
      id: 'feeling-playful',
      type: 'feeling',
      label: 'Playful',
      promptFragment: 'light playful mood with approachable warmth',
      category: 'fun',
      description: 'Fun, approachable energy.',
      icon: 'Heart',
    },
  ],
  historicalPeriods: [
    {
      id: 'hist-midcentury',
      type: 'historicalPeriods',
      label: 'Mid-Century',
      promptFragment: 'mid-century modern 1950s aesthetic with clean lines',
      category: 'retro',
      description: 'Classic 1950s modernist style.',
      icon: 'Clock',
    },
    {
      id: 'hist-80s',
      type: 'historicalPeriods',
      label: '80s Retro',
      promptFragment: '1980s retro aesthetic with bold neon and chrome',
      category: 'retro',
      description: 'Bold 80s style with neon accents.',
      icon: 'Clock',
    },
    {
      id: 'hist-victorian',
      type: 'historicalPeriods',
      label: 'Victorian',
      promptFragment: 'Victorian era aesthetic with ornate details and rich textures',
      category: 'classic',
      description: 'Ornate Victorian styling.',
      icon: 'Clock',
    },
  ],
  location: [
    {
      id: 'location-beach',
      type: 'location',
      label: 'Beach',
      promptFragment: 'tropical beach setting with golden sunlight',
      category: 'outdoor',
      description: 'Sunny coastal vibes.',
      icon: 'MapPin',
    },
    {
      id: 'location-urban',
      type: 'location',
      label: 'Urban',
      promptFragment: 'modern urban environment with architectural lines',
      category: 'city',
      description: 'Clean city aesthetic.',
      icon: 'MapPin',
    },
    {
      id: 'location-nature',
      type: 'location',
      label: 'Nature',
      promptFragment: 'lush natural environment with organic textures',
      category: 'outdoor',
      description: 'Organic natural setting.',
      icon: 'MapPin',
    },
  ],
  styles: [
    {
      id: 'style-minimal',
      type: 'styles',
      label: 'Minimalist',
      promptFragment: 'minimalist Scandinavian design style with clean lines',
      category: 'modern',
      description: 'Clean, minimal aesthetic.',
      icon: 'Wand2',
    },
    {
      id: 'style-cyberpunk',
      type: 'styles',
      label: 'Cyberpunk',
      promptFragment: 'cyberpunk futuristic style with neon and high contrast',
      category: 'futuristic',
      description: 'Futuristic cyber aesthetic.',
      icon: 'Wand2',
    },
    {
      id: 'style-organic',
      type: 'styles',
      label: 'Organic Modern',
      promptFragment: 'organic modern style with natural materials and soft forms',
      category: 'warm',
      description: 'Warm natural modernism.',
      icon: 'Wand2',
    },
  ],
  textures: [
    {
      id: 'texture-rough',
      type: 'textures',
      label: 'Rough',
      promptFragment: 'rough tactile texture with visible grain',
      category: 'organic',
      description: 'Raw, unpolished surface quality.',
      icon: 'Waves',
    },
    {
      id: 'texture-smooth',
      type: 'textures',
      label: 'Smooth',
      promptFragment: 'smooth polished surface with mirror-like reflections',
      category: 'premium',
      description: 'Glossy, refined finish.',
      icon: 'Waves',
    },
    {
      id: 'texture-patterned',
      type: 'textures',
      label: 'Patterned',
      promptFragment: 'intricate patterned texture with repeating motifs',
      category: 'decorative',
      description: 'Detailed pattern for visual interest.',
      icon: 'Waves',
    },
  ],
  positions: [
    {
      id: 'position-center',
      type: 'positions',
      label: 'Center',
      promptFragment: 'subject centered with balanced negative space',
      category: 'classic',
      description: 'Classic centered placement.',
      icon: 'Move',
    },
    {
      id: 'position-offset',
      type: 'positions',
      label: 'Offset',
      promptFragment: 'subject placed off-center with asymmetric balance',
      category: 'dynamic',
      description: 'Asymmetric off-center composition.',
      icon: 'Move',
    },
    {
      id: 'position-layered',
      type: 'positions',
      label: 'Layered Depth',
      promptFragment: 'layered depth with foreground, midground, and background elements',
      category: 'complex',
      description: 'Multi-layered scene depth.',
      icon: 'Move',
    },
  ],
  visualEffects: [
    {
      id: 'effect-god-rays',
      type: 'visualEffects',
      label: 'God Rays',
      promptFragment: 'soft volumetric god rays from above',
      category: 'atmospheric',
      description: 'Dramatic light beams cutting through atmosphere.',
      icon: 'Sparkle',
    },
    {
      id: 'effect-bokeh',
      type: 'visualEffects',
      label: 'Bokeh Overlay',
      promptFragment: 'soft bokeh light overlay in out-of-focus areas',
      category: 'atmospheric',
      description: 'Dreamy blurred light spots.',
      icon: 'Sparkle',
    },
    {
      id: 'effect-lens-flare',
      type: 'visualEffects',
      label: 'Lens Flare',
      promptFragment: 'subtle lens flare with warm color fringing',
      category: 'cinematic',
      description: 'Cinematic lens light artifacts.',
      icon: 'Sparkle',
    },
  ],
};

export const PRESET_BLOCK_ORDER = [
  'lighting',
  'camera',
  'lenses',
  'cameraAngles',
  'surfaces',
  'props',
  'backgrounds',
  'characters',
  'actions',
  'positions',
  'composition',
  'colorPalettes',
  'textures',
  'styles',
  'feeling',
  'visualEffects',
  'filmTypes',
  'weather',
  'location',
  'historicalPeriods',
];

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

    if (!type || !label || !promptFragment) {
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
    const indexA = PRESET_BLOCK_ORDER.indexOf(a.type);
    const indexB = PRESET_BLOCK_ORDER.indexOf(b.type);
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
  const blockTypes = Object.entries(BLOCK_CATALOG).map(([type, blocks]) => ({
    type,
    label: type.charAt(0).toUpperCase() + type.slice(1),
    blocks: blocks.map((b) => ({
      id: b.id,
      type: b.type,
      label: b.label,
      promptFragment: b.promptFragment,
      category: b.category,
      description: b.description,
      icon: b.icon,
    })),
  }));

  return {
    blockTypes,
    categories: PRESET_CATEGORIES,
    blockOrder: PRESET_BLOCK_ORDER,
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

  const model = input.model?.trim() || 'gemini-2.5-flash-image';
  if (!provider.models.some((entry) => entry.id === model)) {
    throw new StudioServiceError(
      `Unsupported preview model: ${model}`,
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

    const previewPath = 'studio/assets/' + generatePresetPreviewPath(presetId, extensionFromMime(result.mimeType));
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
