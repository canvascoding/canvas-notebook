import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CaddyManager, renderCaddyfile, resolveCaddyTarget } from '../cli/src/core/caddy';
import { createDefaultConfig } from '../cli/src/core/config';
import { commandRequiresOperationLock } from '../cli/src/core/operationLock';
import { resolveDefaultPaths } from '../cli/src/core/platform';
import type { CanvasCliConfig, CommandResult, CommandRunner, RunOptions, RuntimeContext } from '../cli/src/core/types';

class CaddyTestRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; liveContent: string | null }> = [];
  installed = true;
  serviceActive = true;
  validationFailure = false;
  reloadFailure = false;
  restartFailure = false;

  constructor(private readonly caddyfile: string) {}

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<CommandResult> {
    const liveContent = await fs.readFile(this.caddyfile, 'utf8').catch(() => null);
    this.calls.push({ command, args: [...args], liveContent });
    if (command === 'caddy' && args[0] === 'version') {
      return this.installed
        ? { status: 0, stdout: 'v2-test\n', stderr: '' }
        : { status: 127, stdout: '', stderr: 'not found' };
    }
    if (command === 'caddy' && args[0] === 'validate') {
      const candidate = args[args.indexOf('--config') + 1];
      const content = await fs.readFile(candidate, 'utf8');
      assert.match(content, /header_up X-Forwarded-Port 443/u);
      return this.validationFailure
        ? { status: 1, stdout: '', stderr: 'injected validation failure' }
        : { status: 0, stdout: 'Valid configuration\n', stderr: '' };
    }
    if (command === 'systemctl' && args[0] === 'is-active') {
      return this.serviceActive
        ? { status: 0, stdout: 'active\n', stderr: '' }
        : { status: 3, stdout: 'inactive\n', stderr: '' };
    }
    if (command === 'systemctl' && args[0] === 'reload') {
      return this.reloadFailure
        ? { status: 1, stdout: '', stderr: 'injected reload failure' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'systemctl' && args[0] === 'restart') {
      return this.restartFailure
        ? { status: 1, stdout: '', stderr: 'injected restart failure' }
        : { status: 0, stdout: '', stderr: '' };
    }
    return { status: 127, stdout: '', stderr: `Unexpected test command: ${command} ${args.join(' ')}` };
  }
}

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-portable-caddy-'));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createFixture(root: string, platform: RuntimeContext['platform'] = 'linux'): {
  config: CanvasCliConfig;
  context: RuntimeContext;
  manager: CaddyManager;
  runner: CaddyTestRunner;
  caddyfile: string;
  legacyConfig: string;
} {
  const paths = resolveDefaultPaths(platform, {
    HOME: root,
    NODE_ENV: 'test',
    CANVAS_INSTALL_DIR: path.join(root, 'install'),
    CANVAS_DATA_DIR: path.join(root, 'data'),
  });
  const context: RuntimeContext = { platform, paths, serviceName: 'canvas-notebook', dockerBin: 'docker' };
  const caddyfile = path.join(root, 'Caddyfile');
  const legacyConfig = path.join(root, 'conf.d', 'canvas-notebook.caddy');
  const runner = new CaddyTestRunner(caddyfile);
  const manager = new CaddyManager(runner, context, { CANVAS_CADDY_TEST_ROOT: root, NODE_ENV: 'test' });
  const config = createDefaultConfig(paths, platform);
  config.hostPort = 3456;
  config.domain = 'notebook.example.com';
  config.env.BETTER_AUTH_BASE_URL = 'https://notebook.example.com';
  config.env.BASE_URL = 'https://fallback.example.com';
  return { config, context, manager, runner, caddyfile, legacyConfig };
}

async function main(): Promise<void> {
  assert.equal(commandRequiresOperationLock('caddy', []), false);
  assert.equal(commandRequiresOperationLock('caddy-reload', []), true);
  assert.equal(commandRequiresOperationLock('caddy-fix', []), true);

  await withTempRoot(async (root) => {
    const { config, manager, runner } = createFixture(root, 'macos');
    await assert.rejects(() => manager.status(config), /only supported on Linux/u);
    assert.equal(runner.calls.length, 0, 'unsupported platforms must not execute host commands');
    assert.deepEqual(await fs.readdir(root), [], 'unsupported platforms must not create files');
  });

  await withTempRoot(async (root) => {
    const { config } = createFixture(root);
    assert.deepEqual(resolveCaddyTarget(config), {
      baseUrl: 'https://notebook.example.com',
      domain: 'notebook.example.com',
      publicDomain: true,
    });
    config.env.BETTER_AUTH_BASE_URL = '';
    assert.equal(resolveCaddyTarget(config).domain, 'fallback.example.com');
    config.env.BASE_URL = '';
    assert.equal(resolveCaddyTarget(config).domain, 'notebook.example.com');
    config.domain = '127.0.0.1';
    assert.equal(resolveCaddyTarget(config).publicDomain, false);
    assert.throws(() => renderCaddyfile('bad domain', 3456), /Invalid Caddy domain/u);
  });

  await withTempRoot(async (root) => {
    const { config, manager, runner, caddyfile } = createFixture(root);
    const applied = await manager.apply(config, { repair: false });
    assert.equal(applied.success, true);
    assert.equal(applied.changed, true);
    assert.equal(applied.reloaded, true);
    assert.equal(applied.inSync, true);
    assert.equal(await fs.readFile(caddyfile, 'utf8'), renderCaddyfile('notebook.example.com', 3456));
    assert.match(await fs.readFile(caddyfile, 'utf8'), /handle \/__canvas-host\/operations\/\*/u);
    assert.match(await fs.readFile(caddyfile, 'utf8'), /@not_read not method GET/u);
    assert.match(await fs.readFile(caddyfile, 'utf8'), /respond @not_read 405/u);
    assert.match(await fs.readFile(caddyfile, 'utf8'), /reverse_proxy 127\.0\.0\.1:3457/u);
    assert.equal((await fs.stat(caddyfile)).mode & 0o777, 0o644);
    const validation = runner.calls.find((call) => call.command === 'caddy' && call.args[0] === 'validate');
    assert.ok(validation, 'candidate must be validated');
    assert.equal(validation.liveContent, null, 'candidate validation must happen before the live write');
    const reloadIndex = runner.calls.findIndex((call) => call.command === 'systemctl' && call.args[0] === 'reload');
    const validateIndex = runner.calls.findIndex((call) => call.command === 'caddy' && call.args[0] === 'validate');
    assert.ok(validateIndex >= 0 && reloadIndex > validateIndex, 'reload must happen only after validation');
  });

  await withTempRoot(async (root) => {
    const { config, manager, caddyfile } = createFixture(root);
    const oldCanvasSite = 'notebook.example.com {\n    reverse_proxy localhost:3456\n}\n';
    await fs.writeFile(caddyfile, oldCanvasSite, 'utf8');
    const result = await manager.apply(config, { repair: false });
    assert.equal(result.changed, true);
    assert.equal(result.inSync, true);
    assert.match(await fs.readFile(caddyfile, 'utf8'), /X-Forwarded-Port 443/u);
  });

  await withTempRoot(async (root) => {
    const { config, manager, caddyfile, legacyConfig } = createFixture(root);
    const defaultSite = ':80 {\n    root * /usr/share/caddy\n    file_server\n}\n';
    await fs.writeFile(caddyfile, defaultSite, 'utf8');
    await fs.mkdir(path.dirname(legacyConfig), { recursive: true });
    await fs.writeFile(legacyConfig, 'legacy canvas config\n', 'utf8');
    await assert.rejects(() => manager.apply(config, { repair: false }), /Refusing to overwrite unmanaged Caddyfile/u);
    assert.equal(await fs.readFile(caddyfile, 'utf8'), defaultSite);
    const repaired = await manager.apply(config, { repair: true });
    assert.equal(repaired.changed, true);
    assert.equal(repaired.legacyConfigExists, false);
    await assert.rejects(fs.stat(legacyConfig), /ENOENT/u);
  });

  await withTempRoot(async (root) => {
    const { config, manager, runner, caddyfile } = createFixture(root);
    const original = 'notebook.example.com {\n    reverse_proxy localhost:3456\n}\n';
    await fs.writeFile(caddyfile, original, 'utf8');
    runner.validationFailure = true;
    await assert.rejects(() => manager.apply(config, { repair: false }), /injected validation failure/u);
    assert.equal(await fs.readFile(caddyfile, 'utf8'), original, 'failed validation must preserve the live file');
    assert.equal(runner.calls.some((call) => call.command === 'systemctl' && call.args[0] === 'reload'), false);
  });

  await withTempRoot(async (root) => {
    const { config, manager, runner, caddyfile, legacyConfig } = createFixture(root);
    const original = 'notebook.example.com {\n    reverse_proxy localhost:3456\n}\n';
    await fs.writeFile(caddyfile, original, 'utf8');
    await fs.mkdir(path.dirname(legacyConfig), { recursive: true });
    await fs.writeFile(legacyConfig, 'legacy canvas config\n', 'utf8');
    runner.reloadFailure = true;
    runner.restartFailure = true;
    await assert.rejects(() => manager.apply(config, { repair: true }), /injected restart failure/u);
    assert.equal(await fs.readFile(caddyfile, 'utf8'), original, 'service failure must roll back the live file');
    assert.equal(await fs.readFile(legacyConfig, 'utf8'), 'legacy canvas config\n', 'service failure must restore legacy config');
  });

  await withTempRoot(async (root) => {
    const { config, manager, caddyfile } = createFixture(root);
    const unmanaged = 'unrelated.example.com {\n    reverse_proxy localhost:9000\n}\n';
    await fs.writeFile(caddyfile, unmanaged, 'utf8');
    await assert.rejects(() => manager.apply(config, { repair: true }), /Refusing to overwrite unmanaged Caddyfile/u);
    assert.equal(await fs.readFile(caddyfile, 'utf8'), unmanaged);
  });

  await withTempRoot(async (root) => {
    const { config, manager, caddyfile } = createFixture(root);
    const foreign = path.join(root, 'foreign-caddyfile');
    await fs.writeFile(foreign, 'do not touch\n', 'utf8');
    await fs.symlink(foreign, caddyfile);
    await assert.rejects(() => manager.apply(config, { repair: true }), /Unsafe Caddyfile path/u);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'do not touch\n');
  });

  await withTempRoot(async (root) => {
    const { config, manager, runner, caddyfile } = createFixture(root);
    config.domain = '';
    config.env.BETTER_AUTH_BASE_URL = 'http://localhost:3456';
    config.env.BASE_URL = '';
    const skippedDomain = await manager.apply(config, { repair: false });
    assert.equal(skippedDomain.skipReason, 'no_public_domain');
    await assert.rejects(fs.stat(caddyfile), /ENOENT/u);
    config.env.BETTER_AUTH_BASE_URL = 'https://notebook.example.com';
    runner.installed = false;
    const skippedBinary = await manager.apply(config, { repair: false });
    assert.equal(skippedBinary.skipReason, 'caddy_not_installed');
    await assert.rejects(fs.stat(caddyfile), /ENOENT/u);
  });

  console.log('portable-cli-caddy-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
