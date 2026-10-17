import assert from 'node:assert/strict';
import Module from 'node:module';
import {createSharedConnectionOAuthReturn, sharedConnectionOAuthReturnHref} from '../app/lib/integration-tools/connections/oauth-return';
import type {IntegrationConnectionResource} from '../app/lib/integration-tools/connections/contracts';

/** Routing-only unit; provider/SQL authority is separately checked by native/API/E2E suites. */
async function main() {
  const loader = Module as typeof Module & {_load: (name: string, parent: NodeModule | null, main: boolean) => unknown}, original = loader._load;
  const resource: IntegrationConnectionResource = {connectionRef: 'canvas-connection:11111111-1111-4111-8111-111111111111', source: 'composio', ownership: {type: 'organization', organizationId: 'org'},
    displayName: 'Canva', description: null, application: 'canva', responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
    metadataRevision: 1, grantsRevision: 1, bindingRevision: 1, allowedToolNames: null, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1};
  const actor = {userId: 'routing-fixture-actor', workspaceId: 'workspace'}, authorization = {resource, actor};
  loader._load = (name, parent, isMain) => name === 'server-only' ? {} : name === '@/app/lib/db' ? {}
    : name === '@/app/lib/integration-tools/connections/store' ? {isAuthorizedIntegrationConnection: (value: unknown) => value === authorization} : original(name, parent, isMain);
  try {
    const {resolveSharedComposioOAuthReturnPath} = await import('../app/lib/composio/composio-shared-oauth-state');
    type Context = Parameters<typeof resolveSharedComposioOAuthReturnPath>[0];
    const context = {sharedBinding: {authorization}} as unknown as Context;
    const catalog = '/de/plugins?view=browse&scope=all&q=canva&extensionId=composio:canva';
    const issued = resolveSharedComposioOAuthReturnPath(context, {returnLocale: 'de', catalogReturnPath: catalog});
    assert.equal(issued, sharedConnectionOAuthReturnHref(createSharedConnectionOAuthReturn(resource, actor, 'de', catalog), 'connected'));
    assert.equal(resolveSharedComposioOAuthReturnPath(context, {returnPath: issued}), issued, 'the callback accepts its exact issued catalog path after persisted flow read');
    const packageRef = 'canvas-resource:22222222-2222-4222-8222-222222222222';
    const packagePath = resolveSharedComposioOAuthReturnPath(context, {returnLocale: 'en', catalogReturnPath: `/en/plugins?view=browse&resourceRef=${packageRef}&task=connections&q=workflow`});
    assert.equal(resolveSharedComposioOAuthReturnPath(context, {returnPath: packagePath}), packagePath, 'installed requirement setup resumes after consent/cancellation');
    assert.throws(() => resolveSharedComposioOAuthReturnPath(context, {catalogReturnPath: catalog}), {code: 'CONNECTION_OAUTH_RETURN_INVALID'});
    assert.throws(() => resolveSharedComposioOAuthReturnPath(context, {returnPath: issued.replace('composio%3Acanva', 'composio%3Aslack')}), {code: 'CONNECTION_OAUTH_RETURN_CHANGED'});
    const privateParam = issued + '&profileId=private';
    assert.throws(() => resolveSharedComposioOAuthReturnPath(context, {returnPath: privateParam}), {code: 'CONNECTION_OAUTH_RETURN_INVALID'});
    console.log('Shared Composio issued catalog callback path PASS: exact standalone/package return, private fields and mismatched applications rejected.');
  } finally { loader._load = original; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
