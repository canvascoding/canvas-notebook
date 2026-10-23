import assert from 'node:assert/strict';
import { buildFileBrowserLocationHref } from '../app/lib/files/file-browser-location';

const href = buildFileBrowserLocationHref({
  search: 'workspaceId=team-a&view=tree', workspaceId: 'team-a', path: 'notes/ä & # [] ?.md',
});
assert(href);
const url = new URL(href, 'https://example.test');
assert.equal(url.pathname, '/files');
assert.equal(url.searchParams.get('path'), 'notes/ä & # [] ?.md');
assert.equal(url.searchParams.get('workspaceId'), 'team-a');
assert.equal(url.searchParams.get('view'), 'tree');
assert.equal(buildFileBrowserLocationHref({ search: url.search, workspaceId: 'team-a', path: null }),
  '/files?workspaceId=team-a&view=tree');
assert.equal(buildFileBrowserLocationHref({ search: '', workspaceId: 'team-a', path: 'notes/draft.md' }),
  '/files?workspaceId=team-a&path=notes%2Fdraft.md');
assert.equal(buildFileBrowserLocationHref({ search: 'workspaceId=other', workspaceId: 'team-a', path: 'same.md' }), null,
  'A late open cannot retarget an explicitly different workspace.');
assert.equal(buildFileBrowserLocationHref({ search: '', workspaceId: null, path: 'same.md' }), null);
for (const path of ['../other.md', 'notes/../other.md', '.', '', 'bad\0path.md']) {
  assert.equal(buildFileBrowserLocationHref({ search: '', workspaceId: 'team-a', path }), null);
}
console.log('File browser locations passed: encoded paths, explicit workspace, close, missing scope and stale-scope/traversal rejection.');
