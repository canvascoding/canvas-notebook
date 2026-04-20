import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { studioPresets } from '@/app/lib/db/schema';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { ensureStudioAssetsWorkspace, writeAssetFile } from '@/app/lib/integrations/studio-workspace';

type StudioPresetCategory =
  | 'fashion'
  | 'product'
  | 'food'
  | 'lifestyle'
  | 'beauty'
  | 'tech'
  | 'interior'
  | 'automotive';

type StudioPresetBlockType = 'lighting' | 'camera' | 'props' | 'background' | 'subject';

interface StudioPresetSeedBlock {
  id: string;
  type: StudioPresetBlockType;
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
  type: StudioPresetBlockType,
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
    description: 'Polished fashion portrait lighting with a clean editorial studio finish.',
    category: 'fashion',
    tags: ['fashion', 'portrait', 'editorial', 'soft light'],
    blocks: [
      block('fashion-softbox-light', 'lighting', 'Softbox Bloom', 'softbox portrait light with luminous skin highlights', 'editorial'),
      block('fashion-three-quarter-cam', 'camera', 'Editorial 3/4', 'editorial three-quarter portrait framing with refined posture', 'editorial'),
      block('fashion-minimal-props', 'props', 'Minimal Styling', 'minimal styling props and subtle fabric texture', 'minimal'),
      block('fashion-seamless-bg', 'background', 'Seamless Blush', 'seamless blush studio backdrop with premium tonal falloff', 'studio'),
      block('fashion-model-subject', 'subject', 'Confident Model', 'confident fashion model as the central subject', 'fashion'),
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
    description: 'Bold runway-inspired fashion preset with colored edge lighting and motion energy.',
    category: 'fashion',
    tags: ['fashion', 'runway', 'neon', 'bold'],
    blocks: [
      block('fashion-neon-light', 'lighting', 'Neon Rim', 'electric neon rim light with cyan and magenta contrast', 'cinematic'),
      block('fashion-wide-cam', 'camera', 'Dynamic Angle', 'dynamic low camera angle with editorial motion feel', 'editorial'),
      block('fashion-reflective-props', 'props', 'Reflective Accent', 'reflective acrylic props and glossy surfaces', 'tech'),
      block('fashion-dark-bg', 'background', 'Smoked Gradient', 'smoked gradient background with nightlife atmosphere', 'studio'),
      block('fashion-runway-subject', 'subject', 'Runway Hero', 'runway hero pose with deliberate movement', 'fashion'),
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
      block('product-clean-light', 'lighting', 'Commercial Softbox', 'clean commercial softbox lighting with crisp edge separation', 'commercial'),
      block('product-close-cam', 'camera', 'Hero Close-Up', 'hero close-up angle with crisp product detail', 'detail'),
      block('product-minimal-props', 'props', 'Minimal Props', 'minimal premium styling props with no clutter', 'minimal'),
      block('product-white-bg', 'background', 'White Cyclorama', 'seamless white cyclorama background', 'studio'),
      block('product-hero-subject', 'subject', 'Hero Product', 'hero product centered with a premium retail finish', 'product'),
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
      block('product-warm-light', 'lighting', 'Warm Window Light', 'warm window light with natural soft shadows', 'lifestyle'),
      block('product-tabletop-cam', 'camera', 'Tabletop Perspective', 'tabletop three-quarter angle with artisanal detail', 'detail'),
      block('product-stone-props', 'props', 'Stone + Linen', 'stone, linen, and ceramic props for tactile depth', 'organic'),
      block('product-earth-bg', 'background', 'Earth Gradient', 'earth-toned gradient background with soft texture', 'environment'),
      block('product-crafted-subject', 'subject', 'Crafted Hero', 'crafted product centerpiece with lifestyle appeal', 'product'),
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
      block('food-daylight-light', 'lighting', 'Fresh Daylight', 'bright diffused daylight with appetizing highlights', 'food'),
      block('food-topdown-cam', 'camera', 'Flatlay', 'top-down flatlay composition with clean spacing', 'layout'),
      block('food-cutlery-props', 'props', 'Menu Styling', 'cutlery, napkin, and garnish props arranged neatly', 'food'),
      block('food-light-bg', 'background', 'Paper Surface', 'matte paper backdrop with subtle texture', 'food'),
      block('food-plated-subject', 'subject', 'Plated Dish', 'beautifully plated dish as the central focal point', 'food'),
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
      block('food-close-cam', 'camera', 'Close Plate Detail', 'close plate detail angle with shallow depth of field', 'detail'),
      block('food-rustic-props', 'props', 'Rustic Table', 'rustic cutlery and textured tabletop props', 'food'),
      block('food-dark-bg', 'background', 'Dark Bistro', 'dark bistro background with low-key ambience', 'environment'),
      block('food-chef-subject', 'subject', 'Chef Plate', 'chef plated dish with elevated garnish and texture', 'food'),
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
      block('life-window-light', 'lighting', 'Morning Window', 'soft morning window light with airy highlights', 'lifestyle'),
      block('life-natural-cam', 'camera', 'Natural Perspective', 'natural eye-level framing with lived-in authenticity', 'lifestyle'),
      block('life-home-props', 'props', 'Everyday Props', 'everyday home props styled with restraint', 'lifestyle'),
      block('life-home-bg', 'background', 'Warm Interior', 'warm interior background with calm architectural lines', 'environment'),
      block('life-story-subject', 'subject', 'Story Moment', 'lifestyle story moment with a relaxed human touch', 'lifestyle'),
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
      block('travel-sun-light', 'lighting', 'Coastal Sun', 'golden coastal sun with gentle lens glow', 'editorial'),
      block('travel-wide-cam', 'camera', 'Wide Editorial', 'wide editorial composition with movement and breathing room', 'editorial'),
      block('travel-props', 'props', 'Travel Props', 'travel props like tote, sunglasses, and textile accents', 'travel'),
      block('travel-bg', 'background', 'Destination Layers', 'destination-inspired background with open airy depth', 'environment'),
      block('travel-subject', 'subject', 'Aspirational Scene', 'aspirational scene with confident story focus', 'lifestyle'),
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
      block('beauty-glow-light', 'lighting', 'Beauty Glow', 'beauty dish light with luminous skincare sheen', 'beauty'),
      block('beauty-close-cam', 'camera', 'Close Beauty Crop', 'close beauty crop focused on skin texture and product finish', 'beauty'),
      block('beauty-glass-props', 'props', 'Glass + Water', 'glass, water, and chrome props with clean reflections', 'beauty'),
      block('beauty-pastel-bg', 'background', 'Mint Glow', 'pastel mint gradient background with soft diffusion', 'studio'),
      block('beauty-subject', 'subject', 'Skincare Hero', 'skincare hero subject with radiant polished finish', 'beauty'),
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
      block('beauty-dramatic-light', 'lighting', 'Gloss Drama', 'dramatic beauty light with glossy specular highlights', 'beauty'),
      block('beauty-detail-cam', 'camera', 'Macro Detail', 'macro detail framing for luxury cosmetic texture', 'detail'),
      block('beauty-metal-props', 'props', 'Metallic Styling', 'metallic beauty props and mirrored surfaces', 'beauty'),
      block('beauty-burgundy-bg', 'background', 'Burgundy Fade', 'rich burgundy gradient background with luxurious depth', 'studio'),
      block('beauty-luxury-subject', 'subject', 'Luxury Cosmetic Hero', 'luxury cosmetic hero arrangement with high polish', 'beauty'),
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
      block('tech-clean-light', 'lighting', 'Precision Glow', 'precision product light with crisp chrome reflections', 'tech'),
      block('tech-hero-cam', 'camera', 'Device Hero', 'hero device perspective with exact industrial lines', 'tech'),
      block('tech-metal-props', 'props', 'Precision Props', 'precision-engineered metallic props and glass accents', 'tech'),
      block('tech-charcoal-bg', 'background', 'Charcoal Gradient', 'charcoal gradient background with subtle depth', 'studio'),
      block('tech-device-subject', 'subject', 'Launch Hero', 'sleek technology device as the unmistakable focal point', 'tech'),
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
      block('tech-neon-light', 'lighting', 'Cyber Rim', 'cyan and violet cyber rim light with performance contrast', 'cinematic'),
      block('tech-low-cam', 'camera', 'Low Hero', 'low hero camera angle with futuristic scale', 'tech'),
      block('tech-grid-props', 'props', 'Grid Props', 'grid props, light bars, and technical surfaces', 'tech'),
      block('tech-neon-bg', 'background', 'Circuit Haze', 'dark circuit-like background with neon haze', 'environment'),
      block('tech-future-subject', 'subject', 'Future Machine', 'futuristic device hero with cinematic energy', 'tech'),
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
      block('interior-soft-light', 'lighting', 'Diffuse Daylight', 'diffuse daylight filling the room with calm softness', 'interior'),
      block('interior-room-cam', 'camera', 'Wide Room', 'wide room composition with balanced symmetry', 'interior'),
      block('interior-natural-props', 'props', 'Oak + Textile', 'oak, boucle, and ceramic styling props', 'interior'),
      block('interior-light-bg', 'background', 'Architectural Shell', 'light architectural shell with gentle tonal layering', 'environment'),
      block('interior-space-subject', 'subject', 'Inviting Space', 'inviting interior space as the featured subject', 'interior'),
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
      block('interior-ambient-light', 'lighting', 'Ambient Glow', 'warm ambient sconces and practical light glow', 'interior'),
      block('interior-cinematic-cam', 'camera', 'Lounge Perspective', 'cinematic room perspective with layered depth', 'interior'),
      block('interior-lounge-props', 'props', 'Lounge Styling', 'lounge styling props with glass, velvet, and brass', 'interior'),
      block('interior-night-bg', 'background', 'Night Lounge', 'night lounge environment with rich shadows', 'environment'),
      block('interior-hospitality-subject', 'subject', 'Hospitality Scene', 'premium hospitality scene with atmospheric focus', 'interior'),
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
      block('auto-rim-light', 'lighting', 'Bodyline Rim', 'bodyline rim lighting tracing the car silhouette', 'automotive'),
      block('auto-low-cam', 'camera', 'Low Stance', 'low wide automotive hero angle with dramatic stance', 'automotive'),
      block('auto-reflective-props', 'props', 'Reflective Floor', 'reflective floor and minimal technical props', 'automotive'),
      block('auto-dark-bg', 'background', 'Dark Studio Bay', 'dark studio bay with controlled reflections', 'studio'),
      block('auto-car-subject', 'subject', 'Performance Vehicle', 'performance vehicle hero as the dominant focal point', 'automotive'),
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
  return path.join(resolveCanvasDataRoot(cwd), 'seeds', 'studio-presets');
}

function renderPresetPreviewSvg(seed: DefaultStudioPresetSeed): string {
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
      // Fall through and generate the asset.
    }
  }

  const svg = renderPresetPreviewSvg(seed);
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
    const previewBuffer = await fs.readFile(path.join(seedDir, `${seed.id}.png`));
    const previewImagePath = `presets/${seed.id}/preview-seed.png`;
    await writeAssetFile(previewImagePath, previewBuffer);

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
      await db.update(studioPresets)
        .set(values)
        .where(eq(studioPresets.id, seed.id));
      updated += 1;
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
