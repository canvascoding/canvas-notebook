import { ensureDefaultStudioPresetsSeeded, ensureStudioPresetSeedAssets } from '../app/lib/integrations/studio-preset-defaults';

async function main() {
  const forceAssets = process.argv.includes('--force-assets');

  const assets = await ensureStudioPresetSeedAssets({ forceAssets });
  const result = await ensureDefaultStudioPresetsSeeded({ forceAssets });

  console.log(`[studio-preset-seed] Seed assets: ${assets.files.length} PNGs in ${assets.seedDir}`);
  console.log(`[studio-preset-seed] Database presets: ${result.total} total (${result.inserted} inserted, ${result.updated} updated)`);
}

main().catch((error) => {
  console.error('[studio-preset-seed] Failed:', error);
  process.exit(1);
});
