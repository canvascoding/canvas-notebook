import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const loginEmail = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const loginPassword = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;

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

  return setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

async function signIn() {
  if (!loginEmail || !loginPassword) {
    throw new Error('Missing TEST_LOGIN_EMAIL/BOOTSTRAP_ADMIN_EMAIL or TEST_LOGIN_PASSWORD/BOOTSTRAP_ADMIN_PASSWORD');
  }

  const login = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
    },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
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
  const unique = Date.now();
  const testPath = `todo-api-${unique}.md`;

  const createFile = await request('/api/files/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ path: testPath, type: 'file' }),
  });
  if (!createFile.response.ok) {
    throw new Error(`File create failed: ${createFile.response.status}`);
  }

  const categories = await request('/api/todo-categories', { headers: { cookie } });
  if (!categories.response.ok || !Array.isArray(categories.body?.data) || categories.body.data.length < 7) {
    throw new Error('Category seed/list failed');
  }

  const customCategory = await request('/api/todo-categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: `API Test ${unique}`, color: '#123456', icon: 'check' }),
  });
  if (customCategory.response.status !== 201 || !customCategory.body?.data?.id) {
    throw new Error(`Category create failed: ${customCategory.response.status}`);
  }

  const invalidPath = await request('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Invalid path', fileLinks: ['../secret.txt'] }),
  });
  if (invalidPath.response.status !== 400) {
    throw new Error(`Invalid path should fail with 400, got ${invalidPath.response.status}`);
  }

  const created = await request('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      title: `Todo API Test ${unique}`,
      description: 'Created by todo-api-test',
      categoryId: customCategory.body.data.id,
      priority: 'high',
      fileLinks: [{ workspacePath: testPath, label: 'Test file' }],
    }),
  });
  if (created.response.status !== 201 || !created.body?.data?.id) {
    throw new Error(`Todo create failed: ${created.response.status}`);
  }
  if (created.body.data.fileLinks?.[0]?.workspacePath !== testPath) {
    throw new Error('Todo file link mismatch');
  }

  const todoId = created.body.data.id;
  const listed = await request('/api/todos?status=active', { headers: { cookie } });
  if (!listed.response.ok || !listed.body?.data?.some((todo) => todo.id === todoId)) {
    throw new Error('Todo list did not include created todo');
  }

  const patched = await request(`/api/todos/${encodeURIComponent(todoId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ markSeen: true, status: 'done' }),
  });
  if (!patched.response.ok || patched.body?.data?.status !== 'done' || !patched.body?.data?.seenAt) {
    throw new Error(`Todo patch failed: ${patched.response.status}`);
  }

  const deleted = await request(`/api/todos/${encodeURIComponent(todoId)}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  if (!deleted.response.ok || deleted.body?.data?.status !== 'archived') {
    throw new Error(`Todo archive failed: ${deleted.response.status}`);
  }

  const archived = await request('/api/todos?status=archived', { headers: { cookie } });
  if (!archived.response.ok || !archived.body?.data?.some((todo) => todo.id === todoId)) {
    throw new Error('Archived todo was not listed');
  }

  const deleteCategory = await request(`/api/todo-categories/${encodeURIComponent(customCategory.body.data.id)}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  if (!deleteCategory.response.ok || deleteCategory.body?.data?.isArchived !== true) {
    throw new Error(`Category archive failed: ${deleteCategory.response.status}`);
  }

  await request('/api/files/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ path: testPath }),
  });

  console.log('Todo API test passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
