import { generateImages, IMAGE_GENERATION_ALL_FAILED_MESSAGE, type GenerateImageRequestBody } from '../app/lib/integrations/image-generation-service';
import { generateVideo, type GenerateVideoRequestBody } from '../app/lib/integrations/veo-generation-service';
import { AD_LOCALIZATION_ALL_FAILED_MESSAGE, localizeAd, type LocalizeAdRequestBody } from '../app/lib/integrations/ad-localization-service';

type SkillName = 'image-generation' | 'video-generation' | 'ad-localization';

function parseArgs(): { skill: SkillName; payload: unknown } {
  const [skillArg, payloadArg = '{}'] = process.argv.slice(2);
  if (!skillArg || !['image-generation', 'video-generation', 'ad-localization'].includes(skillArg)) {
    throw new Error('Unknown or missing skill name.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadArg);
  } catch {
    throw new Error('Invalid JSON payload.');
  }

  return {
    skill: skillArg as SkillName,
    payload,
  };
}

async function main() {
  const { skill, payload } = parseArgs();

  if (skill === 'image-generation') {
    const data = await generateImages(payload as GenerateImageRequestBody, 'local-skill-cli');
    if (data.successCount === 0) {
      console.log(JSON.stringify({ success: false, error: IMAGE_GENERATION_ALL_FAILED_MESSAGE, data }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ success: true, data }, null, 2));
    return;
  }

  if (skill === 'video-generation') {
    const data = await generateVideo(payload as GenerateVideoRequestBody, 'local-skill-cli');
    console.log(JSON.stringify({ success: true, data }, null, 2));
    return;
  }

  const data = await localizeAd(payload as LocalizeAdRequestBody, 'local-skill-cli');
  if (data.successCount === 0) {
    console.log(JSON.stringify({ success: false, error: AD_LOCALIZATION_ALL_FAILED_MESSAGE, data }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ success: true, data }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown local skill error';
  console.log(JSON.stringify({ success: false, error: message }, null, 2));
  process.exit(1);
});
