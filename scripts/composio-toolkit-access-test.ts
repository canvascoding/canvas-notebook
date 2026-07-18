import assert from 'node:assert/strict';

import { resolveComposioToolkitAccess } from '../app/lib/composio/composio-toolkit-access';

function main() {
  assert.deepEqual(
    resolveComposioToolkitAccess({ slug: 'composio_search', noAuth: true }),
    { noAuth: true, ready: true },
  );
  assert.deepEqual(
    resolveComposioToolkitAccess({ slug: 'composio_search', isNoAuth: true }),
    { noAuth: true, ready: true },
  );
  assert.deepEqual(
    resolveComposioToolkitAccess({ slug: 'composio_search', no_auth: true }),
    { noAuth: true, ready: true },
  );
  assert.deepEqual(
    resolveComposioToolkitAccess({ slug: 'gmail', noAuth: false }),
    { noAuth: false, ready: false },
  );
  assert.deepEqual(
    resolveComposioToolkitAccess({ slug: 'gmail', noAuth: false }, true),
    { noAuth: false, ready: true },
  );

  console.log('composio-toolkit-access-test: ok');
}

main();
