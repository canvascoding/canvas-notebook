/* eslint-disable @typescript-eslint/no-require-imports -- Exercises the CommonJS custom-server bootstrap. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { loadProductionNextConfig } = require('../server/production-next-config');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-next-config-'));
try {
  assert.equal(loadProductionNextConfig(true, directory), undefined);
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
  for (const invalid of [null, [], {}, { distDir: '' }]) {
    fs.writeFileSync(filename, JSON.stringify({ config: invalid }));
    assert.throws(() => loadProductionNextConfig(false, directory), /missing or invalid/);
  }
  fs.writeFileSync(filename, '{');
  assert.throws(() => loadProductionNextConfig(false, directory), SyntaxError);
  console.log('Production Next.js configuration startup contracts passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
