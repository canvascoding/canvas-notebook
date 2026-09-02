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
  assert.match(source, /function skipLicenseActivation\(\)/u);
  assert.match(source, /t\('licenseSkip'\)/u);
  assert.doesNotMatch(source, /onClick=\{onContinue\} disabled=\{!licensed\}/u);

  const userManagementSource = await readFile(
    path.join(process.cwd(), 'app', 'components', 'settings', 'UserManagementPanel.tsx'),
    'utf8',
  );
  assert.match(userManagementSource, /pendingCreatedUser/u);
  assert.match(userManagementSource, /if \(pendingCreatedUser\)/u);
  assert.match(userManagementSource, /await initializeCreatedUser\(pendingUser\.id\)/u);
  assert.match(userManagementSource, /setPendingCreatedUser\(\{ id: created\.user\.id, email: created\.user\.email \}\)/u);
  assert.match(userManagementSource, /createDialog\.recoveryDescription/u);
  assert.match(userManagementSource, /createDialog\.retrySetup/u);
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
  assert.match(appLauncherSource, /<HelpDropdown \/>/u);

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
