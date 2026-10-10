/* eslint-disable @typescript-eslint/no-require-imports -- Fixed CommonJS launcher reads private credentials before starting its isolated child. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');

const repo = path.resolve(__dirname, '..');
const composioLive = process.argv[2] === 'run-workflow-composio-live';
const mobileNative = process.argv[2] === 'run-workflow-mobile-native';
const mobileRenderRepro = process.argv[2] === 'run-workflow-mobile-render-repro';
if (!(composioLive ? process.argv.length === 4 : mobileNative ? [3, 4].includes(process.argv.length) : process.argv.length === 3) || !['run', 'run-workflow', 'run-workflow-mcp-apps', 'run-workflow-mobile-mcp-apps', 'run-workflow-mobile-native', 'run-workflow-mobile-render-repro', 'run-workflow-oauth', 'run-workflow-oauth-desktop', 'run-workflow-oauth-desktop-identity-diagnostic', 'run-workflow-composio-desktop-client', 'run-workflow-composio-desktop', 'run-workflow-composio-live'].includes(process.argv[2])) {
  throw new Error('Choose a fixed isolated acceptance command or the native identity diagnostic.');
}
let tlsReuseInputPath;
if (mobileNative && process.argv.length === 4) {
  try {
    const input = process.argv[3], before = fs.lstatSync(input);
    if (!path.isAbsolute(input) || fs.realpathSync(input) !== input || !before.isFile() || before.isSymbolicLink()
      || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600
      || before.size < 1 || before.size > 4096) throw new Error();
    const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(4097); let length = 0;
      while (length <= 4096) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
      }
      const held = fs.fstatSync(fd), current = fs.lstatSync(input);
      if (length !== before.size || length > 4096 || fs.realpathSync(input) !== input
        || ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].some(key => held[key] !== before[key] || current[key] !== before[key])) throw new Error();
      const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).sort().join(',') !== 'expectedFingerprint256,sourceRoot'
        || typeof value.sourceRoot !== 'string' || !path.isAbsolute(value.sourceRoot) || value.sourceRoot.length > 1024
        || typeof value.expectedFingerprint256 !== 'string' || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u.test(value.expectedFingerprint256)) throw new Error();
      tlsReuseInputPath = input;
    } finally { fs.closeSync(fd); }
  } catch { throw new Error('The owned Mobile Native TLS reuse input could not be verified.'); }
}
const workflow = process.argv[2] !== 'run';
const identityDiagnostic = process.argv[2] === 'run-workflow-oauth-desktop-identity-diagnostic';
const composioDesktopClient = process.argv[2] === 'run-workflow-composio-desktop-client';
const composioNative = process.argv[2] === 'run-workflow-composio-desktop';
const desktop = process.argv[2] === 'run-workflow-oauth-desktop' || identityDiagnostic;
const oauth = process.argv[2] === 'run-workflow-oauth' || desktop;
const privateEnv = path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
const stat = fs.lstatSync(privateEnv);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
  throw new Error('The existing bootstrap configuration must be a private regular file.');
}
// Parse into RAM only. Never inherit the managed instance's providers, license,
// CP tokens, paths, NODE_OPTIONS, NODE_PATH or repository env-file selection.
const secrets = dotenv.parse(fs.readFileSync(privateEnv));
if (!secrets.BOOTSTRAP_ADMIN_EMAIL?.trim() || !secrets.BOOTSTRAP_ADMIN_PASSWORD
  || secrets.BOOTSTRAP_ADMIN_PASSWORD.length < 8) throw new Error('Existing bootstrap credentials are required.');
const maintenance = new URL(secrets.DATABASE_URL || '');
if (maintenance.protocol !== 'postgresql:' && maintenance.protocol !== 'postgres:'
  || maintenance.hostname !== '127.0.0.1' || maintenance.port !== '55433' || maintenance.search || maintenance.hash
  || !maintenance.username) throw new Error('Only the existing local PostgreSQL on port 55433 is supported.');
maintenance.pathname = '/postgres';
const childEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(childEnv, {
  NODE_ENV: 'test', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
  CANVAS_AGENT_SETTINGS_BROWSER_RUN: '1', DATABASE_URL: maintenance.toString(), CANVAS_DATABASE_PROVIDER: 'postgres',
  BOOTSTRAP_ADMIN_EMAIL: secrets.BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD: secrets.BOOTSTRAP_ADMIN_PASSWORD,
  BOOTSTRAP_ADMIN_NAME: 'Isolated Agent Settings Owner',
});
if (workflow) {
  const controlPlaneRoot = fs.realpathSync(path.resolve(repo, '../canvas-control-plane'));
  if (!fs.statSync(path.join(controlPlaneRoot, 'apps/api/src/routes/license.ts')).isFile()) {
    throw new Error('The existing Control Plane source is required for isolated workflow acceptance.');
  }
  childEnv.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN = '1';
  childEnv.CANVAS_CONTROL_PLANE_TEST_ROOT = controlPlaneRoot;
}
if (oauth) childEnv.CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN = '1';
if (process.argv[2] === 'run-workflow-mcp-apps' || mobileRenderRepro) childEnv.CANVAS_SHARED_MCP_APPS_BROWSER_RUN = '1';
if (mobileRenderRepro) childEnv.CANVAS_MOBILE_MCP_RENDER_REPRO_RUN = '1';
if (process.argv[2] === 'run-workflow-mobile-mcp-apps') childEnv.CANVAS_MOBILE_MCP_APPS_BROWSER_RUN = '1';
if (mobileNative) childEnv.CANVAS_MOBILE_PLUGIN_NATIVE_RUN = '1';
if (tlsReuseInputPath) childEnv.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_REUSE_INPUT = tlsReuseInputPath;
if (desktop) childEnv.CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN = '1';
if (identityDiagnostic) childEnv.CANVAS_SHARED_MCP_DESKTOP_IDENTITY_DIAGNOSTIC_RUN = '1';
if (composioDesktopClient) childEnv.CANVAS_SHARED_COMPOSIO_DESKTOP_CLIENT_BROWSER_RUN = '1';
if (composioNative) childEnv.CANVAS_SHARED_COMPOSIO_DESKTOP_OAUTH_BROWSER_RUN = '1';
if (composioLive) {
  const input = fs.realpathSync(process.argv[3]);
  const inputStat = fs.lstatSync(process.argv[3]);
  if (input !== process.argv[3] || !inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.nlink !== 1
    || inputStat.uid !== process.getuid?.() || (inputStat.mode & 0o777) !== 0o600 || inputStat.size > 4096) {
    throw new Error('The live test input must be an owned private regular file.');
  }
  childEnv.CANVAS_COMPOSIO_LIVE_BROWSER_RUN = '1';
  childEnv.CANVAS_COMPOSIO_LIVE_INPUT = input;
}
const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/helpers/agent-settings-tools-browser-fixture.ts'], {
  cwd: repo, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'],
});
// This launcher controls only its own child. The fixture owns the server/DB
// lifecycle and preserves its recovery receipt when cancellation is uncertain.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('The isolated acceptance fixture could not start.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
