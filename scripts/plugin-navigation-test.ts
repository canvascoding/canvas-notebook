import assert from 'node:assert/strict';
import { legacyPluginSettingsHref, readPluginNavigation, updatePluginNavigation } from '../app/lib/plugins/plugin-navigation';

assert.deepEqual(readPluginNavigation(new URLSearchParams()), { area: 'plugins', view: 'discover', scope: 'user' });
assert.deepEqual(readPluginNavigation(new URLSearchParams('area=skills&view=library&scope=organization')), { area: 'skills', view: 'library', scope: 'organization' });
assert.equal(readPluginNavigation(new URLSearchParams('area=skills&view=advanced')).view, 'installed');
assert.equal(readPluginNavigation(new URLSearchParams('view=library&scope=system')).view, 'discover');
assert.equal(readPluginNavigation(new URLSearchParams('scope=system')).scope, 'user');
assert.equal(updatePluginNavigation('view=advanced&q=mail', { area: 'skills' }), '/plugins?q=mail&area=skills&view=installed');
assert.equal(updatePluginNavigation('area=skills&view=library&scope=organization', { area: 'plugins' }), '/plugins?scope=organization&view=discover');
assert.equal(updatePluginNavigation('view=updates&scope=organization', { scope: 'user' }), '/plugins?view=updates');
assert.equal(legacyPluginSettingsHref({ tab: 'plugins' }), '/plugins?view=discover');
assert.equal(legacyPluginSettingsHref({ tab: ['skills'], view: 'library', scope: 'organization' }), '/plugins?view=library&scope=organization&area=skills');
assert.equal(legacyPluginSettingsHref({ tab: 'general' }), null);
assert.equal(legacyPluginSettingsHref({ tab: 'plugins', q: 'mail & calendar' }), '/plugins?q=mail+%26+calendar&view=discover');
console.log('Plugin navigation: explicit views, area defaults, legacy links, scope validation and query preservation passed');
