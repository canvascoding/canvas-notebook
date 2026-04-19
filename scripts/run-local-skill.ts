import { AD_LOCALIZATION_ALL_FAILED_MESSAGE, localizeAd, type LocalizeAdRequestBody } from '../app/lib/integrations/ad-localization-service';

function parseArgs(): { payload: unknown } {
  const [skillArg, payloadArg = '{}'] = process.argv.slice(2);
  if (!skillArg || !['ad-localization'].includes(skillArg)) {
    throw new Error('Unknown or missing skill name.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadArg);
  } catch {
    throw new Error('Invalid JSON payload.');
  }

  return { payload };
}

async function main() {
  const { payload } = parseArgs();

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
