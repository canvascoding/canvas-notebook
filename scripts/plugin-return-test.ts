import assert from 'node:assert/strict';
import { safePluginReturnTo, pluginSetupSettingsHref } from '../app/lib/plugins/plugin-return';

const origin = '/de/plugins?view=installed&scope=organization&plugin=mail&source=installed&resourceId=org%3Amail&workspaceId=shared';
assert.equal(safePluginReturnTo(origin), origin);
assert.equal(safePluginReturnTo('/en/plugins?view=discover&plugin=calendar&source=store'), '/en/plugins?view=discover&plugin=calendar&source=store');
for (const invalid of ['https://example.com/plugins', '//example.com/plugins', '/\\example.com/plugins', '/settings', '/en/plugins/other', '/plugins\n', undefined, ['/'+ 'plugins']]) {
  assert.equal(safePluginReturnTo(invalid), null);
}
const settings = new URL(pluginSetupSettingsHref('email', origin, 'shared'), 'https://canvas.invalid');
assert.equal(settings.pathname, '/settings');
assert.equal(settings.searchParams.get('returnTo'), origin);
assert.equal(settings.searchParams.get('workspaceId'), 'shared');
assert.equal(settings.searchParams.get('section'), 'email');
assert.equal(new URL(pluginSetupSettingsHref('composio', '//example.com'), 'https://canvas.invalid').searchParams.has('returnTo'), false);
console.log('Plugin return paths: localized identity, scope/workspace preservation and unsafe destination rejection passed');
