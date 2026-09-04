import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createMobileSetupLink,
  isMobileSetupCompatibility,
} from '../app/lib/mobile/setup-link';

const instanceId = 'cni_0123456789abcdef01234567';

assert.equal(
  createMobileSetupLink('https://notebook.example.com/customer/', instanceId),
  `https://canvasnotebook.app/connect#v=1&server=${encodeURIComponent('https://notebook.example.com/customer')}&instance=${instanceId}`,
);

assert.throws(() => createMobileSetupLink('http://notebook.example.com', instanceId));
assert.throws(() => createMobileSetupLink('https://user:secret@notebook.example.com', instanceId));
assert.throws(() => createMobileSetupLink('https://notebook.example.com?token=secret', instanceId));
assert.throws(() => createMobileSetupLink('https://notebook.example.com', 'cni_invalid'));

assert.equal(isMobileSetupCompatibility({
  product: 'canvas-notebook',
  instance: { id: instanceId, name: 'Customer Notebook' },
}), true);
assert.equal(isMobileSetupCompatibility({
  product: 'canvas-notebook',
  instance: { id: 'cni_invalid', name: 'Customer Notebook' },
}), false);
assert.equal(isMobileSetupCompatibility({
  product: 'another-product',
  instance: { id: instanceId, name: 'Customer Notebook' },
}), false);

const setupCardSource = readFileSync('app/components/mobile/MobileAppSetupCard.tsx', 'utf8');
const homePromoSource = readFileSync('app/components/mobile/HomeMobileAppPromo.tsx', 'utf8');
const homeSource = readFileSync('app/components/home/HomeWorkspaceView.tsx', 'utf8');
const settingsNavigationSource = readFileSync('app/components/settings/SettingsNavigation.tsx', 'utf8');
const settingsClientSource = readFileSync('app/components/settings/IntegrationsSettingsClient.tsx', 'utf8');
assert.match(setupCardSource, /<QRCodeSVG/u);
assert.match(setupCardSource, /bradley-character-starter\.png/u);
assert.match(setupCardSource, /<DialogContent/u);
assert.match(setupCardSource, /onPermanentDismiss/u);
assert.match(homePromoSource, /ACTIVE_USAGE_DELAY_MS\s*=\s*45_000/u);
assert.match(homePromoSource, /SESSION_IMPRESSION_KEY/u);
assert.match(homePromoSource, /LEGACY_DISMISSAL_KEY/u);
assert.match(homeSource, /<HomeMobileAppPromo/u);
assert.match(settingsNavigationSource, /value: 'mobile-app'/u);
assert.match(settingsClientSource, /<MobileAppSetupCard placement="settings" \/>/u);

console.log('mobile-setup-link-test: ok');
