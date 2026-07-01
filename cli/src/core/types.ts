export type HostPlatform = 'linux' | 'macos' | 'windows';

export type ServiceMode = 'systemd' | 'launchd' | 'scheduled-task' | 'none';

export type JsonScalar = string | number | boolean | null;

export type EnvValue = string | number | boolean | null | undefined;

export interface CliPaths {
  installDir: string;
  dataDir: string;
  configFile: string;
  composeFile: string;
  containerEnvFile: string;
  composeEnvFile: string;
  logFile: string;
}

export interface PlatformConfig {
  os: HostPlatform;
  serviceMode: ServiceMode;
}

export interface CanvasCliConfig {
  domain: string;
  image: string;
  hostPort: number;
  containerPort: number;
  dataDir: string;
  platform: PlatformConfig;
  paths: CliPaths;
  swap: {
    enabled: boolean;
    size: string;
    file: string;
  };
  autoUpdate: {
    enabled: boolean;
    schedule: string;
  };
  env: Record<string, EnvValue>;
}

export interface RuntimeContext {
  platform: HostPlatform;
  paths: CliPaths;
  serviceName: string;
  dockerBin: string;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  stdio?: 'pipe' | 'inherit';
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

export interface StatusJson {
  healthy: boolean;
  serviceActive: string;
  installDir: string;
  composeFile: string;
  dataDir: string;
  managerLog: string;
  image: {
    configuredRef: string;
    localId: string;
    localDigest: string;
    localCreated: string;
    runningRef: string;
    runningImageId: string;
    runningStartedAt: string;
    appVersion: string;
    cliVersion: string;
  };
  container: null | {
    id: string;
    name: string;
    status: string;
    running: boolean;
    restarting: boolean;
    oomKilled: boolean;
    exitCode: number;
    restartCount: number;
    image: string;
    imageId: string;
    startedAt: string;
  };
}
