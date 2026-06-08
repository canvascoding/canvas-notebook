import assert from 'node:assert/strict';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { checkBrowserUrlPolicy } = await import('../app/lib/pi/browser/url-policy');

  const localhost = await checkBrowserUrlPolicy('http://localhost:3000', { lookupDns: false });
  assert.equal(localhost.allowed, true);
  assert.equal(localhost.category, 'loopback');

  const loopback = await checkBrowserUrlPolicy('http://127.0.0.1:3000', { lookupDns: false });
  assert.equal(loopback.allowed, true);
  assert.equal(loopback.category, 'loopback');

  const metadata = await checkBrowserUrlPolicy('http://169.254.169.254/latest/meta-data', { lookupDns: false });
  assert.equal(metadata.allowed, false);
  assert.equal(metadata.category, 'metadata');

  const privateNetwork = await checkBrowserUrlPolicy('http://10.0.0.2', { lookupDns: false });
  assert.equal(privateNetwork.allowed, false);
  assert.equal(privateNetwork.category, 'private');

  const privateAllowed = await checkBrowserUrlPolicy('http://10.0.0.2', {
    env: { CANVAS_BROWSER_ALLOW_PRIVATE_NETWORKS: 'true' } as unknown as NodeJS.ProcessEnv,
    lookupDns: false,
  });
  assert.equal(privateAllowed.allowed, true);
  assert.equal(privateAllowed.category, 'private-allowed');

  const fileUrl = await checkBrowserUrlPolicy('file:///etc/passwd', { lookupDns: false });
  assert.equal(fileUrl.allowed, false);

  const publicUrl = await checkBrowserUrlPolicy('https://example.com', { lookupDns: false });
  assert.equal(publicUrl.allowed, true);
  assert.equal(publicUrl.category, 'public');

  console.log('browser-url-policy-test: ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
  });
