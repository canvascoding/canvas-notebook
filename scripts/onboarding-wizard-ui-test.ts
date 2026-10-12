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

  assert.match(source, /useOnboardingProfileSession/u);
  assert.match(source, /step === 'profile'/u);
  assert.match(source, /<ProfileSessionRecovery/u);
  assert.match(source, /onRetry=\{\(\) => void profileSession\.retry\(\)\}/u);
  assert.match(source, /showWorkspaceSwitcher=\{false\}/u);
  assert.match(source, /fetch\('\/api\/onboarding\/profile-skip'/u);
  assert.match(source, /profileSessionRetry/u);
  assert.match(source, /function skipLicenseActivation\(\)/u);
  assert.match(source, /t\('licenseSkip'\)/u);
  assert.doesNotMatch(source, /onClick=\{onContinue\} disabled=\{!licensed\}/u);

  const userManagementSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'settings', 'UserManagementPanel.tsx'),
    'utf8',
  );
  assert.match(userManagementSource, /managedPendingKey/u);
  assert.match(userManagementSource, /managedPendingKey \? \(/u);
  assert.match(userManagementSource, /encodeURIComponent\(managedPendingKey\).*\/activate/u);
  assert.match(userManagementSource, /membershipSeatQuote \? \(/u);
  assert.match(userManagementSource, /membershipSeatQuote\.refreshRequired/u);
  assert.match(userManagementSource, /includesTeamRuntimeLicense/u);
  assert.match(userManagementSource, /teamLicenseRequiredTitle/u);
  assert.match(userManagementSource, /href="\/settings\?tab=license"/u);

  const licenseSettingsSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'license', 'LicenseActivationPanel.tsx'),
    'utf8',
  );
  assert.match(licenseSettingsSource, /Die Aktivierung ist freiwillig/u);
  assert.match(licenseSettingsSource, /Activation is optional/u);
  assert.doesNotMatch(licenseSettingsSource, /window\.location\.href = '\/'/u);

  const waitingActionsSource = await readFile(
    path.join(
      process.cwd(),
      'app',
      '[locale]',
      '(routes)',
      'onboarding',
      'onboarding-waiting-actions.tsx',
    ),
    'utf8',
  );
  assert.match(waitingActionsSource, /STATUS_REFRESH_INTERVAL_MS = 10_000/u);
  assert.match(waitingActionsSource, /document\.visibilityState === 'visible'/u);
  assert.match(waitingActionsSource, /router\.refresh\(\)/u);
  assert.match(waitingActionsSource, /authClient\.signOut\(\)/u);

  const onboardingPageSource = await readFile(
    path.join(process.cwd(), 'app', '[locale]', '(routes)', 'onboarding', 'page.tsx'),
    'utf8',
  );
  assert.match(onboardingPageSource, /phase === 'waiting'[\s\S]*?<OnboardingWaitingActions \/>/u);
  assert.match(onboardingPageSource, /guidedHintsEnabled=\{isOnboardingHintsEnabled\(\)\}/u);

  const homePageSource = await readFile(
    path.join(process.cwd(), 'app', '[locale]', '(routes)', 'page.tsx'),
    'utf8',
  );
  assert.match(homePageSource, /HomeHintProvider enabled=\{onboardingHintsEnabled\}/u);
  assert.doesNotMatch(homePageSource, /onboardingHintsEnabled \|\| showPersonalTour/u);

  const appLauncherSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'AppLauncher.tsx'),
    'utf8',
  );
  assert.match(appLauncherSource, /id: 'help', href: '\/help'/u);

  const gettingStartedSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'onboarding', 'GettingStartedCard.tsx'),
    'utf8',
  );
  assert.match(gettingStartedSource, /setDismissError/u);
  assert.match(gettingStartedSource, /role="alert"/u);

  const hintTooltipSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'onboarding', 'HintTooltip.tsx'),
    'utf8',
  );
  assert.match(hintTooltipSource, /const didOverridePosition = getComputedStyle\(targetEl\)\.position === 'static'/u);
  assert.match(hintTooltipSource, /if \(didOverridePosition\) \{\s*targetEl\.style\.position = origPosition/u);
  assert.match(hintTooltipSource, /aria-hidden="true" className="pointer-events-none fixed inset-0 z-\[100\] bg-black\/40"/u);
  assert.doesNotMatch(hintTooltipSource, /z-\[100\] bg-black\/40" onClick=\{onDismiss\}/u);
  assert.match(source, /guidedHintsEnabled \? t\('tourStart'\) : t\('tourContinue'\)/u);

  console.log('onboarding-wizard-ui-test: ok');
}

void main();
