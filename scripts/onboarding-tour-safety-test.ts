import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function readWorkspaceFile(...segments: string[]) {
  return readFile(path.join(process.cwd(), ...segments), 'utf8');
}

async function main() {
  const previousOnboardingHints = process.env.ONBOARDING_HINTS;
  try {
    const { resolveGuidedTourStatus } = await import('../app/lib/onboarding/tour-gate');

    delete process.env.ONBOARDING_HINTS;
    assert.equal(resolveGuidedTourStatus('started'), 'skipped');
    assert.equal(resolveGuidedTourStatus('completed'), 'completed');

    process.env.ONBOARDING_HINTS = 'true';
    assert.equal(resolveGuidedTourStatus('started'), 'started');

    const homePage = await readWorkspaceFile('app', '[locale]', '(routes)', 'page.tsx');
    assert.match(homePage, /HomeHintProvider enabled=\{onboardingHintsEnabled\}/u);
    assert.doesNotMatch(homePage, /onboardingHintsEnabled \|\| showPersonalTour/u);

    const onboardingPage = await readWorkspaceFile('app', '[locale]', '(routes)', 'onboarding', 'page.tsx');
    assert.match(onboardingPage, /guidedHintsEnabled=\{isOnboardingHintsEnabled\(\)\}/u);

    const wizard = await readWorkspaceFile('app', '[locale]', '(routes)', 'onboarding', 'onboarding-wizard.tsx');
    assert.match(wizard, /guidedHintsEnabled \? t\('tourStart'\) : t\('tourContinue'\)/u);
    assert.match(wizard, /void finish\(guidedHintsEnabled \? 'started' : 'skipped'\)/u);

    const tooltip = await readWorkspaceFile('app', 'components', 'onboarding', 'HintTooltip.tsx');
    assert.match(tooltip, /aria-hidden="true" className="pointer-events-none fixed inset-0 z-\[100\] bg-black\/40"/u);
    assert.doesNotMatch(tooltip, /z-\[100\] bg-black\/40" onClick=\{onDismiss\}/u);

    console.log('onboarding-tour-safety-test: ok');
  } finally {
    if (previousOnboardingHints === undefined) delete process.env.ONBOARDING_HINTS;
    else process.env.ONBOARDING_HINTS = previousOnboardingHints;
  }
}

void main();
