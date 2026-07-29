import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const source = await readFile(
    path.join(
      process.cwd(),
      'app',
      '[locale]',
      '(routes)',
      'onboarding',
      'onboarding-wizard.tsx',
    ),
    'utf8',
  );

  assert.match(source, /profileSessionRequestInFlightRef/u);
  assert.match(source, /setProfileSessionError\(message\)/u);
  assert.match(source, /step === 'profile' && !profileSessionId/u);
  assert.match(source, /<ProfileSessionRecovery/u);
  assert.match(source, /onRetry=\{\(\) => void openProfileSession\(\)\.catch/u);
  assert.match(source, /fetch\('\/api\/onboarding\/profile-skip'/u);
  assert.match(source, /profileSessionRetry/u);

  console.log('onboarding-wizard-ui-test: ok');
}

void main();
