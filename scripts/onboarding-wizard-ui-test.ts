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

  const homePageSource = await readFile(
    path.join(process.cwd(), 'app', '[locale]', '(routes)', 'page.tsx'),
    'utf8',
  );
  assert.match(homePageSource, /HomeHintProvider enabled=\{onboardingHintsEnabled \|\| showPersonalTour\}/u);

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

  console.log('onboarding-wizard-ui-test: ok');
}

void main();
