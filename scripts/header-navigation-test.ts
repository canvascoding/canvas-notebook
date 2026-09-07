import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const launcherSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'AppLauncher.tsx'),
    'utf8',
  );
  assert.match(launcherSource, /onClick=\{inMenu \? undefined : close\}/u);
  assert.doesNotMatch(launcherSource, /href=\{app\.href\}[\s\S]{0,300}onClick=\{closeLauncher\}/u);

  const backButtonSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'navigation', 'AppBackButton.tsx'),
    'utf8',
  );
  assert.match(backButtonSource, /window\.setTimeout\(handleBack, 0\)/u);
  assert.match(backButtonSource, /window\.setTimeout\(handleHome, 0\)/u);
  assert.match(backButtonSource, /onSelect=\{handleMenuHome\}/u);

  console.log('header-navigation-test: ok');
}

void main();
