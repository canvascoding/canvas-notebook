/* eslint-disable @typescript-eslint/no-require-imports -- Deliberate CommonJS launcher; it loads dotenv before spawning the server or Playwright. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
process.chdir(repo);
const dotenv = require('dotenv');
const state = path.join(os.homedir(), '.local/state/canvas-local-team-seat');
dotenv.config({ path: path.join(state, 'notebook-host-dev.env'), override: true, quiet: true });
dotenv.config({ path: path.join(state, 'fixtures.env'), override: false, quiet: true });
const mode = process.argv[2];
if (!['fixture', 'host', 'browser', 'planning-browser'].includes(mode)) throw new Error('Choose the explicit fixture, host, browser or planning-browser mode. No automatic server lifecycle is performed.');
if (mode === 'planning-browser' && process.argv.length > 4) throw new Error('Planning acceptance uses only its fixed configuration; additional CLI overrides are not supported.');
const intake = fs.readFileSync('/tmp/canvas-plugin-gateway-stage4a-intake-path', 'utf8').trim();
if (!path.isAbsolute(intake)) throw new Error('An absolute owned source intake is required.');
Object.assign(process.env, { CANVAS_APP_ROOT: repo, HOSTNAME: '127.0.0.1', PORT: '3001', BASE_URL: 'http://127.0.0.1:3001',
  BETTER_AUTH_BASE_URL: 'http://127.0.0.1:3001', CANVAS_PLUGIN_LOCAL_SOURCE_ROOT: intake, E2E_EXTERNAL_SERVER: '1',
  TEST_LOGIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL, TEST_LOGIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD });
let args;
if (mode === 'fixture') {
  process.env.CANVAS_MOBILE_PLUGIN_FIXTURE = '1';
  args = ['--conditions=react-server', '--import', 'tsx', 'scripts/helpers/mobile-plugin-access-store-fixture.ts'];
} else {
  const fixtureFile = process.argv[3];
  if (!fixtureFile || !path.isAbsolute(fixtureFile)) throw new Error('An explicit new private fixture JSON path is required.');
  const stat = fs.lstatSync(fixtureFile), parentStat = fs.lstatSync(path.dirname(fixtureFile));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
    || !parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o777) !== 0o700) throw new Error('Fixture metadata must remain private.');
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  if (!/^[a-f0-9]{10}$/.test(fixture.nonce) || fixture.name !== `package-editor-qa-${fixture.nonce}`
    || fs.realpathSync(intake) !== fixture.sourceParent || fixture.fixtureDirectory !== path.dirname(fixtureFile)) throw new Error('The explicit fixture does not match the owned intake.');
  const registry = new URL(fixture.registryUrl);
  if (registry.protocol !== 'https:' || registry.hostname !== '127.0.0.1' || registry.username || registry.password
    || registry.pathname !== '/registry.json') throw new Error('Only the private loopback HTTPS registry is allowed.');
  for (const key of ['certificate', 'proofFile']) if (!path.isAbsolute(fixture[key]) || path.dirname(fixture[key]) !== fixture.fixtureDirectory) throw new Error('Fixture support files must remain in its private directory.');
  Object.assign(process.env, { CANVAS_PLUGIN_STORE_REGISTRY_URL: fixture.registryUrl, NODE_EXTRA_CA_CERTS: fixture.certificate,
    MOBILE_PLUGIN_ACCESS_FIXTURE: fixtureFile, MOBILE_PLUGIN_ACCESS_SOURCE_PROOF: fixture.proofFile });
  process.env.NODE_ENV = mode === 'host' ? 'production' : 'test';
  args = mode === 'host' ? ['--import', 'tsx', 'server.js']
    : [path.join(repo, 'node_modules/@playwright/test/cli.js'), 'test', '--config', mode === 'planning-browser'
      ? 'playwright.planning-progressive-production.config.ts' : 'playwright.mobile-plugin-access-production.config.ts', ...process.argv.slice(4)];
}
const child = spawn(process.execPath, args, { cwd: repo, env: process.env, stdio: 'inherit' });
// Forward signals exclusively to this launcher's own child; never discover or stop another stack/server.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('The explicitly requested mobile acceptance process could not start.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
