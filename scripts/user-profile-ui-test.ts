import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { USER_AVATAR_ICON_IDS } from '../app/lib/user-profile/icon-catalog';

type Messages = {
  userProfile?: {
    icons?: Record<string, string>;
    [key: string]: unknown;
  };
};

async function main() {
  const root = process.cwd();
  const [
    english,
    german,
    editorSource,
    avatarSource,
    settingsPageSource,
    generalSettingsSource,
    onboardingPageSource,
    onboardingWizardSource,
    homePageSource,
  ] = await Promise.all([
    readFile(path.join(root, 'messages/en.json'), 'utf8').then((value) => JSON.parse(value) as Messages),
    readFile(path.join(root, 'messages/de.json'), 'utf8').then((value) => JSON.parse(value) as Messages),
    readFile(path.join(root, 'app/components/user-profile/ProfileAppearanceEditor.tsx'), 'utf8'),
    readFile(path.join(root, 'app/components/user-profile/UserAvatar.tsx'), 'utf8'),
    readFile(path.join(root, 'app/[locale]/(routes)/settings/page.tsx'), 'utf8'),
    readFile(path.join(root, 'app/components/settings/GeneralSettingsPanel.tsx'), 'utf8'),
    readFile(path.join(root, 'app/[locale]/(routes)/onboarding/page.tsx'), 'utf8'),
    readFile(path.join(root, 'app/[locale]/(routes)/onboarding/onboarding-wizard.tsx'), 'utf8'),
    readFile(path.join(root, 'app/[locale]/(routes)/page.tsx'), 'utf8'),
  ]);

  for (const messages of [english, german]) {
    assert.ok(messages.userProfile, 'profile translations must exist');
    for (const iconId of USER_AVATAR_ICON_IDS) {
      assert.equal(typeof messages.userProfile.icons?.[iconId], 'string', `missing icon label: ${iconId}`);
    }
  }

  assert.match(editorSource, /USER_AVATAR_ICON_IDS\.map/, 'editor must render the complete icon allowlist');
  assert.match(editorSource, /MAX_UPLOAD_BYTES = 5 \* 1024 \* 1024/, 'client must advertise the server upload limit');
  assert.match(editorSource, /credentials: 'include'/, 'profile mutations must use the authenticated session');
  assert.match(editorSource, /formData\.set\('avatar', file\)/, 'the editor must use the avatar upload field');
  assert.doesNotMatch(editorSource, /URL\.createObjectURL/, 'untrusted local files must not flow directly into image URLs');
  assert.doesNotMatch(editorSource, /userId/, 'profile mutations must not accept a client-selected user ID');
  assert.match(avatarSource, /failedImageUrl/, 'broken profile images must fall back locally');
  assert.match(avatarSource, /profile\.initials/, 'avatar must render initials as the final fallback');
  assert.match(settingsPageSource, /resolveUserProfile/, 'settings must resolve the signed-in user profile server-side');
  assert.match(settingsPageSource, /initialUserProfile=\{initialUserProfile\}/, 'settings must pass the profile to the client');
  assert.match(generalSettingsSource, /<ProfileAppearanceEditor initialProfile=\{initialUserProfile\}/, 'general settings must render the shared editor');
  assert.match(onboardingPageSource, /resolveUserProfile/, 'onboarding must resolve the signed-in user profile server-side');
  assert.match(onboardingWizardSource, /step === 'language'[\s\S]*?<LanguageStep/, 'profile appearance must remain in the existing language step');
  assert.match(onboardingWizardSource, /<ProfileAppearanceEditor initialProfile=\{initialUserProfile\}/, 'language step must render the shared editor');
  assert.match(homePageSource, /resolveUserProfile/, 'home must resolve the signed-in user profile server-side');
  assert.match(homePageSource, /<UserProfileBadge profile=\{userProfile\}/, 'home header must show the profile badge');

  console.log(`User profile UI contract passed with ${USER_AVATAR_ICON_IDS.length} curated icons.`);
}

void main();
