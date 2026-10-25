import assert from 'node:assert/strict';
import { createBrowserFixtureUrl } from '../tests/helpers/browser-fixture-url';

async function main() {
  const access = 'synthetic-ticket';
  assert.equal(createBrowserFixtureUrl({ access, baseUrl: 'http://127.0.0.1:3100' }),
    'http://localhost:3100/api/browser/view/fixture-page?access=synthetic-ticket');
  assert.equal(createBrowserFixtureUrl({ access, baseUrl: 'http://127.0.0.1:3100', fixturePort: '3000', promptOnLoad: true }),
    'http://localhost:3000/api/browser/view/fixture-page?access=synthetic-ticket&promptOnLoad=1');
  for (const fixturePort of ['', '0', '65536', '-1', '3.1', '3000/path', ' 3000', '1e3']) {
    assert.throws(() => createBrowserFixtureUrl({ access, baseUrl: 'http://127.0.0.1:3100', fixturePort }), /TEST_BROWSER_FIXTURE_PORT/u);
  }
  for (const baseUrl of ['https://example.com', 'file:///tmp/foo', 'http://user:password@localhost:3100']) {
    assert.throws(() => createBrowserFixtureUrl({ access, baseUrl }), /plain loopback/u);
  }

  console.log('Browser fixture port contracts passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
