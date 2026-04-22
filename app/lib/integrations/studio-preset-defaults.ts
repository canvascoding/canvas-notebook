import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { studioPresets } from '@/app/lib/db/schema';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { ensureStudioAssetsWorkspace, writeAssetFile, getStudioAssetsRoot } from '@/app/lib/integrations/studio-workspace';

type StudioPresetCategory =
  | 'fashion'
  | 'product'
  | 'food'
  | 'lifestyle'
  | 'beauty'
  | 'tech'
  | 'interior'
  | 'automotive';

interface StudioPresetSeedBlock {
  id: string;
  type: string;
  label: string;
  promptFragment: string;
  category: string;
  description?: string;
}

interface StudioPresetSeedPreview {
  backgroundFrom: string;
  backgroundTo: string;
  accent: string;
  text: string;
  badge: string;
}

export interface DefaultStudioPresetSeed {
  id: string;
  name: string;
  description: string;
  category: StudioPresetCategory;
  tags: string[];
  blocks: StudioPresetSeedBlock[];
  preview: StudioPresetSeedPreview;
}

interface SeedOptions {
  forceAssets?: boolean;
}

const REMOVED_DEFAULT_STUDIO_PRESET_IDS = [
  'studio-product-packshot-shadowplay',
  'studio-lifestyle-fitness-motion',
] as const;

function block(
  id: string,
  type: string,
  label: string,
  promptFragment: string,
  category: string,
  description?: string,
): StudioPresetSeedBlock {
  return { id, type, label, promptFragment, category, description };
}

export const DEFAULT_STUDIO_PRESET_SEEDS: DefaultStudioPresetSeed[] = [
  {
    id: 'studio-fashion-editorial-softbox',
    name: 'Editorial Softbox Portrait',
    description: 'Polished fashion portrait with softbox lighting and confident energy.',
    category: 'fashion',
    tags: ['fashion', 'portrait', 'editorial', 'soft light'],
    blocks: [
      block('fashion-softbox-light', 'lighting', 'Softbox Bloom', 'softbox portrait light with luminous skin highlights', 'editorial'),
      block('fashion-editorial-angle', 'cameraAngles', 'Editorial 3/4', 'editorial three-quarter portrait framing with refined posture', 'editorial'),
      block('fashion-shallow-dof', 'lenses', 'Shallow DOF', 'shallow depth of field with creamy bokeh', 'portrait'),
      block('fashion-minimal-style', 'styles', 'Minimalist', 'minimalist Scandinavian design style with clean lines', 'modern'),
      block('fashion-pastel-palette', 'colorPalettes', 'Pastel Soft', 'soft pastel color palette with gentle tonal harmony', 'soft'),
      block('fashion-serene-mood', 'feeling', 'Serene', 'serene and contemplative atmosphere', 'calm'),
    ],
    preview: {
      backgroundFrom: '#F7D9DD',
      backgroundTo: '#F9F3EC',
      accent: '#B95C72',
      text: '#3D2230',
      badge: 'FASHION',
    },
  },
  {
    id: 'studio-fashion-runway-neon',
    name: 'Runway Neon Motion',
    description: 'Bold runway fashion with neon rim light and cinematic energy.',
    category: 'fashion',
    tags: ['fashion', 'runway', 'neon', 'bold'],
    blocks: [
      block('fashion-neon-rim', 'lighting', 'Neon Rim', 'high-contrast neon rim light with cinematic glow', 'cinematic'),
      block('fashion-low-angle', 'cameraAngles', 'Low Angle', 'dramatic low angle looking upward with bold perspective', 'dramatic'),
      block('fashion-cyber-style', 'styles', 'Cyberpunk', 'cyberpunk futuristic style with neon and high contrast', 'futuristic'),
      block('fashion-vibrant-palette', 'colorPalettes', 'Vibrant Pop', 'vibrant saturated colors with high contrast', 'bold'),
      block('fashion-bold-mood', 'feeling', 'Bold', 'bold and confident energy with striking presence', 'power'),
      block('fashion-god-rays', 'visualEffects', 'God Rays', 'soft volumetric god rays from above', 'atmospheric'),
    ],
    preview: {
      backgroundFrom: '#201833',
      backgroundTo: '#3C204C',
      accent: '#57D3FF',
      text: '#F7F4FF',
      badge: 'FASHION',
    },
  },
  {
    id: 'studio-product-ecommerce-clean',
    name: 'Clean Ecommerce Hero',
    description: 'Minimal product preset for isolated hero renders and catalog visuals.',
    category: 'product',
    tags: ['product', 'ecommerce', 'clean', 'catalog'],
    blocks: [
      block('product-clean-light', 'lighting', 'Commercial Softbox', 'softbox key light with clean commercial highlights', 'commercial'),
      block('product-front-view', 'cameraAngles', 'Front View', 'straight-on front view with centered symmetry', 'product'),
      block('product-marble-surface', 'surfaces', 'Marble', 'polished marble surface with soft reflections', 'premium'),
      block('product-seamless-bg', 'backgrounds', 'Seamless White', 'seamless white studio backdrop', 'studio'),
      block('product-minimal-style', 'styles', 'Minimalist', 'minimalist Scandinavian design style with clean lines', 'modern'),
      block('product-static-calm', 'actions', 'Static Calm', 'still composition with meditative calmness', 'calm'),
    ],
    preview: {
      backgroundFrom: '#F5F5F2',
      backgroundTo: '#FFFFFF',
      accent: '#767676',
      text: '#202020',
      badge: 'PRODUCT',
    },
  },
  {
    id: 'studio-product-organic-texture',
    name: 'Organic Texture Tabletop',
    description: 'Warm product tabletop with tactile materials and crafted lifestyle styling.',
    category: 'product',
    tags: ['product', 'organic', 'tabletop', 'crafted'],
    blocks: [
      block('product-warm-light', 'lighting', 'Warm Window Light', 'warm golden-hour light with long soft shadows', 'editorial'),
      block('product-tabletop-angle', 'cameraAngles', 'Overhead', 'elevated overhead angle with depth perspective', 'layout'),
      block('product-linen-surface', 'surfaces', 'Linen', 'natural linen fabric texture with soft folds', 'organic'),
      block('product-earth-gradient', 'backgrounds', 'Muted Gradient', 'muted tonal gradient background with depth', 'studio'),
      block('product-organic-style', 'styles', 'Organic Modern', 'organic modern style with natural materials and soft forms', 'warm'),
      block('product-earth-palette', 'colorPalettes', 'Earth Tones', 'muted earth-tone color palette with warm contrast', 'warm'),
    ],
    preview: {
      backgroundFrom: '#D9C3AA',
      backgroundTo: '#F3E8D8',
      accent: '#8A5A2B',
      text: '#3F2A18',
      badge: 'PRODUCT',
    },
  },
  {
    id: 'studio-food-bright-flatlay',
    name: 'Bright Flatlay Menu',
    description: 'Fresh top-down food preset for menu, social, and editorial recipe shots.',
    category: 'food',
    tags: ['food', 'flatlay', 'bright', 'editorial'],
    blocks: [
      block('food-daylight', 'lighting', 'Golden Sun', 'golden coastal sun with gentle lens glow', 'lifestyle'),
      block('food-topdown', 'cameraAngles', 'Top Down', 'top-down flat-lay composition with symmetrical framing', 'layout'),
      block('food-linen-surface', 'surfaces', 'Linen', 'natural linen fabric texture with soft folds', 'organic'),
      block('food-pastel-bg', 'backgrounds', 'Color Shift', 'seamless gradient backdrop with subtle color shift', 'studio'),
      block('food-pastel-palette', 'colorPalettes', 'Pastel Soft', 'soft pastel color palette with gentle tonal harmony', 'soft'),
      block('food-playful-mood', 'feeling', 'Playful', 'light playful mood with approachable warmth', 'fun'),
    ],
    preview: {
      backgroundFrom: '#FFF0B8',
      backgroundTo: '#FFF7E2',
      accent: '#E28C27',
      text: '#5E3A17',
      badge: 'FOOD',
    },
  },
  {
    id: 'studio-food-moody-bistro',
    name: 'Moody Bistro Plate',
    description: 'Dark, contrast-rich food preset for chef-driven plating and restaurant visuals.',
    category: 'food',
    tags: ['food', 'moody', 'bistro', 'chef'],
    blocks: [
      block('food-spot-light', 'lighting', 'Focused Spot', 'focused warm spotlight with dramatic falloff', 'cinematic'),
      block('food-close-macro', 'cameraAngles', 'Close Macro', 'macro lens close-up with crisp texture detail', 'detail'),
      block('food-concrete-surface', 'surfaces', 'Concrete', 'rough concrete texture with subtle patina', 'industrial'),
      block('food-dark-bistro-bg', 'backgrounds', 'Architectural Space', 'architectural interior background with modern lines', 'environment'),
      block('food-monochrome-palette', 'colorPalettes', 'Monochrome', 'monochrome grayscale palette with tonal depth', 'minimal'),
      block('food-serene-mood', 'feeling', 'Serene', 'serene and contemplative atmosphere', 'calm'),
    ],
    preview: {
      backgroundFrom: '#34261F',
      backgroundTo: '#1A1411',
      accent: '#E39A52',
      text: '#FFF5EB',
      badge: 'FOOD',
    },
  },
  {
    id: 'studio-lifestyle-sunlit-home',
    name: 'Sunlit Home Story',
    description: 'Soft lifestyle preset for natural home moments and calm brand storytelling.',
    category: 'lifestyle',
    tags: ['lifestyle', 'home', 'sunlit', 'natural'],
    blocks: [
      block('life-daylight', 'lighting', 'Golden Sun', 'golden coastal sun with gentle lens glow', 'lifestyle'),
      block('life-natural-angle', 'cameraAngles', 'Front View', 'straight-on front view with centered symmetry', 'product'),
      block('life-linen-surface', 'surfaces', 'Linen', 'natural linen fabric texture with soft folds', 'organic'),
      block('life-warm-interior', 'backgrounds', 'Architectural Space', 'architectural interior background with modern lines', 'environment'),
      block('life-earth-palette', 'colorPalettes', 'Earth Tones', 'muted earth-tone color palette with warm contrast', 'warm'),
      block('life-casual-char', 'characters', 'Casual', 'relaxed casual styling with authentic expression', 'lifestyle'),
    ],
    preview: {
      backgroundFrom: '#E7D9C5',
      backgroundTo: '#F8F1E6',
      accent: '#D18B52',
      text: '#51351F',
      badge: 'LIFESTYLE',
    },
  },
  {
    id: 'studio-lifestyle-travel-editorial',
    name: 'Travel Editorial Escape',
    description: 'Aspirational lifestyle preset with airy motion and destination storytelling.',
    category: 'lifestyle',
    tags: ['lifestyle', 'travel', 'editorial', 'aspirational'],
    blocks: [
      block('travel-golden-sun', 'lighting', 'Golden Sun', 'golden coastal sun with gentle lens glow', 'editorial'),
      block('travel-wide-angle', 'lenses', 'Wide Angle', 'wide angle lens with environmental context', 'environment'),
      block('travel-beach-loc', 'location', 'Beach', 'tropical beach setting with golden sunlight', 'outdoor'),
      block('travel-airy-bg', 'backgrounds', 'Muted Gradient', 'muted tonal gradient background with depth', 'studio'),
      block('travel-vibrant-palette', 'colorPalettes', 'Vibrant Pop', 'vibrant saturated colors with high contrast', 'bold'),
      block('travel-playful-mood', 'feeling', 'Playful', 'light playful mood with approachable warmth', 'fun'),
    ],
    preview: {
      backgroundFrom: '#C8E4EC',
      backgroundTo: '#FFF1DE',
      accent: '#FF8A4A',
      text: '#22424E',
      badge: 'LIFESTYLE',
    },
  },
  {
    id: 'studio-beauty-skincare-dewy',
    name: 'Dewy Skincare Glow',
    description: 'Fresh beauty preset emphasizing luminous skin, glass surfaces, and skincare clarity.',
    category: 'beauty',
    tags: ['beauty', 'skincare', 'dewy', 'clean'],
    blocks: [
      block('beauty-dish-light', 'lighting', 'Softbox Clean', 'softbox key light with clean commercial highlights', 'commercial'),
      block('beauty-close-macro', 'cameraAngles', 'Close Macro', 'macro lens close-up with crisp texture detail', 'detail'),
      block('beauty-marble-surface', 'surfaces', 'Marble', 'polished marble surface with soft reflections', 'premium'),
      block('beauty-pastel-bg', 'backgrounds', 'Color Shift', 'seamless gradient backdrop with subtle color shift', 'studio'),
      block('beauty-pastel-palette', 'colorPalettes', 'Pastel Soft', 'soft pastel color palette with gentle tonal harmony', 'soft'),
      block('beauty-luxury-char', 'characters', 'Luxury', 'high-fashion editorial model with confident posture', 'fashion'),
    ],
    preview: {
      backgroundFrom: '#CFEFE7',
      backgroundTo: '#F7FFFD',
      accent: '#59A89A',
      text: '#224B46',
      badge: 'BEAUTY',
    },
  },
  {
    id: 'studio-beauty-cosmetic-luxury',
    name: 'Luxury Cosmetic Drama',
    description: 'High-end beauty preset with rich shadows and polished metallic accents.',
    category: 'beauty',
    tags: ['beauty', 'luxury', 'cosmetics', 'dramatic'],
    blocks: [
      block('beauty-spot-light', 'lighting', 'Focused Spot', 'focused warm spotlight with dramatic falloff', 'cinematic'),
      block('beauty-shallow-dof', 'lenses', 'Shallow DOF', 'shallow depth of field with creamy bokeh', 'portrait'),
      block('beauty-smooth-surface', 'surfaces', 'Smooth', 'smooth polished surface with mirror-like reflections', 'premium'),
      block('beauty-dark-bg', 'backgrounds', 'Architectural Space', 'architectural interior background with modern lines', 'environment'),
      block('beauty-monochrome-palette', 'colorPalettes', 'Monochrome', 'monochrome grayscale palette with tonal depth', 'minimal'),
      block('beauty-bold-mood', 'feeling', 'Bold', 'bold and confident energy with striking presence', 'power'),
    ],
    preview: {
      backgroundFrom: '#5E253A',
      backgroundTo: '#2E1022',
      accent: '#F3C7B3',
      text: '#FFF2EC',
      badge: 'BEAUTY',
    },
  },
  {
    id: 'studio-tech-minimal-launch',
    name: 'Minimal Tech Launch',
    description: 'Launch-day device preset with clean reflections and precise industrial styling.',
    category: 'tech',
    tags: ['tech', 'device', 'minimal', 'launch'],
    blocks: [
      block('tech-softbox-light', 'lighting', 'Softbox Clean', 'softbox key light with clean commercial highlights', 'commercial'),
      block('tech-front-view', 'cameraAngles', 'Front View', 'straight-on front view with centered symmetry', 'product'),
      block('tech-smooth-surface', 'surfaces', 'Smooth', 'smooth polished surface with mirror-like reflections', 'premium'),
      block('tech-charcoal-bg', 'backgrounds', 'Muted Gradient', 'muted tonal gradient background with depth', 'studio'),
      block('tech-minimal-style', 'styles', 'Minimalist', 'minimalist Scandinavian design style with clean lines', 'modern'),
      block('tech-monochrome-palette', 'colorPalettes', 'Monochrome', 'monochrome grayscale palette with tonal depth', 'minimal'),
    ],
    preview: {
      backgroundFrom: '#D9E2EA',
      backgroundTo: '#8594A4',
      accent: '#224A78',
      text: '#0D1A27',
      badge: 'TECH',
    },
  },
  {
    id: 'studio-tech-futuristic-neon',
    name: 'Futuristic Neon Circuit',
    description: 'Sci-fi tech preset with glowing edges, dark gradients, and performance energy.',
    category: 'tech',
    tags: ['tech', 'futuristic', 'neon', 'performance'],
    blocks: [
      block('tech-neon-light', 'lighting', 'Neon Contrast', 'high-contrast neon rim light with cinematic glow', 'cinematic'),
      block('tech-low-angle', 'cameraAngles', 'Low Angle', 'dramatic low angle looking upward with bold perspective', 'dramatic'),
      block('tech-concrete-surface', 'surfaces', 'Concrete', 'rough concrete texture with subtle patina', 'industrial'),
      block('tech-dark-circuit-bg', 'backgrounds', 'Architectural Space', 'architectural interior background with modern lines', 'environment'),
      block('tech-cyber-style', 'styles', 'Cyberpunk', 'cyberpunk futuristic style with neon and high contrast', 'futuristic'),
      block('tech-vibrant-palette', 'colorPalettes', 'Vibrant Pop', 'vibrant saturated colors with high contrast', 'bold'),
    ],
    preview: {
      backgroundFrom: '#0D1431',
      backgroundTo: '#28134D',
      accent: '#56F0FF',
      text: '#EAF7FF',
      badge: 'TECH',
    },
  },
  {
    id: 'studio-interior-scandinavian',
    name: 'Scandinavian Interior Calm',
    description: 'Soft interior preset focused on daylight, clean materials, and relaxed architecture.',
    category: 'interior',
    tags: ['interior', 'scandinavian', 'calm', 'daylight'],
    blocks: [
      block('interior-daylight', 'lighting', 'Golden Sun', 'golden coastal sun with gentle lens glow', 'interior'),
      block('interior-wide-lens', 'lenses', 'Wide Angle', 'wide angle lens with environmental context', 'environment'),
      block('interior-linen-surface', 'surfaces', 'Linen', 'natural linen fabric texture with soft folds', 'organic'),
      block('interior-light-shell', 'backgrounds', 'Architectural Space', 'architectural interior background with modern lines', 'environment'),
      block('interior-organic-style', 'styles', 'Organic Modern', 'organic modern style with natural materials and soft forms', 'warm'),
      block('interior-earth-palette', 'colorPalettes', 'Earth Tones', 'muted earth-tone color palette with warm contrast', 'warm'),
    ],
    preview: {
      backgroundFrom: '#E9E1D7',
      backgroundTo: '#F8F5F0',
      accent: '#8F7158',
      text: '#3B2D22',
      badge: 'INTERIOR',
    },
  },
  {
    id: 'studio-interior-hospitality-night',
    name: 'Hospitality Night Lounge',
    description: 'Warm hospitality preset for premium bars, lounges, and evening interior ambience.',
    category: 'interior',
    tags: ['interior', 'hospitality', 'night', 'warm'],
    blocks: [
      block('interior-spot-light', 'lighting', 'Focused Spot', 'focused warm spotlight with dramatic falloff', 'cinematic'),
      block('interior-cinematic-angle', 'cameraAngles', 'Low Angle', 'dramatic low angle looking upward with bold perspective', 'dramatic'),
      block('interior-marble-surface', 'surfaces', 'Marble', 'polished marble surface with soft reflections', 'premium'),
      block('interior-night-bg', 'backgrounds', 'Architectural Space', 'architectural interior background with modern lines', 'environment'),
      block('interior-monochrome-palette', 'colorPalettes', 'Monochrome', 'monochrome grayscale palette with tonal depth', 'minimal'),
      block('interior-bold-mood', 'feeling', 'Bold', 'bold and confident energy with striking presence', 'power'),
    ],
    preview: {
      backgroundFrom: '#4C3325',
      backgroundTo: '#1C1512',
      accent: '#D6A96D',
      text: '#FFF5E9',
      badge: 'INTERIOR',
    },
  },
  {
    id: 'studio-automotive-studio-sport',
    name: 'Studio Sport Car Hero',
    description: 'Performance automotive preset with crisp highlights and premium studio control.',
    category: 'automotive',
    tags: ['automotive', 'car', 'studio', 'performance'],
    blocks: [
      block('auto-spot-light', 'lighting', 'Focused Spot', 'focused warm spotlight with dramatic falloff', 'cinematic'),
      block('auto-low-angle', 'cameraAngles', 'Low Angle', 'dramatic low angle looking upward with bold perspective', 'dramatic'),
      block('auto-smooth-surface', 'surfaces', 'Smooth', 'smooth polished surface with mirror-like reflections', 'premium'),
      block('auto-dark-studio-bg', 'backgrounds', 'Seamless White', 'seamless white studio backdrop', 'studio'),
      block('auto-monochrome-palette', 'colorPalettes', 'Monochrome', 'monochrome grayscale palette with tonal depth', 'minimal'),
      block('auto-bold-mood', 'feeling', 'Bold', 'bold and confident energy with striking presence', 'power'),
    ],
    preview: {
      backgroundFrom: '#62656F',
      backgroundTo: '#111317',
      accent: '#F05D3B',
      text: '#F7F8FA',
      badge: 'AUTOMOTIVE',
    },
  },
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function serializeBlocks(blocks: StudioPresetSeedBlock[]): string {
  return JSON.stringify(blocks);
}

function serializeTags(tags: string[]): string {
  return JSON.stringify(tags);
}

export function resolveStudioPresetSeedDir(cwd = process.cwd()): string {
  const staticSeedDir = path.join(cwd, 'seed_sys_prompts', 'studio-preset-previews');
  try {
    fsSync.accessSync(staticSeedDir);
    return staticSeedDir;
  } catch {
    return path.join(resolveCanvasDataRoot(cwd), 'seeds', 'studio-presets');
  }
}

export function renderPresetPreviewSvg(seed: DefaultStudioPresetSeed): string {
  const blockLines = seed.blocks.slice(0, 4).map((item, index) => `
    <g transform="translate(0 ${index * 62})">
      <rect x="0" y="0" width="360" height="46" rx="18" fill="rgba(255,255,255,0.20)" />
      <text x="22" y="30" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="700" fill="${seed.preview.text}">
        ${escapeXml(item.label)}
      </text>
    </g>
  `).join('');

  return `
    <svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${seed.preview.backgroundFrom}" />
          <stop offset="100%" stop-color="${seed.preview.backgroundTo}" />
        </linearGradient>
        <linearGradient id="orb" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${seed.preview.accent}" stop-opacity="0.95" />
          <stop offset="100%" stop-color="${seed.preview.backgroundTo}" stop-opacity="0.15" />
        </linearGradient>
      </defs>

      <rect width="1024" height="1024" fill="url(#bg)" />
      <circle cx="840" cy="200" r="220" fill="url(#orb)" />
      <circle cx="180" cy="860" r="180" fill="${seed.preview.accent}" opacity="0.18" />
      <rect x="70" y="70" width="884" height="884" rx="44" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.28)" stroke-width="2" />

      <rect x="104" y="108" width="180" height="52" rx="26" fill="${seed.preview.accent}" />
      <text x="194" y="141" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="800" letter-spacing="1.5" fill="${seed.preview.text}">
        ${escapeXml(seed.preview.badge)}
      </text>

      <text x="104" y="252" font-family="Helvetica, Arial, sans-serif" font-size="66" font-weight="800" fill="${seed.preview.text}">
        ${escapeXml(seed.name)}
      </text>
      <text x="104" y="308" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="500" fill="${seed.preview.text}" opacity="0.82">
        ${escapeXml(seed.description)}
      </text>

      <g transform="translate(104 410)">
        ${blockLines}
      </g>

      <rect x="104" y="780" width="300" height="120" rx="32" fill="rgba(255,255,255,0.12)" />
      <text x="138" y="830" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="${seed.preview.text}" opacity="0.72">
        TAGS
      </text>
      <text x="138" y="870" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700" fill="${seed.preview.text}">
        ${escapeXml(seed.tags.slice(0, 3).join(' • '))}
      </text>

      <rect x="650" y="702" width="236" height="236" rx="44" fill="${seed.preview.accent}" opacity="0.92" />
      <rect x="700" y="752" width="136" height="136" rx="32" fill="rgba(255,255,255,0.22)" stroke="rgba(255,255,255,0.55)" stroke-width="2" />
      <text x="768" y="833" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="54" font-weight="800" fill="#FFFFFF">
        @
      </text>
    </svg>
  `;
}

async function ensureSeedPreviewAsset(seed: DefaultStudioPresetSeed, seedDir: string, force = false): Promise<string> {
  const filePath = path.join(seedDir, `${seed.id}.png`);

  if (!force) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Static file missing, generate from SVG as fallback
    }
  }

  const svg = renderPresetPreviewSvg(seed);
  const parentDir = path.dirname(filePath);
  await fs.mkdir(parentDir, { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(filePath);
  return filePath;
}

export async function ensureStudioPresetSeedAssets(options: SeedOptions = {}): Promise<{ seedDir: string; files: string[] }> {
  const seedDir = resolveStudioPresetSeedDir();
  await fs.mkdir(seedDir, { recursive: true });

  const files = await Promise.all(
    DEFAULT_STUDIO_PRESET_SEEDS.map((seed) => ensureSeedPreviewAsset(seed, seedDir, options.forceAssets)),
  );

  return { seedDir, files };
}

export async function ensureDefaultStudioPresetsSeeded(
  options: SeedOptions = {},
): Promise<{ total: number; inserted: number; updated: number; seedDir: string }> {
  await ensureStudioAssetsWorkspace();
  const { seedDir } = await ensureStudioPresetSeedAssets(options);

  let inserted = 0;
  let updated = 0;

  for (const seed of DEFAULT_STUDIO_PRESET_SEEDS) {
    const seedFilePath = path.join(seedDir, `${seed.id}.png`);
    const previewImagePath = `presets/${seed.id}/preview-seed.png`;
    const assetFilePath = path.join(getStudioAssetsRoot(), previewImagePath);

    let previewBuffer: Buffer;
    try {
      previewBuffer = await fs.readFile(seedFilePath);
    } catch {
      console.warn(`[studio-preset-seed] Seed image missing: ${seedFilePath}, skipping asset copy for ${seed.id}`);
      continue;
    }

    let needsAssetCopy = true;
    try {
      const existingStat = await fs.stat(assetFilePath);
      if (existingStat.size === previewBuffer.length) {
        needsAssetCopy = false;
      }
    } catch {
      // Asset doesn't exist, needs copy
    }

    if (needsAssetCopy) {
      await writeAssetFile(previewImagePath, previewBuffer);
    }

    const [existing] = await db.select()
      .from(studioPresets)
      .where(eq(studioPresets.id, seed.id));

    const now = new Date();
    const values = {
      userId: null,
      isDefault: true,
      name: seed.name,
      description: seed.description,
      category: seed.category,
      blocks: serializeBlocks(seed.blocks),
      previewImagePath,
      tags: serializeTags(seed.tags),
      updatedAt: now,
    };

    if (existing) {
      if (existing.previewImagePath !== previewImagePath) {
        await db.update(studioPresets)
          .set(values)
          .where(eq(studioPresets.id, seed.id));
        updated += 1;
      } else {
        updated += 1;
      }
      continue;
    }

    await db.insert(studioPresets).values({
      id: seed.id,
      ...values,
      createdAt: now,
    });
    inserted += 1;
  }

  for (const removedId of REMOVED_DEFAULT_STUDIO_PRESET_IDS) {
    await db.delete(studioPresets).where(eq(studioPresets.id, removedId));
    await fs.rm(path.join(seedDir, `${removedId}.png`), { force: true });
    await fs.rm(path.join(resolveCanvasDataRoot(), 'studio-assets', 'presets', removedId), {
      recursive: true,
      force: true,
    });
  }

  return {
    total: DEFAULT_STUDIO_PRESET_SEEDS.length,
    inserted,
    updated,
    seedDir,
  };
}
