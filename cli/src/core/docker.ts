import { setTimeout as delay } from 'node:timers/promises';

import { runOrThrow } from './process';
import type { CanvasCliConfig, CommandRunner, RuntimeContext, StatusJson } from './types';
import { resolveCliVersion } from './version';

export class DockerManager {
  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
  ) {}

  async docker(args: string[], options: { env?: NodeJS.ProcessEnv; stdin?: string; stdio?: 'pipe' | 'inherit'; timeoutMs?: number } = {}) {
    return this.runner.run(this.context.dockerBin, args, {
      cwd: this.context.paths.installDir,
      env: options.env,
      stdin: options.stdin,
      stdio: options.stdio ?? 'pipe',
      timeoutMs: options.timeoutMs,
    });
  }

  async dockerOrThrow(args: string[], options: { env?: NodeJS.ProcessEnv; stdin?: string; stdio?: 'pipe' | 'inherit'; timeoutMs?: number } = {}) {
    return runOrThrow(this.runner, this.context.dockerBin, args, {
      cwd: this.context.paths.installDir,
      env: options.env,
      stdin: options.stdin,
      stdio: options.stdio ?? 'pipe',
      timeoutMs: options.timeoutMs,
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

  async composeOrThrow(config: CanvasCliConfig, args: string[], stdio: 'pipe' | 'inherit' = 'pipe', timeoutMs?: number, env?: NodeJS.ProcessEnv) {
    return this.dockerOrThrow(this.composeArgs(config, args), { env, stdio, timeoutMs });
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

  async pruneUnusedImages(timeoutMs?: number): Promise<void> {
    const result = await this.docker(['image', 'prune', '-af'], { stdio: 'pipe', timeoutMs });
    if (result.status !== 0) {
      console.warn(`Docker image prune completed with status ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async isContainerRunning(containerId: string): Promise<boolean> {
    if (!containerId) return false;
    const result = await this.docker(['inspect', '--format', '{{.State.Running}}', containerId]);
    return result.status === 0 && result.stdout.trim() === 'true';
  }

  async pull(config: CanvasCliConfig, stdio: 'pipe' | 'inherit' = 'inherit', timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<void> {
    await this.composeOrThrow(config, ['pull', this.context.serviceName], stdio, timeoutMs, env);
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

  async isHealthy(config: CanvasCliConfig, timeoutMs = 3000): Promise<boolean> {
    try {
      const response = await fetch(this.healthUrl(config), { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitUntilHealthy(
    config: CanvasCliConfig,
    maxAttempts = Number(process.env.CANVAS_HEALTH_MAX_ATTEMPTS || 180),
    timeoutMs?: number,
  ): Promise<void> {
    const deadline = timeoutMs === undefined ? null : Date.now() + Math.max(1, timeoutMs);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remaining = deadline === null ? 3000 : deadline - Date.now();
      if (remaining <= 0) break;
      if (await this.isHealthy(config, Math.min(3000, remaining))) return;
      if (deadline !== null && deadline - Date.now() <= 0) break;
      await delay(deadline === null ? 1000 : Math.min(1000, Math.max(1, deadline - Date.now())));
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
    const [localId, localDigest, localCreated, runningRef, runningId, runningStartedAt, appVersion, cliVersion] = await Promise.all([
      this.docker(['image', 'inspect', config.image, '--format', '{{.Id}}']),
      this.docker(['image', 'inspect', config.image, '--format', '{{range .RepoDigests}}{{println .}}{{end}}']),
      this.docker(['image', 'inspect', config.image, '--format', '{{.Created}}']),
      containerId ? this.docker(['inspect', '--format', '{{.Config.Image}}', containerId]) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.docker(['inspect', '--format', '{{.Image}}', containerId]) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.docker(['inspect', '--format', '{{.State.StartedAt}}', containerId]) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.docker(['exec', containerId, 'node', '-p', "require('/app/package.json').version"]) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      resolveCliVersion(),
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
      cliVersion,
    };
  }
}
