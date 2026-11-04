import assert from 'node:assert/strict';
import { previewWorkspaceRename, renameWorkspacePath } from '../app/lib/files/client';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';

async function workspacePreviewBusyClientTest() {
  const originalFetch = globalThis.fetch;
  const signIn = (id: string) => observeOpenedDocumentAuth({ data: { user: { id }, session: { id: `session-${id}` } } });
  const busy = { error: 'Try the preview again', code: 'PATH_IMPORT_PREVIEW_BUSY' };
  const planId = 'a'.repeat(64);
  const ready = { dryRun: true, requiresRevalidation: true, plan: { planId, readiness: 'ready' } };
  let requests: Array<{ body: Record<string, unknown>; workspace: string | null }> = [];
  let replies: Array<() => Response | Promise<Response>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push({ body: JSON.parse(String(init?.body)), workspace: new Headers(init?.headers).get('x-canvas-workspace-id') });
    assert(replies.length, 'No unplanned retry or mutation request');
    return replies.shift()!();
  };
  const setup = (...responses: Array<() => Response | Promise<Response>>) => { signIn('preview-owner'); requests = []; replies = responses; };
  try {
    setup(() => Response.json(busy, { status: 409 }), () => Response.json(ready));
    assert.equal((await previewWorkspaceRename('a.txt', 'nested/b.txt', 'ws')).plan.planId, planId);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].workspace, 'ws');
    assert.deepEqual(requests[0].body, { oldPath: 'a.txt', newPath: 'nested/b.txt', dryRun: true });

    setup(...Array.from({ length: 3 }, () => () => Response.json(busy, { status: 409 })));
    await assert.rejects(previewWorkspaceRename('a.txt', 'b.txt', 'ws'), /Try the preview again/);
    assert.equal(requests.length, 3, 'Persistent contention has a fixed request budget');

    for (const response of [Response.json(busy, { status: 500 }), Response.json({ ...busy, code: 'PREVIEW_STALE' }, { status: 409 }),
      Response.json({ ...busy, code: 'PRINCIPAL_ACCESS_DENIED' }, { status: 403 }), new Response('not JSON', { status: 409 })]) {
      setup(() => response);
      await assert.rejects(previewWorkspaceRename('a.txt', 'b.txt', 'ws'));
      assert.equal(requests.length, 1, 'Only the specific clean preview contention is retried');
    }
    setup(async () => { throw new Error('connection lost'); });
    await assert.rejects(previewWorkspaceRename('a.txt', 'b.txt', 'ws'), /connection lost/);
    assert.equal(requests.length, 1);

    setup(() => { signIn('different-user'); return Response.json(busy, { status: 409 }); });
    await assert.rejects(previewWorkspaceRename('a.txt', 'b.txt', 'ws'), /signed-in session changed/);
    assert.equal(requests.length, 1, 'A retry cannot cross the original authentication observation');

    setup(() => Response.json(busy, { status: 409 }));
    await assert.rejects(renameWorkspacePath('a.txt', 'b.txt', false, 'ws', planId));
    assert.equal(requests.length, 1, 'An apply with the same busy-shaped response is never replayed');
    assert.notEqual(requests[0].body.dryRun, true);
    console.log('Workspace preview busy client: bounded dry-run retries, auth change and no write replay passed');
  } finally { globalThis.fetch = originalFetch; observeOpenedDocumentAuth({ data: null }); }
}
void workspacePreviewBusyClientTest().catch(error => { console.error(error); process.exitCode = 1; });
