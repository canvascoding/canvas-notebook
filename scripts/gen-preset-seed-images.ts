import { DEFAULT_STUDIO_PRESET_SEEDS, renderPresetPreviewSvg } from '../app/lib/integrations/studio-preset-defaults';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const targetDir = path.join(process.cwd(), 'seed_sys_prompts', 'studio-preset-previews');
  await fs.mkdir(targetDir, { recursive: true });

  for (const seed of DEFAULT_STUDIO_PRESET_SEEDS) {
    const svg = renderPresetPreviewSvg(seed);
    const outPath = path.join(targetDir, `${seed.id}.png`);
    await sharp(Buffer.from(svg)).png().toFile(outPath);
    const stat = await fs.stat(outPath);
    console.log(`Generated: ${seed.id}.png (${Math.round(stat.size / 1024)} KB)`);
  }

  console.log(`\nDone! ${DEFAULT_STUDIO_PRESET_SEEDS.length} seed PNGs generated in ${targetDir}`);
}

main().catch((error) => {
  console.error('Failed:', error);
  process.exit(1);
});