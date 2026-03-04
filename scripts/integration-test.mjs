const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  return { response, body };
}

async function run() {
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });

  if (!login.response.ok) {
    throw new Error(`Login failed: ${login.response.status}`);
  }

  const cookie = login.response.headers.get('set-cookie');
  if (!cookie) {
    throw new Error('Missing session cookie');
  }

  const testId = Date.now();
  const initialPath = `codex-integration-${testId}.txt`;
  const renamedPath = `codex-integration-${testId}-renamed.txt`;

  const create = await request('/api/files/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ path: initialPath, type: 'file' }),
  });

  if (!create.response.ok) {
    throw new Error(`Create failed: ${create.response.status}`);
  }

  const write = await request('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ path: initialPath, content: 'integration test' }),
  });

  if (!write.response.ok) {
    throw new Error(`Write failed: ${write.response.status}`);
  }

  const read = await request(`/api/files/read?path=${encodeURIComponent(initialPath)}`, {
    headers: { cookie },
  });

  if (!read.response.ok || read.body?.data?.content !== 'integration test') {
    throw new Error('Read failed or content mismatch');
  }

  const rename = await request('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ oldPath: initialPath, newPath: renamedPath }),
  });

  if (!rename.response.ok) {
    throw new Error(`Rename failed: ${rename.response.status}`);
  }

  const remove = await request('/api/files/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ path: renamedPath }),
  });

  if (!remove.response.ok) {
    throw new Error(`Delete failed: ${remove.response.status}`);
  }

  console.log('Integration test passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
