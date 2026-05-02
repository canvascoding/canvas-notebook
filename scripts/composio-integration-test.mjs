const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const loginEmail = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const loginPassword = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;

function getCookieHeader(response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);

  if (!setCookies.length) return '';
  return setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

async function signIn() {
  if (!loginEmail || !loginPassword) {
    throw new Error('Missing TEST_LOGIN_EMAIL/BOOTSTRAP_ADMIN_EMAIL or TEST_LOGIN_PASSWORD/BOOTSTRAP_ADMIN_PASSWORD');
  }

  const loginResponse = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
  });

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    throw new Error(`Login failed: ${loginResponse.status} ${text}`);
  }

  const cookie = getCookieHeader(loginResponse);
  if (!cookie) throw new Error('Missing auth cookies');
  return cookie;
}

async function apiCall(cookie, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...options.headers, cookie },
    credentials: 'include',
  });
  const body = await response.json();
  return { response, body };
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`  FAIL: ${message}`);
    return false;
  }
  passed++;
  console.log(`  PASS: ${message}`);
  return true;
}

async function run() {
  console.log('Composio Integration Test');
  console.log('=========================\n');

  console.log('1. Signing in...');
  const cookie = await signIn();
  assert(cookie, 'Login successful');

  // Test 1: GET /api/composio/status (may or may not have API key configured)
  console.log('\n2. Testing GET /api/composio/status');
  const { body: statusBody } = await apiCall(cookie, '/api/composio/status');
  assert(typeof statusBody.configured === 'boolean', 'Status returns configured boolean');
  assert(typeof statusBody.apiKeyValid === 'boolean', 'Status returns apiKeyValid boolean');
  assert(Array.isArray(statusBody.connectedAccounts), 'Status returns connectedAccounts array');

  if (statusBody.configured && statusBody.apiKeyValid) {
    console.log('   Composio API key is configured and valid — running full test suite');

    // Test 2: GET /api/composio/toolkits
    console.log('\n3. Testing GET /api/composio/toolkits');
    const { body: toolkitsBody } = await apiCall(cookie, '/api/composio/toolkits');
    assert(Array.isArray(toolkitsBody.toolkits), 'Toolkits returns array');
    if (toolkitsBody.toolkits.length > 0) {
      const firstToolkit = toolkitsBody.toolkits[0];
      assert(typeof firstToolkit.slug === 'string', 'Toolkit has slug');
      assert(typeof firstToolkit.name === 'string', 'Toolkit has name');
      assert(typeof firstToolkit.connected === 'boolean', 'Toolkit has connected status');
    }

    // Test 3: Connect flow — pick an unconnected toolkit
    const unconnected = toolkitsBody.toolkits.find((tk) => !tk.connected && !tk.isNoAuth);
    if (unconnected) {
      console.log(`\n4. Testing POST /api/composio/connect/${unconnected.slug}`);
      const { body: connectBody, response: connectResponse } = await apiCall(
        cookie,
        `/api/composio/connect/${unconnected.slug}`,
        { method: 'POST' }
      );
      assert(connectResponse.ok, `Connect endpoint returned ${connectResponse.status}`);
      if (connectBody.redirectUrl) {
        assert(
          connectBody.redirectUrl.startsWith('http'),
          'Connect returns valid redirect URL'
        );
        console.log(`   Redirect URL: ${connectBody.redirectUrl.slice(0, 80)}...`);
      }
    } else {
      console.log('\n4. Skipping connect test — no unconnected toolkits available');
    }

    // Test 4: If there are connected accounts, test disconnect/refresh
    if (statusBody.connectedAccounts.length > 0) {
      const firstAccount = statusBody.connectedAccounts[0];
      const toolkitSlug = firstAccount.toolkit?.slug;

      if (toolkitSlug) {
        console.log(`\n5. Testing POST /api/composio/refresh/${toolkitSlug}`);
        const { response: refreshResponse } = await apiCall(
          cookie,
          `/api/composio/refresh/${toolkitSlug}`,
          { method: 'POST' }
        );
        assert(refreshResponse.ok, `Refresh endpoint returned ${refreshResponse.status}`);

        // Note: we do NOT test disconnect in automated test to avoid disrupting user connections
        console.log('\n6. Skipping disconnect test to preserve connected accounts');
      }
    } else {
      console.log('\n5. Skipping refresh/disconnect test — no connected accounts');
    }
  } else {
    console.log('   Composio API key is NOT configured — testing unconfigured responses only');

    // When not configured, status should indicate that
    assert(statusBody.configured === false || statusBody.apiKeyValid === false, 'Status correctly reports unconfigured state');

    // Toolkits should return empty or error when not configured
    console.log('\n3. Testing GET /api/composio/toolkits (unconfigured)');
    const { body: toolkitsBody } = await apiCall(cookie, '/api/composio/toolkits');
    assert(Array.isArray(toolkitsBody.toolkits) && toolkitsBody.toolkits.length === 0, 'Toolkits returns empty array when not configured');
  }

  // Test: Agent tools metadata includes Composio group
  console.log('\n7. Testing GET /api/agents/tools includes Composio metadata');
  const { body: toolsBody } = await apiCall(cookie, '/api/agents/tools');
  assert(toolsBody.success, 'Tools endpoint returned success');
  assert(Array.isArray(toolsBody.data.tools), 'Tools returns array');
  const composioTools = toolsBody.data.tools.filter((t) => t.group === 'Composio');
  if (composioTools.length > 0) {
    assert(composioTools.length === 4, `Found ${composioTools.length} Composio tools (expected 4)`);
    const toolNames = composioTools.map((t) => t.name).sort();
    assert(toolNames.includes('COMPOSIO_SEARCH_TOOLS'), 'COMPOSIO_SEARCH_TOOLS present');
    assert(toolNames.includes('composio_execute'), 'composio_execute present');
    assert(
      composioTools.every((t) => t.defaultEnabled === false),
      'All Composio tools are default-enabled: false'
    );
  } else {
    console.log('   No Composio tools in metadata (API key not configured, tools not registered)');
  }

  // Summary
  console.log('\n=========================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nSome tests FAILED!');
    process.exit(1);
  }
  console.log('\nAll tests PASSED!');
}

run().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});