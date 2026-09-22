import assert from 'node:assert/strict';
import { invalidateFileReferenceValidationCache, validateFileReference } from '../app/lib/chat/validate-file-paths';
import { useWorkspaceStore } from '../app/store/workspace-store';

async function main() {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const responses: Array<(value: Response) => void> = [];
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Promise<Response>(resolve => responses.push(resolve));
  }) as typeof fetch;
  try {
    useWorkspaceStore.setState({ activeWorkspaceId: 'validation-race-a' });
    const first = validateFileReference('slow.md', []);
    const now = Date.now();
    Date.now = () => now + 60_000;
    const duplicate = validateFileReference('slow.md', []);
    assert.equal(requests.length, 1, 'slow pending request stays shared even after cache TTL');
    Date.now = originalNow;
    responses.shift()!(Response.json({ data: { exists: true, path: 'slow.md' } }));
    assert.equal((await first).type, 'file');
    assert.deepEqual(await duplicate, await first);

    const stale = validateFileReference('changed.md', []);
    invalidateFileReferenceValidationCache({ workspaceId: 'validation-race-a', path: 'changed.md' });
    const fresh = validateFileReference('changed.md', []);
    const oldResponse = responses.shift()!;
    responses.shift()!(Response.json({ data: { exists: true, path: 'changed.md' } }));
    assert.equal((await fresh).type, 'file');
    oldResponse(Response.json({ data: { exists: false } }));
    assert.equal((await stale).type, 'file', 'late missing result cannot overwrite a new file result');
    assert.equal((await validateFileReference('changed.md', [])).type, 'file');

    useWorkspaceStore.setState({ activeWorkspaceId: 'validation-race-b' });
    const scoped = validateFileReference('scoped.md', [], { workspaceId: 'validation-race-a' });
    assert.match(requests.at(-1)!, /workspaceId=validation-race-a/);
    responses.shift()!(Response.json({ data: { exists: true } }));
    assert.equal((await scoped).type, 'file');

    for (const response of [new Response(null, { status: 503 }), new Response(null, { status: 403 }), Response.json({ nope: true }), Response.json({ data: { exists: true, path: 'wrong.md' } })]) {
      const file: string = `unavailable-${requests.length}.md`;
      const pending = validateFileReference(file, []);
      responses.shift()!(response);
      assert.equal((await pending).type, 'unavailable', 'transport/permission/malformed responses are not missing files');
      const count: number = requests.length;
      assert.equal((await validateFileReference(file, [])).type, 'unavailable');
      assert.equal(requests.length, count);
    }
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal((await validateFileReference('offline.md', [])).type, 'unavailable');
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    useWorkspaceStore.setState({ activeWorkspaceId: originalWorkspaceId });
  }
  console.log('chat-file-validation-races-test: ok');
}
void main();
