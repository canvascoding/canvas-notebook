const baseUrl = process.env.BASE_URL || 'http://localhost:3002';

async function run() {
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });

  if (!loginResponse.ok) {
    throw new Error(`Login failed: ${loginResponse.status}`);
  }

  const cookie = loginResponse.headers.get('set-cookie');
  if (!cookie) {
    throw new Error('Missing session cookie');
  }

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

  console.log('Smoke test passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
