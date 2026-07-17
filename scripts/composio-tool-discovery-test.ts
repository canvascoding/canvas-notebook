import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  inferConnectedComposioToolkits,
  normalizeComposioToolkits,
  selectComposioToolSearchResults,
  type ComposioToolSummary,
} from '../app/lib/composio/composio-tool-discovery';

async function main() {
  assert.deepEqual(normalizeComposioToolkits([' Instagram ', 'instagram', 'GMAIL']), ['instagram', 'gmail']);
  assert.deepEqual(inferConnectedComposioToolkits('Kannst du den aktuellen Instagram Post lesen?', [
    { status: 'ACTIVE', toolkit: { slug: 'instagram', name: 'Instagram' } },
    { status: 'ACTIVE', toolkit: { slug: 'gmail', name: 'Gmail' } },
  ]), ['instagram']);
  assert.deepEqual(inferConnectedComposioToolkits('Ich habe Insta verbunden', [
    { status: 'ACTIVE', toolkit: { slug: 'instagram', name: 'Instagram' } },
  ]), ['instagram']);

  const tools: ComposioToolSummary[] = [
    { slug: 'INSTAGRAM_GET_IG_USER_MEDIA', name: 'Get user media', description: 'Gets media objects for an Instagram user.', toolkit: 'instagram' },
    { slug: 'INSTAGRAM_GET_IG_MEDIA', name: 'Get media', description: 'Gets one Instagram media object.', toolkit: 'instagram' },
    { slug: 'INSTAGRAM_POST_IG_USER_MEDIA', name: 'Create media container', description: 'Creates a media container for an Instagram post.', toolkit: 'instagram' },
    { slug: 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', name: 'Publish media', description: 'Publishes a prepared Instagram media container.', toolkit: 'instagram' },
  ];

  const readResult = selectComposioToolSearchResults(tools, 'instagram read get media', ['instagram']);
  assert.equal(readResult.fallback, false);
  assert.ok(readResult.tools.some((tool) => tool.slug === 'INSTAGRAM_GET_IG_USER_MEDIA'));

  const publishResult = selectComposioToolSearchResults(tools, 'instagram create publish post', ['instagram']);
  assert.equal(publishResult.fallback, false);
  assert.ok(publishResult.tools.some((tool) => tool.slug === 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH'));

  const fallbackResult = selectComposioToolSearchResults(tools, 'instagram completely unrelated wording', ['instagram']);
  assert.equal(fallbackResult.fallback, true);
  assert.equal(fallbackResult.totalCount, tools.length);
  assert.equal(fallbackResult.tools.length, tools.length);

  const [gatewaySource, toolSource, promptSource] = await Promise.all([
    readFile('app/lib/composio/composio-gateway.ts', 'utf8'),
    readFile('app/lib/composio/composio-tools.ts', 'utf8'),
    readFile('app/lib/agents/system-prompt.ts', 'utf8'),
  ]);
  assert.match(gatewaySource, /getGatewayToolkitTools\(toolkit, '', context\)/u);
  assert.match(gatewaySource, /inferConnectedComposioToolkits/u);
  assert.match(toolSource, /Omit query to list that toolkit catalog/u);
  assert.match(promptSource, /Never conclude that a connected app lacks read or write operations/u);

  console.log('composio-tool-discovery-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
