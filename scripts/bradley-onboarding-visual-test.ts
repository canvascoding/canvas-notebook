import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function main(): void {
  const source = readProjectFile('app/[locale]/(routes)/onboarding/onboarding-wizard.tsx');
  const doneAsset = readProjectFile('public/images/bradley/bradley-done.svg');
  const de = JSON.parse(readProjectFile('messages/de.json')) as { onboarding: Record<string, string> };
  const en = JSON.parse(readProjectFile('messages/en.json')) as { onboarding: Record<string, string> };

  assert.match(source, /data-testid="bradley-onboarding-intro"/u);
  assert.equal(source.match(/<BradleyOnboardingIntro(?: compact)? \/>/gu)?.length, 2);
  assert.match(source, /src="\/images\/bradley\/bradley-character-starter\.png"/u);
  assert.match(source, /data-testid="bradley-onboarding-complete"/u);
  assert.match(source, /src="\/images\/bradley\/bradley-done\.svg"/u);
  assert.match(source, /src="\/images\/bradley\/bradley-done\.svg"[\s\S]*?unoptimized/u);
  assert.doesNotMatch(source, /bradley-generating\.svg/u);
  assert.equal(de.onboarding.profileEyebrow, 'Bradley · Hauptagent');
  assert.equal(en.onboarding.profileEyebrow, 'Bradley · Main agent');

  assert.match(doneAsset, /viewBox="0 0 64 64"/u);
  assert.match(doneAsset, /aria-labelledby="bradley-done-title bradley-done-desc"/u);
  assert.match(doneAsset, /<rect[^>]+width="15"[^>]+height="15"/u);
  assert.match(doneAsset, /stroke="#fff"/u);

  console.log('bradley-onboarding-visual-test: ok');
}

main();
