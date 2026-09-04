import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SystemdUnitStore } from './autoUpdate';
import { resolveCliPath } from './cliPath';
import { runOrThrow } from './process';
import type { CanvasCliConfig, CommandRunner, RuntimeContext } from './types';

export { resolveCliPath } from './cliPath';

const MACOS_LABEL = 'io.canvasstudios.notebook';
const WINDOWS_TASK_NAME = 'Canvas Notebook';
const LINUX_SERVICE_NAME = 'canvas-notebook.service';
const UPDATER_SERVICE_NAME = 'canvas-notebook-updater.service';
const UPDATER_SOCKET_NAME = 'canvas-notebook-updater.socket';
const MANAGED_MARKER = '# Managed by Canvas Notebook';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdQuote(value: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new Error('systemd value contains unsupported control characters.');
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function systemdPath(value: string): string {
  if (!path.isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error('systemd paths must be absolute and contain no control characters.');
  return value.replace(/[\\\s"']/gu, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function renderLinuxSystemdService(config: CanvasCliConfig, cliPath: string): string {
  const updaterDependency = ['true', '1', 'yes', 'on'].includes(
    String(config.env.CANVAS_STANDALONE_UPDATER_ENABLED || '').trim().toLowerCase(),
  ) ? ' canvas-notebook-updater.socket' : '';
  return `${MANAGED_MARKER}\n[Unit]\nDescription=Canvas Notebook\nRequires=docker.service${updaterDependency}\nAfter=docker.service network-online.target${updaterDependency}\nWants=network-online.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nWorkingDirectory=${systemdPath(config.paths.installDir)}\nEnvironment=${systemdQuote(`CANVAS_MANAGER_LOG_DIR=${path.dirname(config.paths.logFile)}`)}\nExecStart=${systemdQuote(cliPath)} start --no-banner\nExecStop=${systemdQuote(cliPath)} stop --no-banner\nExecReload=${systemdQuote(cliPath)} restart --no-banner\nTimeoutStartSec=10800\nTimeoutStopSec=120\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function recognizedLinuxService(content: string): boolean {
  return content.includes(MANAGED_MARKER) ||
    (content.includes('Description=Canvas Notebook') && content.includes('RemainAfterExit=yes') &&
      /ExecStart=.*canvas-notebook.* start --no-banner/u.test(content) && content.includes('WantedBy=multi-user.target'));
}

function recognizedUpdaterService(content: string): boolean {
  return content.includes(MANAGED_MARKER) &&
    content.includes('Description=Canvas Notebook Standalone Updater') &&
    /ExecStart=.*canvas-notebook.* updater-service --no-banner/u.test(content);
}

function recognizedUpdaterSocket(content: string): boolean {
  return content.includes(MANAGED_MARKER) &&
    content.includes('ListenStream=/run/canvas-notebook-updater.sock') &&
    content.includes('SocketGroup=canvas-notebook-updater');
}

export function macosLaunchAgentPath(homeDir = os.homedir()): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`);
}

export function renderMacosLaunchAgent(config: CanvasCliConfig, cliPath: string): string {
  const args = [cliPath, 'start', '--no-banner'];
  const argXml = args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.paths.installDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.paths.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.paths.logFile)}</string>
</dict>
</plist>
`;
}

function windowsQuote(value: string): string {
  let quoted = '"';
  let backslashCount = 0;

  for (const character of value) {
    if (character === '\\') {
      backslashCount += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashCount * 2 + 1) + '"';
      backslashCount = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashCount) + character;
    backslashCount = 0;
  }

  return quoted + '\\'.repeat(backslashCount * 2) + '"';
}

export function windowsTaskCommand(cliPath: string): string {
  return `${windowsQuote(cliPath)} start --no-banner`;
}

export class ServiceManager {
  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async validateLinuxUnit(content: string): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-service-verify-'));
    const candidate = path.join(directory, LINUX_SERVICE_NAME);
    const dockerStub = path.join(directory, 'docker.service');
    try {
      await Promise.all([
        fs.writeFile(candidate, content, { encoding: 'utf8', mode: 0o600 }),
        fs.writeFile(dockerStub, '[Service]\nType=oneshot\nExecStart=/bin/true\n', { encoding: 'utf8', mode: 0o600 }),
      ]);
      const result = await this.runner.run('systemd-analyze', ['verify', candidate, dockerStub]);
      if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'systemd service validation failed.');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async status(config: CanvasCliConfig): Promise<string> {
    if (config.platform.serviceMode === 'systemd') {
      const result = await this.runner.run('systemctl', ['is-active', LINUX_SERVICE_NAME]);
      return result.status === 0 ? `systemd: ${result.stdout.trim() || 'active'}` : `systemd: ${result.stdout.trim() || result.stderr.trim() || 'inactive'}`;
    }
    if (config.platform.serviceMode === 'launchd') {
      const result = await this.runner.run('launchctl', ['list', MACOS_LABEL]);
      return result.status === 0 ? `launchd: ${MACOS_LABEL} loaded` : `launchd: ${MACOS_LABEL} not loaded`;
    }
    if (config.platform.serviceMode === 'scheduled-task') {
      const result = await this.runner.run('schtasks.exe', ['/Query', '/TN', WINDOWS_TASK_NAME]);
      return result.status === 0 ? `scheduled-task: ${WINDOWS_TASK_NAME} registered` : `scheduled-task: ${WINDOWS_TASK_NAME} not registered`;
    }
    return 'service: disabled';
  }

  async install(config: CanvasCliConfig): Promise<string> {
    const cliPath = resolveCliPath(this.env);
    if (config.platform.serviceMode === 'systemd') {
      const units = new SystemdUnitStore(this.runner, this.env);
      await units.assertSafeRoot();
      const previous = await units.read(LINUX_SERVICE_NAME);
      if (previous !== null && !recognizedLinuxService(previous)) {
        throw new Error(`Refusing to overwrite unmanaged systemd unit: ${units.path(LINUX_SERVICE_NAME)}`);
      }
      const desired = renderLinuxSystemdService(config, cliPath);
      await this.validateLinuxUnit(desired);
      try {
        if (previous !== desired) await units.write(LINUX_SERVICE_NAME, desired);
        if (previous !== desired) await units.runRootOrThrow('systemctl', ['daemon-reload']);
        await units.runRootOrThrow('systemctl', ['enable', LINUX_SERVICE_NAME]);
        await units.runRootOrThrow('systemctl', ['start', LINUX_SERVICE_NAME]);
        return `systemd service installed and enabled: ${units.path(LINUX_SERVICE_NAME)}`;
      } catch (error) {
        await units.restore(LINUX_SERVICE_NAME, previous).catch(() => undefined);
        await units.runRoot('systemctl', ['daemon-reload']);
        throw error;
      }
    }
    if (config.platform.serviceMode === 'launchd') {
      const plistPath = macosLaunchAgentPath();
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, renderMacosLaunchAgent(config, cliPath), 'utf8');
      await this.runner.run('launchctl', ['unload', plistPath]);
      await runOrThrow(this.runner, 'launchctl', ['load', plistPath]);
      return `launchd agent installed: ${plistPath}`;
    }
    if (config.platform.serviceMode === 'scheduled-task') {
      await runOrThrow(this.runner, 'schtasks.exe', [
        '/Create',
        '/TN',
        WINDOWS_TASK_NAME,
        '/TR',
        windowsTaskCommand(cliPath),
        '/SC',
        'ONLOGON',
        '/F',
      ]);
      return `scheduled task installed: ${WINDOWS_TASK_NAME}`;
    }
    return 'service install skipped: serviceMode=none';
  }

  async uninstall(config: CanvasCliConfig): Promise<string> {
    if (config.platform.serviceMode === 'systemd') {
      const units = new SystemdUnitStore(this.runner, this.env);
      await units.assertSafeRoot();
      const [updaterService, updaterSocket] = await Promise.all([
        units.read(UPDATER_SERVICE_NAME),
        units.read(UPDATER_SOCKET_NAME),
      ]);
      if (updaterService !== null && !recognizedUpdaterService(updaterService)) {
        throw new Error(`Refusing to remove unmanaged systemd unit: ${units.path(UPDATER_SERVICE_NAME)}`);
      }
      if (updaterSocket !== null && !recognizedUpdaterSocket(updaterSocket)) {
        throw new Error(`Refusing to remove unmanaged systemd unit: ${units.path(UPDATER_SOCKET_NAME)}`);
      }
      const current = await units.read(LINUX_SERVICE_NAME);
      if (current !== null && !recognizedLinuxService(current)) {
        throw new Error(`Refusing to remove unmanaged systemd unit: ${units.path(LINUX_SERVICE_NAME)}`);
      }
      await units.runRoot('systemctl', ['stop', UPDATER_SERVICE_NAME]);
      await units.runRoot('systemctl', ['stop', UPDATER_SOCKET_NAME]);
      await units.runRoot('systemctl', ['disable', UPDATER_SOCKET_NAME]);
      if (updaterService !== null) await units.remove(UPDATER_SERVICE_NAME);
      if (updaterSocket !== null) await units.remove(UPDATER_SOCKET_NAME);
      await units.runRoot('systemctl', ['stop', LINUX_SERVICE_NAME]);
      await units.runRoot('systemctl', ['disable', LINUX_SERVICE_NAME]);
      if (current !== null) await units.remove(LINUX_SERVICE_NAME);
      await units.runRootOrThrow('systemctl', ['daemon-reload']);
      await units.runRoot('systemctl', ['reset-failed', LINUX_SERVICE_NAME, UPDATER_SERVICE_NAME, UPDATER_SOCKET_NAME]);
      return `systemd service removed: ${units.path(LINUX_SERVICE_NAME)}`;
    }
    if (config.platform.serviceMode === 'launchd') {
      const plistPath = macosLaunchAgentPath();
      await this.runner.run('launchctl', ['unload', plistPath]);
      await fs.rm(plistPath, { force: true });
      return `launchd agent removed: ${plistPath}`;
    }
    if (config.platform.serviceMode === 'scheduled-task') {
      await this.runner.run('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
      return `scheduled task removed: ${WINDOWS_TASK_NAME}`;
    }
    return 'service uninstall skipped: serviceMode=none';
  }
}
