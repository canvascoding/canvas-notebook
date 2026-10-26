/* eslint-disable @typescript-eslint/no-require-imports -- Exercises the CommonJS custom-server bootstrap. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { loadProductionNextConfig } = require('../server/production-next-config');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-next-config-'));
const originalStandaloneConfig = process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
try {
  assert.equal(loadProductionNextConfig(true, directory), undefined);
  assert.equal(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG, originalStandaloneConfig);
  assert.throws(() => loadProductionNextConfig(false, directory), /ENOENT/);
  fs.mkdirSync(path.join(directory, '.next'));
  const filename = path.join(directory, '.next', 'required-server-files.json');
  const config = { distDir: '.next', deploymentId: 'fixture-build', basePath: '',
    experimental: { proxyClientMaxBodySize: 256 * 1024 * 1024 },
    images: { remotePatterns: [{ hostname: 'images.example.test' }] } };
  fs.writeFileSync(filename, JSON.stringify({ config }));
  assert.deepEqual(loadProductionNextConfig(false, directory), config);
  // Exercise the actual custom-server Next initializer without starting HTTP,
  // loading authentication, or opening any database.
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const initializer = source.slice(source.indexOf('const app = next({'), source.indexOf('const handle = app.getRequestHandler();'));
  assert(initializer.startsWith('const app = next({'));
  let received;
  vm.runInNewContext(initializer, { dev: false, hostname: 'localhost', port: 3000,
    useWebpackDev: false, loadProductionNextConfig: () => config, next: options => { received = options; return {}; } });
  assert.equal(received.conf, config, 'Production startup must pass the exact build config to Next.js.');
  // The real custom-server prepare path loads its internal router without
  // forwarding options.conf. Exercise that independent Next.js loader in a
  // clean process and a container-like directory with no next.config file.
  const router = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { loadProductionNextConfig } = require(process.argv[2]);
    const loadConfig = require(process.argv[3]).default;
    const { PHASE_PRODUCTION_SERVER } = require(process.argv[4]);
    (async () => {
      const built = loadProductionNextConfig(false, process.argv[1]);
      const actual = await loadConfig(PHASE_PRODUCTION_SERVER, process.argv[1], { silent: true });
      assert.equal(actual.experimental.proxyClientMaxBodySize, built.experimental.proxyClientMaxBodySize);
      assert.equal(actual.deploymentId, built.deploymentId);
      assert.deepEqual(actual.images.remotePatterns, built.images.remotePatterns);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, directory, require.resolve('../server/production-next-config'),
  require.resolve('next/dist/server/config'), require.resolve('next/constants')], {
    env: { ...process.env, __NEXT_PRIVATE_STANDALONE_CONFIG: '' },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(router.status, 0, `The internal production router must load the built config: ${router.stderr}`);
  for (const invalid of [null, [], {}, { distDir: '' }]) {
    fs.writeFileSync(filename, JSON.stringify({ config: invalid }));
    assert.throws(() => loadProductionNextConfig(false, directory), /missing or invalid/);
  }
  fs.writeFileSync(filename, '{');
  assert.throws(() => loadProductionNextConfig(false, directory), SyntaxError);
  console.log('Production Next.js configuration startup contracts passed');
} finally {
  if (originalStandaloneConfig === undefined) delete process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
  else process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = originalStandaloneConfig;
  fs.rmSync(directory, { recursive: true, force: true });
}
