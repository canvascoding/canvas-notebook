import { setTimeout as delay } from 'node:timers/promises';

import { runOrThrow } from './process';
import type { CanvasCliConfig, CommandRunner, RuntimeContext, StatusJson } from './types';

export class DockerManager {
  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
  ) {}

  async docker(args: string[], options: { stdin?: string; stdio?: 'pipe' | 'inherit' } = {}) {
    return this.runner.run(this.context.dockerBin, args, {
      cwd: this.context.paths.installDir,
      stdin: options.stdin,
      stdio: options.stdio ?? 'pipe',
    });
  }

  async dockerOrThrow(args: string[], options: { stdin?: string; stdio?: 'pipe' | 'inherit' } = {}) {
    return runOrThrow(this.runner, this.context.dockerBin, args, {
      cwd: this.context.paths.installDir,
      stdin: options.stdin,
      stdio: options.stdio ?? 'pipe',
    });
  }

  composeArgs(config: CanvasCliConfig, args: string[]): string[] {
    return [
      'compose',
      '-f',
      config.paths.composeFile,
      '--project-directory',
      config.paths.installDir,
      ...args,
    ];
  }

  async compose(config: CanvasCliConfig, args: string[], stdio: 'pipe' | 'inherit' = 'pipe') {
    return this.docker(this.composeArgs(config, args), { stdio });
  }

  async composeOrThrow(config: CanvasCliConfig, args: string[], stdio: 'pipe' | 'inherit' = 'pipe') {
    return this.dockerOrThrow(this.composeArgs(config, args), { stdio });
  }

  async isReachable(): Promise<boolean> {
    const result = await this.docker(['info']);
    return result.status === 0;
  }

  async containerId(config: CanvasCliConfig): Promise<string> {
    const result = await this.compose(config, ['ps', '-q', this.context.serviceName]);
    if (result.status !== 0) return '';
    return result.stdout.trim();
  }

  async imageId(imageRef: string): Promise<string> {
    const result = await this.docker(['image', 'inspect', imageRef, '--format', '{{.Id}}']);
    return result.status === 0 ? result.stdout.trim() : '';
  }

  async containerImageId(containerId: string): Promise<string> {
    if (!containerId) return '';
    const result = await this.docker(['inspect', '--format', '{{.Image}}', containerId]);
    return result.status === 0 ? result.stdout.trim() : '';
  }

  async isContainerRunning(containerId: string): Promise<boolean> {
    if (!containerId) return false;
    const result = await this.docker(['inspect', '--format', '{{.State.Running}}', containerId]);
    return result.status === 0 && result.stdout.trim() === 'true';
  }

  async pull(config: CanvasCliConfig, stdio: 'pipe' | 'inherit' = 'inherit'): Promise<void> {
    await this.composeOrThrow(config, ['pull', this.context.serviceName], stdio);
  }

  async needsRecreate(config: CanvasCliConfig): Promise<boolean> {
    const id = await this.containerId(config);
    if (!id) return true;
    if (!await this.isContainerRunning(id)) return true;
    const [localImageId, runningImageId] = await Promise.all([
      this.imageId(config.image),
      this.containerImageId(id),
    ]);
    if (!localImageId || !runningImageId || localImageId !== runningImageId) return true;
    return !(await this.isHealthy(config));
  }

  healthUrl(config: CanvasCliConfig): string {
    return `http://127.0.0.1:${config.hostPort}/api/health`;
  }

  async isHealthy(config: CanvasCliConfig): Promise<boolean> {
    try {
      const response = await fetch(this.healthUrl(config), { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitUntilHealthy(config: CanvasCliConfig, maxAttempts = 180): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (await this.isHealthy(config)) return;
      await delay(1000);
    }
    throw new Error(`Canvas Notebook did not become healthy within ${maxAttempts}s.`);
  }

  async inspectContainer(config: CanvasCliConfig): Promise<StatusJson['container']> {
    const id = await this.containerId(config);
    if (!id) return null;
    const format = [
      '{"id":"{{.Id}}"',
      ',"name":"{{.Name}}"',
      ',"status":"{{.State.Status}}"',
      ',"running":{{.State.Running}}',
      ',"restarting":{{.State.Restarting}}',
      ',"oomKilled":{{.State.OOMKilled}}',
      ',"exitCode":{{.State.ExitCode}}',
      ',"restartCount":{{.RestartCount}}',
      ',"image":"{{.Config.Image}}"',
      ',"imageId":"{{.Image}}"',
      ',"startedAt":"{{.State.StartedAt}}"}',
    ].join('');
    const result = await this.docker(['inspect', '--format', format, id]);
    if (result.status !== 0) return null;
    try {
      return JSON.parse(result.stdout.trim()) as StatusJson['container'];
    } catch {
      return null;
    }
  }

  async imageStatus(config: CanvasCliConfig, containerId: string): Promise<StatusJson['image']> {
    const [localId, localDigest, localCreated, runningRef, runningId, runningStartedAt, appVersion] = await Promise.all([
      this.docker(['image', 'inspect', config.image, '--format', '{{.Id}}']),
      this.docker(['image', 'inspect', config.image, '--format', '{{range .RepoDigests}}{{println .}}{{end}}']),
      this.docker(['image', 'inspect', config.image, '--format', '{{.Created}}']),
      containerId ? this.docker(['inspect', '--format', '{{.Config.Image}}', containerId]) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.docker(['inspect', '--format', '{{.Image}}', containerId]) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.docker(['inspect', '--format', '{{.State.StartedAt}}', containerId]) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.docker(['exec', containerId, 'node', '-p', "require('/app/package.json').version"]) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
    ]);

    return {
      configuredRef: config.image,
      localId: localId.status === 0 ? localId.stdout.trim() : '',
      localDigest: localDigest.status === 0 ? localDigest.stdout.trim().split(/\r?\n/)[0] || '' : '',
      localCreated: localCreated.status === 0 ? localCreated.stdout.trim() : '',
      runningRef: runningRef.status === 0 ? runningRef.stdout.trim() : '',
      runningImageId: runningId.status === 0 ? runningId.stdout.trim() : '',
      runningStartedAt: runningStartedAt.status === 0 ? runningStartedAt.stdout.trim() : '',
      appVersion: appVersion.status === 0 ? appVersion.stdout.trim() : '',
      cliVersion: process.env.npm_package_version || '',
    };
  }
}
