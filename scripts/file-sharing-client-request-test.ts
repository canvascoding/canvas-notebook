import assert from 'node:assert/strict';
import { createScopedShareRequester } from '../app/lib/public-sharing/client-request';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';

async function main() {
  let activeWorkspace = 'original';
  let mounted = true;
  let calls = 0;
  let resolveBody!: (value: object) => void;
  const controllers = new Set<AbortController>();
  const requester = createScopedShareRequester({ workspaceId: 'original', controllers,
    isCurrent: () => mounted && activeWorkspace === 'original',
    fetcher: async (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get(WORKSPACE_ID_HEADER), 'original');
      assert.equal(init?.credentials, 'include');
      assert.equal(init?.cache, 'no-store');
      if (init?.method === 'PATCH') assert.equal(JSON.parse(String(init.body)).policyRevision, 4);
      // Deliberately ignore AbortSignal: the body can have arrived before cleanup.
      return { ok: true, json: () => new Promise<object>((resolve) => { resolveBody = resolve; }) } as Response;
    },
  });
  const mutation = requester('/api/security/public-shares/link', { method: 'PATCH', body: { policyRevision: 4, expiresAt: null } });
  await Promise.resolve(); activeWorkspace = 'next'; resolveBody({ success: true });
  await assert.rejects(mutation, { name: 'AbortError' });
  assert.equal(controllers.size, 0);
  await assert.rejects(requester('/api/security/public-shares'), { name: 'AbortError' });
  assert.equal(calls, 1, 'A stale handler must not even send a request to its former workspace.');

  activeWorkspace = 'original';
  const unmounted = requester('/api/security/file-guests');
  await Promise.resolve(); mounted = false; resolveBody({ success: true });
  await assert.rejects(unmounted, { name: 'AbortError' });
  mounted = true;
  const cancelled = requester('/api/security/file-guests');
  await Promise.resolve(); controllers.forEach((controller) => controller.abort()); resolveBody({ success: true });
  await assert.rejects(cancelled, { name: 'AbortError' });
  const success = requester<{ invitations: string[] }>('/api/security/file-guests');
  await Promise.resolve(); resolveBody({ success: true, invitations: ['current'] });
  assert.deepEqual((await success).invitations, ['current']);
  assert.equal(controllers.size, 0);
  const rejected = createScopedShareRequester({ workspaceId: 'original', controllers, isCurrent: () => true,
    fetcher: async () => new Response(JSON.stringify({ success: false, error: 'Settings changed. Reload.' }), { status: 409 }) });
  await assert.rejects(rejected('/api/security/file-guests/id', { method: 'PATCH', body: { policyRevision: 1 } }), /Settings changed/);
  console.log('file-sharing-client-request-test: fixed workspace, stale bodies, unmount, abort and policy conflicts ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
