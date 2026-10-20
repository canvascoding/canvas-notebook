import assert from 'node:assert/strict';
import { pluginCatalogReturnPath, pluginIntegrationRequest, pluginSharedConnectionApi } from '../app/components/plugins/plugin-integration-client';

async function main() {
  const original = globalThis.fetch;
  const requests: Array<{path: string; headers: Headers; method: string}> = [], pending: boolean[] = [];
  const releases = new Map<string, () => void>();
  let actorCurrent = true, constructionReads = 0;
  globalThis.fetch = async (input, init) => {
    const path = String(input); requests.push({path, headers: new Headers(init?.headers), method: init?.method || 'GET'});
    await new Promise<void>(resolve => releases.set(path, resolve));
    return Response.json({success: true, data: {path}});
  };
  try {
    const api = pluginSharedConnectionApi('exact-workspace', () => { constructionReads++; return actorCurrent; }, value => pending.push(value));
    assert.equal(constructionReads, 0, 'constructing the request adapter does not evaluate actor/ref state during React render');
    const first = api('/api/integrations/shared-connections/first', {value: 1}), second = api('/api/integrations/shared-connections/second', {value: 2});
    assert.deepEqual(pending, [true, true]);
    assert(requests.every(value => value.headers.get('x-canvas-workspace-id') === 'exact-workspace' && value.method === 'POST'));
    releases.get(requests[0].path)!(); await first; assert.equal(pending.at(-1), true, 'the remaining real write keeps navigation blocked');
    releases.get(requests[1].path)!(); await second; assert.equal(pending.at(-1), false);
    const late = api('/api/integrations/shared-connections/late', {value: 3}); actorCurrent = false; releases.get(requests[2].path)!();
    await assert.rejects(() => late, {name: 'AbortError'}, 'an old actor acknowledgment cannot update the new session');
    const count = requests.length;
    for (const path of ['https://foreign.invalid/api', '//foreign.invalid/api', '/settings', '/api/../settings', '/api/\\foreign', '/api/\nprivate']) {
      await assert.rejects(() => pluginIntegrationRequest(path, 'exact-workspace'), {code: 'connection_path_invalid'});
    }
    assert.equal(requests.length, count, 'invalid paths never send credentialed HTTP requests');
    const resourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
    const result = pluginCatalogReturnPath('/en/plugins?view=browse&q=canva&kind=integration&stock=installed&scope=all&extensionCursor=old&accountId=private&profileId=private&extensionId=composio:canva', 'en', 'exact-workspace', {resourceRef});
    const url = new URL(result, 'https://canvas.invalid');
    assert.equal(url.searchParams.get('resourceRef'), resourceRef); assert.equal(url.searchParams.get('task'), 'connections');
    assert.equal(url.searchParams.get('q'), 'canva'); assert.equal(url.searchParams.get('workspaceId'), 'exact-workspace');
    for (const key of ['accountId', 'profileId', 'extensionCursor', 'extensionId']) assert.equal(url.searchParams.has(key), false);
    const standalone = new URL(pluginCatalogReturnPath('/de/plugins?q=canva&scope=all', 'de', 'exact-workspace', {extensionId: 'composio:canva'}), 'https://canvas.invalid');
    assert.equal(standalone.searchParams.get('extensionId'), 'composio:canva'); assert.equal(standalone.pathname, '/de/plugins');
    assert.throws(() => pluginCatalogReturnPath('//foreign.invalid/plugins', 'en', null, {extensionId: 'composio:canva'}));
    console.log('Plugin integration setup client PASS: exact workspace, overlapping writes, late actor, closed API paths and private-free exact OAuth return.');
  } finally { globalThis.fetch = original; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
