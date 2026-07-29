import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getPathWithoutLicenseKey } from '../app/lib/license/browser-url';

async function main() {
  assert.equal(
    getPathWithoutLicenseKey('https://canvas.example/de/onboarding?key=secret&source=email#activate'),
    '/de/onboarding?source=email#activate',
  );
  assert.equal(
    getPathWithoutLicenseKey('https://canvas.example/settings?tab=license&key=one&key=two'),
    '/settings?tab=license',
  );
  assert.equal(
    getPathWithoutLicenseKey('https://canvas.example/de/onboarding?source=email'),
    null,
  );

  const wizardSource = await readFile(
    path.join(process.cwd(), 'app', '[locale]', '(routes)', 'onboarding', 'onboarding-wizard.tsx'),
    'utf8',
  );
  assert.match(wizardSource, /useEffect\(\(\) => \{\s*scrubLicenseKeyFromBrowserUrl\(\);\s*\}, \[\]\)/u);

  const settingsLicenseSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'license', 'LicenseActivationPanel.tsx'),
    'utf8',
  );
  assert.match(settingsLicenseSource, /useEffect\(\(\) => \{\s*scrubLicenseKeyFromBrowserUrl\(\);\s*\}, \[\]\)/u);

  console.log('onboarding-license-url-test: ok');
}

void main();
