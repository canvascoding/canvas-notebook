const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const loginEmail = process.env.TEST_LOGIN_EMAIL;
const loginPassword = process.env.TEST_LOGIN_PASSWORD;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  return { response, body };
}

function getCookieHeader(response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);

  if (!setCookies.length) {
    return '';
  }

  return setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

async function signIn(email = loginEmail, password = loginPassword) {
  if (!email || !password) {
    throw new Error('Missing TEST_LOGIN_EMAIL or TEST_LOGIN_PASSWORD');
  }

  const login = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
    },
    body: JSON.stringify({
      email,
      password,
    }),
  });

  if (!login.response.ok) {
    throw new Error(`Login failed: ${login.response.status}`);
  }

  const cookie = getCookieHeader(login.response);
  if (!cookie) {
    throw new Error('Missing auth cookies');
  }

  return cookie;
}

async function run() {
  const cookie = await signIn();
  const workspaceListing = await request('/api/workspaces', { headers: { cookie } });
  const workspaceName = process.env.TEST_WORKSPACE_NAME?.trim();
  const workspace = workspaceName
    ? workspaceListing.body?.workspaces?.find((candidate) => candidate.name === workspaceName)
    : workspaceListing.body?.defaultWorkspace;
  if (!workspaceListing.response.ok || !workspace?.id) {
    throw new Error(`Workspace resolution failed: ${workspaceListing.response.status}`);
  }
  const workspaceHeaders = { cookie, 'x-canvas-workspace-id': workspace.id };

  const testId = Date.now();
  const initialPath = `codex-integration-${testId}.json`;
  const renamedPath = `codex-integration-${testId}-renamed.json`;
  const copyDirectory = `codex-integration-${testId}-copies`;
  const copiedPath = `${copyDirectory}/${renamedPath}`;

  const create = await request('/api/files/create', {
    method: 'POST',
    headers: { ...workspaceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: initialPath, type: 'file' }),
  });

  if (!create.response.ok) {
    throw new Error(`Create failed: ${create.response.status}`);
  }

  const initialRead = await request(`/api/files/read?path=${encodeURIComponent(initialPath)}`, {
    headers: workspaceHeaders,
  });
  const initialRevisionId = initialRead.body?.data?.revision?.id;
  const initialSha256 = initialRead.body?.data?.stats?.sha256;
  if (!initialRead.response.ok || !initialRevisionId || !initialSha256) {
    throw new Error('Initial revision read failed');
  }

  const write = await request('/api/files/write', {
    method: 'POST',
    headers: { ...workspaceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: initialPath,
      content: 'integration test',
      expectedSha256: initialSha256,
      baseRevisionId: initialRevisionId,
    }),
  });

  if (!write.response.ok) {
    throw new Error(`Write failed: ${write.response.status} ${JSON.stringify(write.body)}`);
  }

  const read = await request(`/api/files/read?path=${encodeURIComponent(initialPath)}`, {
    headers: workspaceHeaders,
  });

  if (!read.response.ok || read.body?.data?.content !== 'integration test') {
    throw new Error('Read failed or content mismatch');
  }

  if (process.env.TEST_WRITE_ONLY === 'true') {
    const cleanupCookie = await signIn(
      process.env.TEST_CLEANUP_EMAIL,
      process.env.TEST_CLEANUP_PASSWORD,
    );
    const cleanup = await request('/api/files/delete', {
      method: 'DELETE',
      headers: {
        cookie: cleanupCookie,
        'x-canvas-workspace-id': workspace.id,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: initialPath }),
    });
    if (!cleanup.response.ok || cleanup.body?.failed?.length > 0) {
      throw new Error(`Write-only cleanup failed: ${cleanup.response.status}`);
    }
    console.log('Integration write test passed');
    return;
  }

  const rename = await request('/api/files/rename', {
    method: 'POST',
    headers: { ...workspaceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath: initialPath, newPath: renamedPath }),
  });

  if (!rename.response.ok) {
    throw new Error(`Rename failed: ${rename.response.status}`);
  }

  const createCopyDirectory = await request('/api/files/create', {
    method: 'POST',
    headers: { ...workspaceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: copyDirectory, type: 'directory' }),
  });
  if (!createCopyDirectory.response.ok) {
    throw new Error(`Copy directory create failed: ${createCopyDirectory.response.status}`);
  }

  const copy = await request('/api/files/copy', {
    method: 'POST',
    headers: { ...workspaceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources: [renamedPath], destDir: copyDirectory }),
  });
  if (!copy.response.ok || !copy.body?.copied?.includes(copiedPath)) {
    throw new Error(`Copy failed: ${copy.response.status}`);
  }

  const remove = await request('/api/files/delete', {
    method: 'DELETE',
    headers: { ...workspaceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: renamedPath }),
  });

  if (!remove.response.ok) {
    throw new Error(`Delete failed: ${remove.response.status}`);
  }

  const trashEntryId = remove.body?.trashEntries?.[0]?.id;
  if (!trashEntryId) {
    throw new Error(`Delete returned no trash entry: ${JSON.stringify(remove.body)}`);
  }

  const restore = await request(`/api/files/trash/${encodeURIComponent(trashEntryId)}/restore`, {
    method: 'POST',
    headers: { ...workspaceHeaders, 'Content-Type': 'application/json' },
  });
  if (!restore.response.ok || restore.body?.restored?.originalPath !== renamedPath) {
    throw new Error(`Restore failed: ${restore.response.status}`);
  }

  const restoredRead = await request(`/api/files/read?path=${encodeURIComponent(renamedPath)}`, {
    headers: workspaceHeaders,
  });
  if (!restoredRead.response.ok || restoredRead.body?.data?.content !== 'integration test') {
    throw new Error('Restored content mismatch');
  }

  for (const path of [renamedPath, copyDirectory]) {
    const cleanup = await request('/api/files/delete', {
      method: 'DELETE',
      headers: { ...workspaceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!cleanup.response.ok) {
      throw new Error(`Cleanup failed for ${path}: ${cleanup.response.status}`);
    }
  }

  console.log('Integration test passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
