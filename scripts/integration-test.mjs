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

async function signIn() {
  if (!loginEmail || !loginPassword) {
    throw new Error('Missing TEST_LOGIN_EMAIL or TEST_LOGIN_PASSWORD');
  }

  const login = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
    },
    body: JSON.stringify({
      email: loginEmail,
      password: loginPassword,
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
