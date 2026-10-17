import assert from 'node:assert/strict';
import { createSharedConnectionOAuthReturn, sharedConnectionOAuthReturnHref, validateSharedConnectionOAuthReturn } from '../app/lib/integration-tools/connections/oauth-return';
import type { IntegrationConnectionResource } from '../app/lib/integration-tools/connections/contracts';

const connectionRef = 'canvas-connection:11111111-1111-4111-8111-111111111111';
const resourceRef = 'canvas-resource:22222222-2222-4222-8222-222222222222';
const actor = {workspaceId: 'actual-execution-workspace'};
const resource: IntegrationConnectionResource = {connectionRef, source: 'composio', ownership: {type: 'team', organizationId: 'org', workspaceId: 'actual-owner-team'},
  displayName: 'Canva team', description: null, application: 'canva', responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
  metadataRevision: 1, grantsRevision: 1, bindingRevision: 1, allowedToolNames: null, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1};
const query = new URLSearchParams({view: 'browse', q: 'Canva & design', scope: 'all', kind: 'integration', stock: 'installed', extensionSource: 'composio', extensionId: 'composio:canva', workspaceId: actor.workspaceId});
const context = createSharedConnectionOAuthReturn(resource, actor, 'de', `/de/plugins?${query}`);
for (const status of ['connected', 'cancelled', 'failed'] as const) {
  const url = new URL(sharedConnectionOAuthReturnHref(context, status), 'https://canvas.invalid');
  assert.equal(url.pathname, '/de/plugins'); assert.equal(url.searchParams.get('view'), 'browse');
  assert.equal(url.searchParams.get('q'), 'Canva & design'); assert.equal(url.searchParams.get('scope'), 'all');
  assert.equal(url.searchParams.get('extensionId'), 'composio:canva'); assert.equal(url.searchParams.get('connectionRef'), connectionRef);
  assert.equal(url.searchParams.get('workspaceId'), actor.workspaceId); assert.equal(url.searchParams.get('sharedOAuth'), status);
  assert.equal(url.searchParams.has('teamId'), false, 'browsing all is separate from actual team ownership');
}
const packageReturn = createSharedConnectionOAuthReturn(resource, actor, 'en', `/en/plugins?view=browse&q=workflow&scope=all&resourceRef=${resourceRef}&task=connections`);
const packageUrl = new URL(sharedConnectionOAuthReturnHref(packageReturn, 'cancelled'), 'https://canvas.invalid');
assert.equal(packageUrl.searchParams.get('resourceRef'), resourceRef); assert.equal(packageUrl.searchParams.get('task'), 'connections');
assert.equal(packageUrl.searchParams.get('connectionRef'), connectionRef); assert.equal(packageUrl.searchParams.get('sharedOAuth'), 'cancelled');
const advanced = new URL(sharedConnectionOAuthReturnHref(createSharedConnectionOAuthReturn(resource, actor, 'en')), 'https://canvas.invalid');
assert.equal(advanced.searchParams.get('view'), 'advanced'); assert.equal(advanced.searchParams.get('teamId'), 'actual-owner-team');
for (const path of ['//foreign.invalid/plugins', '/de/settings?view=browse', '/en/plugins?view=browse', '/de/plugins?view=browse#secret',
  '/de/plugins?view=browse&accountId=private', '/de/plugins?view=browse&profileId=private', '/de/plugins?view=browse&q=first&q=second',
  '/de/plugins?view=browse&workspaceId=foreign', '/de/plugins?view=browse&resourceRef=' + resourceRef]) {
  assert.throws(() => createSharedConnectionOAuthReturn(resource, actor, 'de', path), {code: 'CONNECTION_OAUTH_RETURN_INVALID'});
}
for (const id of ['composio:slack', 'mcp-personal:other', 'opaque-account']) {
  assert.throws(() => createSharedConnectionOAuthReturn(resource, actor, 'de', '/de/plugins?view=browse&extensionId=' + id), {code: 'CONNECTION_OAUTH_RETURN_CHANGED'});
}
assert.throws(() => validateSharedConnectionOAuthReturn({...context, workspaceId: 'foreign'}, resource, actor), {code: 'CONNECTION_OAUTH_RETURN_CHANGED'});
assert.throws(() => validateSharedConnectionOAuthReturn(context, {...resource, application: 'slack'}, actor), {code: 'CONNECTION_OAUTH_RETURN_CHANGED'});
const mcp = {...resource, source: 'mcp' as const, application: null};
const mcpContext = createSharedConnectionOAuthReturn(mcp, actor, 'de', `/de/plugins?view=browse&scope=all&extensionId=${connectionRef}`);
assert.equal(mcpContext.catalog?.extensionId, connectionRef);
assert.throws(() => createSharedConnectionOAuthReturn(mcp, actor, 'de', '/de/plugins?view=browse&extensionId=composio:canva'), {code: 'CONNECTION_OAUTH_RETURN_CHANGED'});
assert(!JSON.stringify(context).includes('profileId')); assert(!JSON.stringify(context).includes('accountId'));
console.log('Plugin catalog shared OAuth returns PASS: exact entry, package resume, filters, owner/actor separation, private IDs rejected, cancellation and legacy advanced compatibility.');
