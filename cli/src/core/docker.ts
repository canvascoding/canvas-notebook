import { setTimeout as delay } from 'node:timers/promises';

import type { CanvasCliConfig, CommandResult, CommandRunner, RuntimeContext, StatusJson, RunOptions } from './types';
import { resolveCliVersion } from './version';
import type { SystemUpdateActivity } from './systemUpdateContract';
import { DockerEngineClient, DockerEngineError, DockerEngineReadClient, DOCKER_READ_TIMEOUT_MS, type DockerEngineOptions } from './dockerEngine';

function assertDockerReadCompleted(result: CommandResult): void {
  if (result.status === 124 || result.status === 130) {
    throw new DockerEngineError(`Docker CLI read did not complete (status ${result.status}).`, result.status === 124 ? 'ETIMEDOUT' : 'ABORT_ERR');
  }
}

function assertDockerReadSucceeded(result: CommandResult): void {
  assertDockerReadCompleted(result);
  if (result.status !== 0) throw new DockerEngineError(`Docker CLI read failed (status ${result.status}).`, 'ECLI');
}

export class DockerManager {
  private readonly engine: DockerEngineReadClient;
  private readonly execEngine?: DockerEngineClient;

  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
    engineOptions: DockerEngineOptions | DockerEngineClient = {},
  ) {
    this.execEngine = engineOptions instanceof DockerEngineClient ? engineOptions : undefined;
    this.engine = new DockerEngineReadClient(runner, context, this.execEngine ? {} : engineOptions as DockerEngineOptions, this.execEngine);
  }

  async docker(args: string[], options: RunOptions = {}) {
    return this.runner.run(this.context.dockerBin, args, {
      ...options, cwd: this.context.paths.installDir, stdio: options.stdio ?? 'pipe',
      timeoutMs: options.timeoutMs ?? (args[0] === 'compose' && args.includes('logs') && args.includes('-f') ? undefined : args[0] === 'pull' ? 15 * 60_000 : 60_000),
    });
  }

  async dockerOrThrow(args: string[], options: RunOptions = {}) {
    const result = await this.docker(args, options);
    if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Docker exited with ${result.status}`);
    return result;
  }

  async exec(containerId: string, command: string[], options: RunOptions & { user?: string } = {}) {
    if (await this.execEngine?.execAvailable()) return this.execEngine!.exec(containerId, command, options);
    const result = await this.docker(['exec', ...(options.stdin !== undefined ? ['-i'] : []), ...(options.user ? ['-u', options.user] : []), containerId, ...command], options);
    if (result.timedOut || result.signal || result.status === 124 || result.status === 130) throw new Error('Docker CLI exec was interrupted. Remote execution state is unknown; the command was not retried.');
    return result;
  }

  async execOrThrow(containerId: string, command: string[], options: RunOptions & { user?: string } = {}) {
    const result = await this.exec(containerId, command, options);
    if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Container command exited with ${result.status}`);
    return result;
  }

  async resolveContainerId(name: string, timeoutMs = 10_000): Promise<string> {
    if (await this.execEngine?.available()) return (await this.execEngine!.inspectContainer(name, timeoutMs))?.Id || '';
    const result = await this.docker(['inspect', '--format', '{{.Id}}', name], { timeoutMs, capture: 'exact' });
    return result.status === 0 ? result.stdout.trim() : '';
  }

  async containerState(id: string, timeoutMs = 10_000): Promise<string> {
    if (await this.execEngine?.available()) return (await this.execEngine!.inspectContainer(id, timeoutMs))?.State.Status || '';
    const result = await this.docker(['inspect', '--format', '{{.State.Status}}', id], { timeoutMs, capture: 'exact' });
    return result.status === 0 ? result.stdout.trim() : '';
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
    return this.docker(this.composeArgs(config, args), { stdio, timeoutMs: 10_000, capture: 'exact' });
  }

  async composeOrThrow(config: CanvasCliConfig, args: string[], stdio: 'pipe' | 'inherit' = 'pipe', timeoutMs?: number, env?: NodeJS.ProcessEnv) {
    return this.dockerOrThrow(this.composeArgs(config, args), { env, stdio, timeoutMs: timeoutMs ?? (args.includes('pull') ? 15 * 60_000 : args.includes('logs') && args.includes('-f') ? undefined : 120_000) });
  }

  async isReachable(): Promise<boolean> {
    if (this.execEngine) {
      try { if (await this.execEngine?.available()) return await this.execEngine!.ping(); } catch { return false; }
    }
    const result = await this.docker(['info'], { timeoutMs: 10_000 });
    return result.status === 0;
  }

  async containerId(config: CanvasCliConfig): Promise<string> {
    const result = await this.docker(this.composeArgs(config, ['ps', '-q', this.context.serviceName]), { timeoutMs: DOCKER_READ_TIMEOUT_MS, capture: 'exact' });
    assertDockerReadSucceeded(result);
    return result.stdout.trim();
  }

  async imageId(imageRef: string): Promise<string> {
    const inspected = await this.engine.inspectImage(imageRef);
    if (inspected !== undefined) return inspected?.id ?? '';
    const result = await this.docker(['image', 'inspect', imageRef, '--format', '{{.Id}}'], { timeoutMs: DOCKER_READ_TIMEOUT_MS, capture: 'exact' });
    assertDockerReadCompleted(result);
    return result.status === 0 ? result.stdout.trim() : '';
  }

  async containerImageId(containerId: string): Promise<string> {
    if (!containerId) return '';
    const inspected = await this.engine.inspectContainer(containerId);
    if (inspected !== undefined) return inspected?.imageId ?? '';
    const result = await this.docker(['inspect', '--format', '{{.Image}}', containerId], { timeoutMs: DOCKER_READ_TIMEOUT_MS, capture: 'exact' });
    assertDockerReadSucceeded(result);
    const inspectedImageId = result.stdout.trim();
    if (!inspectedImageId) throw new DockerEngineError('Docker CLI returned no image ID for the existing container.', 'EPROTOCOL');
    return inspectedImageId;
  }

  async pruneUnusedImages(timeoutMs?: number): Promise<void> {
    const result = await this.docker(['image', 'prune', '-af'], { stdio: 'pipe', timeoutMs });
    if (result.status !== 0) {
      console.warn(`Docker image prune completed with status ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async isContainerRunning(containerId: string): Promise<boolean> {
    if (!containerId) return false;
    const inspected = await this.engine.inspectContainer(containerId);
    if (inspected !== undefined) return inspected?.running ?? false;
    const result = await this.docker(['inspect', '--format', '{{.State.Running}}', containerId], { timeoutMs: DOCKER_READ_TIMEOUT_MS, capture: 'exact' });
    assertDockerReadCompleted(result);
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
    onAttempt?: (activity: Omit<SystemUpdateActivity, 'kind'>) => void,
  ): Promise<void> {
    const startedAt = performance.now();
    const deadline = timeoutMs === undefined ? null : Date.now() + Math.max(1, timeoutMs);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remaining = deadline === null ? 3000 : deadline - Date.now();
      if (remaining <= 0) break;
      const healthy = await this.isHealthy(config, Math.min(3000, remaining));
      onAttempt?.({
        attempt, maxAttempts, healthy,
        elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
        ...(deadline === null ? {} : { remainingMs: Math.max(0, deadline - Date.now()) }),
      });
      if (healthy) return;
      if (deadline !== null && deadline - Date.now() <= 0) break;
      await delay(deadline === null ? 1000 : Math.min(1000, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Canvas Notebook did not become healthy within ${maxAttempts}s.`);
  }

  async inspectContainer(config: CanvasCliConfig): Promise<StatusJson['container']> {
    const id = await this.containerId(config);
    if (!id) return null;
    const inspected = await this.engine.inspectContainer(id);
    if (inspected !== undefined) return inspected;
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
    const result = await this.docker(['inspect', '--format', format, id], { timeoutMs: DOCKER_READ_TIMEOUT_MS, capture: 'exact' });
    assertDockerReadCompleted(result);
    if (result.status !== 0) return null;
    try {
      return JSON.parse(result.stdout.trim()) as StatusJson['container'];
    } catch {
      return null;
    }
  }

  async imageStatus(config: CanvasCliConfig, containerId: string): Promise<StatusJson['image']> {
    const [image, container] = await Promise.all([
      this.engine.inspectImage(config.image),
      containerId ? this.engine.inspectContainer(containerId) : Promise.resolve(null),
    ]);
    if (image !== undefined && container !== undefined) {
      const [appVersion, cliVersion] = await Promise.all([
        containerId ? this.exec(containerId, ['node', '-p', "require('/app/package.json').version"], { timeoutMs: DOCKER_READ_TIMEOUT_MS, capture: 'exact', maxOutputBytes: 64 * 1024 }) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
        resolveCliVersion(),
      ]);
      assertDockerReadCompleted(appVersion);
      return {
        configuredRef: config.image,
        localId: image?.id ?? '',
        localDigest: image?.repoDigests[0] ?? '',
        localCreated: image?.created ?? '',
        runningRef: container?.image ?? '',
        runningImageId: container?.imageId ?? '',
        runningStartedAt: container?.startedAt ?? '',
        appVersion: appVersion.status === 0 ? appVersion.stdout.trim() : '',
        cliVersion,
      };
    }
    const [localId, localDigest, localCreated, runningRef, runningId, runningStartedAt, appVersion, cliVersion] = await Promise.all([
      this.docker(['image', 'inspect', config.image, '--format', '{{.Id}}'], { timeoutMs: DOCKER_READ_TIMEOUT_MS }),
      this.docker(['image', 'inspect', config.image, '--format', '{{range .RepoDigests}}{{println .}}{{end}}'], { timeoutMs: DOCKER_READ_TIMEOUT_MS }),
      this.docker(['image', 'inspect', config.image, '--format', '{{.Created}}'], { timeoutMs: DOCKER_READ_TIMEOUT_MS }),
      containerId ? this.docker(['inspect', '--format', '{{.Config.Image}}', containerId], { timeoutMs: DOCKER_READ_TIMEOUT_MS }) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.docker(['inspect', '--format', '{{.Image}}', containerId], { timeoutMs: DOCKER_READ_TIMEOUT_MS }) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.docker(['inspect', '--format', '{{.State.StartedAt}}', containerId], { timeoutMs: DOCKER_READ_TIMEOUT_MS }) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      containerId ? this.exec(containerId, ['node', '-p', "require('/app/package.json').version"], { timeoutMs: DOCKER_READ_TIMEOUT_MS, capture: 'exact', maxOutputBytes: 64 * 1024 }) : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
      resolveCliVersion(),
    ]);
    for (const result of [localId, localDigest, localCreated, runningRef, runningId, runningStartedAt, appVersion]) {
      assertDockerReadCompleted(result);
    }

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
