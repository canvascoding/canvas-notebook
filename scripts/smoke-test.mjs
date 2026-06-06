const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const loginEmail = process.env.TEST_LOGIN_EMAIL;
const loginPassword = process.env.TEST_LOGIN_PASSWORD;

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

  const loginResponse = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
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

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    throw new Error(`Login failed: ${loginResponse.status} ${text}`);
  }

  const cookie = getCookieHeader(loginResponse);
  if (!cookie) {
    throw new Error('Missing auth cookies');
  }

  return cookie;
}

async function assertUserProvisioningIsAdminOnly() {
  const signUpResponse = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
    },
    body: JSON.stringify({
      name: 'Public Sign Up',
      email: 'public-sign-up@example.test',
      password: 'NotAllowed123!',
    }),
  });

  if (signUpResponse.status !== 403) {
    throw new Error(`Public sign-up was not blocked: ${signUpResponse.status}`);
  }

  const adminCreateResponse = await fetch(`${baseUrl}/api/auth/admin/create-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
    },
    body: JSON.stringify({
      name: 'Unauthenticated Admin Create',
      email: 'unauthenticated-admin-create@example.test',
      password: 'NotAllowed123!',
      role: 'user',
    }),
  });

  if (adminCreateResponse.status !== 401 && adminCreateResponse.status !== 403) {
    throw new Error(`Unauthenticated admin user creation was not blocked: ${adminCreateResponse.status}`);
  }
}

async function assertAdminUserManagement(cookie) {
  const usersResponse = await fetch(`${baseUrl}/api/auth/admin/list-users?limit=5&offset=0`, {
    headers: {
      cookie,
      Origin: baseUrl,
    },
  });

  if (!usersResponse.ok) {
    throw new Error(`Admin user list failed: ${usersResponse.status}`);
  }

  const usersJson = await usersResponse.json();
  if (!Array.isArray(usersJson.users) || typeof usersJson.total !== 'number') {
    throw new Error('Admin user list response not successful');
  }
}

async function run() {
  await assertUserProvisioningIsAdminOnly();
  const cookie = await signIn();

  const treeResponse = await fetch(`${baseUrl}/api/files/tree?path=.&depth=1`, {
    headers: { cookie },
  });

  if (!treeResponse.ok) {
    throw new Error(`File tree failed: ${treeResponse.status}`);
  }

  const treeJson = await treeResponse.json();
  if (!treeJson.success) {
    throw new Error('File tree response not successful');
  }

  await assertAdminUserManagement(cookie);

  console.log('Smoke test passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
