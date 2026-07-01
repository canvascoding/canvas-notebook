import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runOrThrow } from './process';
import type { CanvasCliConfig, CommandRunner, RuntimeContext } from './types';

const MACOS_LABEL = 'io.canvasstudios.notebook';
const WINDOWS_TASK_NAME = 'Canvas Notebook';
const LINUX_SERVICE_NAME = 'canvas-notebook.service';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function resolveCliPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CANVAS_CLI_PATH || process.argv[1] || 'canvas-notebook';
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
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function windowsTaskCommand(cliPath: string): string {
  return `${windowsQuote(cliPath)} start --no-banner`;
}

export class ServiceManager {
  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
  ) {}

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
    const cliPath = resolveCliPath();
    if (config.platform.serviceMode === 'systemd') {
      await runOrThrow(this.runner, 'systemctl', ['enable', LINUX_SERVICE_NAME]);
      await runOrThrow(this.runner, 'systemctl', ['start', LINUX_SERVICE_NAME]);
      return `systemd service enabled: ${LINUX_SERVICE_NAME}`;
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
      await this.runner.run('systemctl', ['stop', LINUX_SERVICE_NAME]);
      await this.runner.run('systemctl', ['disable', LINUX_SERVICE_NAME]);
      return `systemd service disabled: ${LINUX_SERVICE_NAME}`;
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
