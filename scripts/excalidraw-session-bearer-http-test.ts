import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Scene = { documentId: string; path: string; sceneSequence: number; lifecycleGeneration: number;
  elements: Array<Record<string, unknown>>; checkpoint: { status: string } };

async function main() {
  assert.equal(process.env.EXCALIDRAW_SCENE_E2E, '1', 'Use the private managed PostgreSQL E2E wrapper.');
  const origin = process.env.BASE_URL!;
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
  const email = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL!;
  const password = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD!;
  const credentialHash = createHash('sha256').update(password).digest('hex');
  const cacheId = createHash('sha256').update(`${origin}\0${email}\0${credentialHash}`).digest('hex').slice(0, 24);
  const cache = JSON.parse(await fs.readFile(path.join(os.tmpdir(), 'canvas-playwright-auth', `${cacheId}.json`), 'utf8')) as {
    cookies: Array<{ name: string; value: string }> };
  const cleanupCookie = cache.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const request = (url: string, options: RequestInit = {}) => fetch(new URL(url, origin), {
    ...options, headers: { 'Content-Type': 'application/json', Origin: origin, ...options.headers },
  });
  const cached = await request('/api/auth/get-session', { headers: { Cookie: cleanupCookie } });
  assert.equal(cached.status, 200);
  const cachedSession = await cached.json();
  assert.ok(cachedSession?.session?.id, 'The existing private browser session must be authenticated.');
  // A separate genuine sign-in session can be revoked without invalidating the
  // browser's cached session. Credentials and tokens remain only in memory.
  const signin = await request('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }) });
  assert.equal(signin.status, 200, 'The separate test session must authenticate.');
  const cookie = signin.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  const signed = signin.headers.get('set-auth-token');
  assert.ok(cookie && signed, 'Better Auth must return its session cookie and signed bearer header.');
  const authenticated = await request('/api/auth/get-session', { headers: { Cookie: cookie } });
  const session = await authenticated.json();
  assert.ok(session?.session?.token && session.session.id !== cachedSession.session.id);
  const raw = session.session.token as string;
  const credentials = [{ name: 'cookie', headers: { Cookie: cookie } },
    { name: 'rawSessionBearer', headers: { Authorization: `Bearer ${raw}` } },
    { name: 'signedSessionBearer', headers: { Authorization: `Bearer ${signed}` } }];
  const suffix = randomUUID();
  const files: string[] = [];
  let workspaceId: string | undefined;
  let latest: Scene | undefined;
  try {
    const workspace = await request('/api/workspaces', { method: 'POST', headers: { Cookie: cleanupCookie },
      body: JSON.stringify({ type: 'personal', name: `Session bearer HTTP ${suffix}` }) });
    assert.equal(workspace.status, 201);
    workspaceId = (await workspace.json()).workspace.id;
    assert.ok(workspaceId);
    for (const credential of credentials) {
      const headers = { ...credential.headers, 'x-canvas-workspace-id': workspaceId };
      const verified = await request('/api/auth/get-session', { headers: credential.headers });
      assert.equal(verified.status, 200);
      assert.equal((await verified.json())?.session?.id, session.session.id);
      const filename = `${credential.name}-${suffix}.excalidraw`;
      const create = await request('/api/excalidraw/scenes', { method: 'POST', headers,
        body: JSON.stringify({ workspaceId, path: filename, idempotencyKey: `http-${credential.name}-${suffix}` }) });
      assert.equal(create.status, 201, `${credential.name} Create must authenticate through the actual HTTP route.`);
      const initial = (await create.json()).document as Scene;
      files.push(filename);
      const url = `/api/excalidraw/scenes/${initial.documentId}`;
      const read = await request(url, { headers });
      assert.equal(read.status, 200, `${credential.name} Get must authenticate through the actual HTTP route.`);
      const scene = (await read.json()).document as Scene;
      assert.equal(scene.documentId, initial.documentId);
      const edit = await request(`${url}/operations`, { method: 'POST', headers,
        body: JSON.stringify({ workspaceId, documentId: scene.documentId, lifecycleGeneration: scene.lifecycleGeneration,
          observedSceneSequence: scene.sceneSequence, idempotencyKey: `edit-${credential.name}-${suffix}`, actions: [
            { type: 'create', element: { id: `shape-${credential.name}`, type: 'rectangle', version: 1, versionNonce: 29,
              isDeleted: false, x: 10, y: 20, width: 100, height: 80, angle: 0, opacity: 100,
              groupIds: [], boundElements: [] } },
          ] }) });
      assert.equal(edit.status, 200, `${credential.name} Edit must authenticate through the actual HTTP route.`);
      const operation = (await edit.json()).operation;
      assert.equal(operation.status, 'applied');
      assert.equal(operation.checkpoint.status, 'saved');
      latest = (await (await request(url, { headers })).json()).document as Scene;
      assert.equal(latest.elements.length, 1);
      assert.equal(latest.sceneSequence, initial.sceneSequence + 1);
    }
    assert.ok(latest);
    const url = `/api/excalidraw/scenes/${latest.documentId}`;
    const editBody = { workspaceId, documentId: latest.documentId, lifecycleGeneration: latest.lifecycleGeneration,
      observedSceneSequence: latest.sceneSequence, idempotencyKey: `denied-${suffix}`, actions: [
        { type: 'create', element: { id: 'denied', type: 'rectangle', version: 1, versionNonce: 1,
          isDeleted: false, x: 0, y: 0, width: 10, height: 10, opacity: 100, groupIds: [], boundElements: [] } },
      ] };
    for (const headers of [{}, { Authorization: `Bearer ${randomUUID().replaceAll('-', '')}` },
      { Authorization: `Bearer ${signed!.slice(0, -4)}bad!` }, { Authorization: `Bearer ${'a'.repeat(4097)}` }]) {
      assert.equal((await request(url, { headers: { ...headers, 'x-canvas-workspace-id': workspaceId } })).status, 401);
    }
    for (const [method, endpoint] of [['GET', '/api/excalidraw/scenes'], ['PUT', url],
      ['GET', `${url}/operations`], ['GET', '/api/files/read'], ['POST', '/api/excalidraw/scenes-other'],
      ['GET', `${url}/extra`]]) {
      assert.equal((await request(endpoint, { method, headers: { Authorization: `Bearer ${raw}`,
        'x-canvas-workspace-id': workspaceId } })).status, 401, 'Adjacent routes and unmatched methods retain their credential policy.');
    }
    assert.equal((await request(url, { headers: { Authorization: `Bearer ${raw}`,
      'x-canvas-workspace-id': `missing-${suffix}` } })).status, 404);
    const revoked = await request('/api/auth/revoke-session', { method: 'POST', headers: { Cookie: cleanupCookie },
      body: JSON.stringify({ token: raw }) });
    assert.equal(revoked.status, 200);
    for (const credential of credentials) {
      const headers = { ...credential.headers, 'x-canvas-workspace-id': workspaceId };
      assert.equal((await request(url, { headers })).status, 401, `${credential.name} revoked Get must fail.`);
      assert.equal((await request('/api/excalidraw/scenes', { method: 'POST', headers,
        body: JSON.stringify({ workspaceId, path: `revoked-${credential.name}.excalidraw`, idempotencyKey: randomUUID() }) })).status, 401);
      assert.equal((await request(`${url}/operations`, { method: 'POST', headers, body: JSON.stringify(editBody) })).status, 401);
    }
    console.log(JSON.stringify({ success: true, actualHttp: true, cookie: true, rawSessionBearer: true,
      signedSessionBearer: true, createGetEdit: true, invalidBearerRejected: true, revokedSessionRejected: true }));
  } finally {
    const revoked = await request('/api/auth/revoke-session', { method: 'POST', headers: { Cookie: cleanupCookie },
      body: JSON.stringify({ token: raw }) });
    assert.equal(revoked.status, 200, 'The separate private session must be cleaned up.');
    if (workspaceId) {
      for (const filename of files) {
        const removed = await request('/api/files/delete', { method: 'DELETE',
          headers: { Cookie: cleanupCookie, 'x-canvas-workspace-id': workspaceId }, body: JSON.stringify({ path: filename }) });
        assert.equal(removed.status, 200, 'The private test document must be cleaned up.');
      }
      const removed = await request(`/api/workspaces/${workspaceId}`, { method: 'DELETE', headers: { Cookie: cleanupCookie } });
      assert.equal(removed.status, 200, 'The private test workspace must be cleaned up.');
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
