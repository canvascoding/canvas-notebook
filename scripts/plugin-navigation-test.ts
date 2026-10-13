import assert from 'node:assert/strict';
import { legacyPluginSettingsHref, readPluginNavigation, updatePluginNavigation } from '../app/lib/plugins/plugin-navigation';

assert.deepEqual(readPluginNavigation(new URLSearchParams()), { area: 'plugins', view: 'browse', scope: 'all' });
assert.deepEqual(readPluginNavigation(new URLSearchParams('area=skills&view=library&scope=organization')), { area: 'skills', view: 'library', scope: 'organization' });
assert.equal(readPluginNavigation(new URLSearchParams('area=skills&view=advanced')).view, 'installed');
assert.equal(readPluginNavigation(new URLSearchParams('view=library&scope=system')).view, 'installed');
assert.equal(readPluginNavigation(new URLSearchParams('scope=system')).scope, 'system');
assert.equal(updatePluginNavigation('view=advanced&q=mail', { area: 'skills' }), '/plugins?q=mail&area=skills&view=installed');
assert.equal(updatePluginNavigation('area=skills&view=library&scope=organization', { area: 'plugins' }), '/plugins?scope=organization&view=installed');
assert.equal(updatePluginNavigation('view=updates&scope=organization', { scope: 'user' }), '/plugins?view=updates');
assert.equal(legacyPluginSettingsHref({ tab: 'plugins' }), '/plugins?view=installed');
assert.equal(legacyPluginSettingsHref({ tab: ['skills'], view: 'library', scope: 'organization' }), '/plugins?view=library&scope=organization&area=skills');
assert.equal(legacyPluginSettingsHref({ tab: 'general' }), null);
assert.equal(legacyPluginSettingsHref({ tab: 'plugins', q: 'mail & calendar' }), '/plugins?q=mail+%26+calendar&view=installed');
const filtered = readPluginNavigation(new URLSearchParams('view=discover&q=team&page=3&category=Work&connection=mcp'));
assert.equal(filtered.q, 'team');
assert.equal(filtered.page, 3);
assert.equal(filtered.category, 'Work');
assert.equal(filtered.connection, 'mcp');
assert.equal(readPluginNavigation(new URLSearchParams('page=3junk&connection=invalid&readiness=invalid&enabled=all')).page, undefined);
assert.equal(readPluginNavigation(new URLSearchParams('page=100001')).page, undefined);
const resetPage = new URL(updatePluginNavigation('view=discover&q=team&page=3&category=Work', { connection: 'mcp' }), 'https://canvas.test');
assert.equal(resetPage.searchParams.has('page'), false, 'filter changes reset pagination');
assert.equal(resetPage.searchParams.get('q'), 'team');
const resetScope = new URL(updatePluginNavigation('view=installed&q=team&page=3&readiness=available&enabled=enabled', { scope: 'organization' }), 'https://canvas.test');
assert.equal(resetScope.searchParams.get('scope'), 'organization');
assert.equal(resetScope.searchParams.get('q'), 'team', 'ownership filtering preserves the shared search');
for (const key of ['page', 'readiness', 'enabled']) assert.equal(resetScope.searchParams.has(key), false);
const installedView = new URL(updatePluginNavigation('view=discover&q=team&page=3&category=Work&connection=mcp', { view: 'installed' }), 'https://canvas.test');
assert.equal(installedView.searchParams.get('q'), 'team');
for (const key of ['page', 'category', 'connection']) assert.equal(installedView.searchParams.has(key), false);
const detailHref = new URL(updatePluginNavigation('view=discover&q=team&page=3&category=Work&connection=mcp', { plugin: 'team-plugin', source: 'store' }), 'https://canvas.test');
assert.equal(detailHref.searchParams.get('page'), '3', 'opening a detail preserves list position');
assert.equal(detailHref.searchParams.get('connection'), 'mcp');
const resourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
const draftRef = 'canvas-package-draft:22222222-2222-4222-8222-222222222222';
const draft = readPluginNavigation(new URLSearchParams({ area: 'skills', view: 'drafts', resourceRef, draftRef,
  task: 'content', file: 'scripts/run.py', scope: 'team', teamId: 'accessible-workspace' }));
assert.deepEqual(draft, { area: 'skills', view: 'drafts', scope: 'team', teamId: 'accessible-workspace',
  resourceRef, draftRef, task: 'content', file: 'scripts/run.py' });
assert.equal(readPluginNavigation(new URLSearchParams('scope=team')).scope, 'team', 'an unselected team never becomes a personal selection');
assert.equal(readPluginNavigation(new URLSearchParams('scope=organization&audience=shared&teamId=old')).audience, undefined);
assert.equal(readPluginNavigation(new URLSearchParams('scope=organization&teamId=old')).teamId, undefined);
const legacySource = 'canvas-capability:v1:skill:system:core:design-context';
assert.equal(readPluginNavigation(new URLSearchParams({ view: 'drafts', draftRef, resourceRef: legacySource })).resourceRef,
  legacySource, 'creator recovery can select an existing system source without adopting it');
assert.equal(readPluginNavigation(new URLSearchParams({ area: 'skills', skill: 'übersicht',
  resourceRef: 'canvas-capability:v1:skill:system:core:%C3%BCbersicht' })).skill, 'übersicht');
assert.equal(readPluginNavigation(new URLSearchParams({ resourceRef: 'canvas-capability:v1:skill:system:core:%C3%BCbersicht' })).resourceRef,
  'canvas-capability:v1:skill:system:core:%C3%BCbersicht', 'encoded Unicode source identity stays exact');
for (const invalid of ['https://outside.invalid/source', '/data/private', 'canvas-capability:v1:skill:system:core:bad%xx']) {
  assert.equal(readPluginNavigation(new URLSearchParams({ resourceRef: invalid })).resourceRef, undefined);
}
for (const file of ['/private/key', '../secrets.env', 'scripts/../../secrets.env', 'C:\\secret', 'scripts//run.py']) {
  assert.equal(readPluginNavigation(new URLSearchParams({ resourceRef, task: 'content', file })).file, undefined);
}
assert.equal(readPluginNavigation(new URLSearchParams({ resourceRef, task: 'sharing', file: 'scripts/run.py' })).file, undefined);
assert.equal(readPluginNavigation(new URLSearchParams({ view: 'installed', draftRef })).draftRef, undefined);
const teamChange = new URL(updatePluginNavigation(new URLSearchParams({ scope: 'team', teamId: 'first', view: 'drafts',
  draftRef, resourceRef, task: 'content', file: 'scripts/run.py' }).toString(), { teamId: 'second' }), 'https://canvas.test');
assert.equal(teamChange.searchParams.get('teamId'), 'second');
for (const key of ['draftRef', 'resourceRef', 'task', 'file']) assert.equal(teamChange.searchParams.has(key), false);
const ownChange = new URL(updatePluginNavigation(new URLSearchParams({ scope: 'user', audience: 'own', view: 'installed',
  resourceRef, task: 'sharing' }).toString(), { audience: 'shared' }), 'https://canvas.test');
assert.equal(ownChange.searchParams.get('audience'), 'shared');
assert.equal(ownChange.searchParams.has('resourceRef'), false);
const resume = new URL(updatePluginNavigation('view=installed&q=design&page=3', { area: 'skills', view: 'drafts',
  resourceRef: legacySource, draftRef, task: 'content' }), 'https://canvas.test');
assert.equal(resume.searchParams.get('view'), 'drafts');
assert.equal(resume.searchParams.get('resourceRef'), legacySource);
assert.equal(resume.searchParams.get('draftRef'), draftRef);
assert.equal(resume.searchParams.has('page'), false);
const closeDraft = new URL(updatePluginNavigation(resume.search.slice(1), { resourceRef: undefined, draftRef: undefined }), 'https://canvas.test');
assert.equal(closeDraft.searchParams.get('view'), 'drafts', 'closing a draft preserves its list');
assert.equal(closeDraft.searchParams.has('task'), false);
const legacyDraftHref = new URL(legacyPluginSettingsHref({ tab: 'skills', view: 'drafts', draftRef,
  resourceRef: legacySource, task: 'content' })!, 'https://canvas.test');
assert.equal(legacyDraftHref.searchParams.get('draftRef'), draftRef);
assert.equal(legacyDraftHref.searchParams.get('resourceRef'), legacySource);
const checksum = 'a'.repeat(64);
const exactStore = readPluginNavigation(new URLSearchParams({ area: 'skills', skill: 'design-context', source: 'store',
  scope: 'all', kind: 'all', storeRegistryId: 'verified-registry', storeVersion: '1.2.3', storeChecksum: checksum }));
assert.equal(exactStore.view, 'library', 'legacy skill Store detail keeps its Store view');
assert.equal(exactStore.source, 'store');
assert.equal(exactStore.scope, 'all');
assert.equal(exactStore.kind, 'all');
assert.equal(exactStore.storeRegistryId, 'verified-registry');
assert.equal(exactStore.storeVersion, '1.2.3');
assert.equal(exactStore.storeChecksum, checksum);
assert.equal(readPluginNavigation(new URLSearchParams('plugin=design-bundle')).view, 'discover', 'legacy named plugin Store links remain usable');
assert.equal(readPluginNavigation(new URLSearchParams('plugin=design-bundle&source=installed')).view, 'installed');
assert.equal(readPluginNavigation(new URLSearchParams({ area: 'skills', skill: 'design-context', source: 'store', storeChecksum: 'bad' })).storeChecksum, undefined);
assert.equal(readPluginNavigation(new URLSearchParams({ plugin: 'design-bundle', source: 'installed', storeRegistryId: 'ignored', storeVersion: '2', storeChecksum: checksum })).storeRegistryId, undefined);
const changedKind = new URL(updatePluginNavigation(new URLSearchParams({ view: 'discover', kind: 'all', plugin: 'design-bundle', source: 'store',
  storeRegistryId: 'verified-registry', storeVersion: '1.2.3', storeChecksum: checksum, page: '3' }).toString(), { kind: 'skill' }), 'https://canvas.test');
for (const key of ['plugin', 'source', 'storeRegistryId', 'storeVersion', 'storeChecksum', 'page']) assert.equal(changedKind.searchParams.has(key), false);
const skillStoreRedirect = new URL(legacyPluginSettingsHref({ tab: 'skills', skill: 'design-context', source: 'store',
  storeRegistryId: 'verified-registry', storeVersion: '1.2.3', storeChecksum: checksum })!, 'https://canvas.test');
assert.equal(skillStoreRedirect.searchParams.get('source'), 'store');
assert.equal(skillStoreRedirect.searchParams.get('storeChecksum'), checksum);
const browse = 'view=browse&q=Canva&kind=all&stock=installed&extensionSource=composio&extensionCursor=opaque_cursor';
const browseDetail = new URL(updatePluginNavigation(browse, { extensionId: 'composio:canva' }), 'https://canvas.test');
assert.equal(browseDetail.searchParams.get('q'), 'Canva');
assert.equal(browseDetail.searchParams.get('stock'), 'installed');
assert.equal(browseDetail.searchParams.get('extensionCursor'), 'opaque_cursor');
const browseKind = new URL(updatePluginNavigation(browseDetail.search.slice(1), { kind: 'mcp' }), 'https://canvas.test');
assert.equal(browseKind.searchParams.get('q'), 'Canva');
assert.equal(browseKind.searchParams.has('extensionId'), false);
assert.equal(browseKind.searchParams.has('extensionCursor'), false);
const browsePackage = new URL(updatePluginNavigation(browse, { area: 'skills', resourceRef, task: 'connections' }), 'https://canvas.test');
assert.equal(browsePackage.searchParams.get('q'), 'Canva');
assert.equal(browsePackage.searchParams.get('kind'), 'all');
assert.equal(browsePackage.searchParams.get('extensionCursor'), 'opaque_cursor');
const browseSearch = new URL(updatePluginNavigation(browsePackage.search.slice(1), { q: 'Slack' }), 'https://canvas.test');
assert.equal(browseSearch.searchParams.has('resourceRef'), false, 'a new search returns to the same mixed list');
assert.equal(browseSearch.searchParams.has('extensionCursor'), false);
assert.equal(readPluginNavigation(new URLSearchParams('view=browse&extensionId=composio:duckduckgo')).extensionId, 'composio:duckduckgo');
assert.equal(readPluginNavigation(new URLSearchParams('view=browse&extensionId=composio:my-toolkit')).extensionId, 'composio:my-toolkit');
for (const invalid of ['composio-personal:private-profile:private-account', 'https://outside.invalid', 'composio:CANVA', 'composio:canva\n']) {
  assert.equal(readPluginNavigation(new URLSearchParams({ view: 'browse', extensionId: invalid })).extensionId, undefined);
}
const returned = readPluginNavigation(new URLSearchParams({ view: 'browse', workspaceId: 'workspace-readable', scope: 'all',
  q: 'Canva', extensionId: 'composio:canva', connectionRef: 'canvas-connection:11111111-1111-4111-8111-111111111111', sharedOAuth: 'cancelled' }));
assert.equal(returned.connectionRef, 'canvas-connection:11111111-1111-4111-8111-111111111111');
assert.equal(returned.sharedOAuth, 'cancelled');
console.log('Plugin navigation: explicit views, area defaults, legacy links, scope validation and query preservation passed');
