import 'server-only';

import packageJson from '@/package.json';
import type { SystemUpdateReleaseChannel } from '@/cli/src/core/systemUpdateContract';

import {
  SystemUpdateBackendError,
  type StartSystemUpdateInput,
  type SystemUpdateAvailability,
  type SystemUpdateBackend,
  type SystemUpdateOperationSnapshot,
  type SystemUpdateOperationView,
  type SystemUpdatePlatform,
  type SystemUpdateStatusAccess,
} from './types';

function detectManualPlatform(env: NodeJS.ProcessEnv): SystemUpdatePlatform {
  const configured = env.CANVAS_DEPLOYMENT_PLATFORM?.trim().toLowerCase();
  if (configured === 'coolify') return 'coolify';
  if (configured === 'docker-compose' || configured === 'compose') return 'docker-compose';
  if (configured === 'canvas-installer') return 'canvas-installer';
  if (env.COOLIFY_RESOURCE_UUID || env.COOLIFY_FQDN) return 'coolify';
  if (env.COMPOSE_PROJECT_NAME || env.DOCKER_COMPOSE) return 'docker-compose';
  return 'unknown';
}

function instructionsForPlatform(platform: SystemUpdatePlatform): string[] {
  if (platform === 'coolify') return [
    'openPlatform',
    'selectRelease',
    'verifyDeployment',
  ];
  if (platform === 'canvas-installer') return [
    'runCliUpdate',
    'verifyDeployment',
  ];
  return [
    'pullImage',
    'updateCompose',
    'recreateService',
  ];
}

export class ManualSystemUpdateBackend implements SystemUpdateBackend {
  readonly mode = 'manual' as const;
  private readonly platform: SystemUpdatePlatform;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.platform = detectManualPlatform(env);
  }

  async getAvailability(channel: SystemUpdateReleaseChannel): Promise<SystemUpdateAvailability> {
    return {
      contractVersion: 1,
      mode: this.mode,
      platform: this.platform,
      channel,
      currentVersion: packageJson.version || null,
      updateAvailable: null,
      ready: false,
      reasons: ['manual_update_required'],
      release: null,
      instructions: instructionsForPlatform(this.platform),
    };
  }

  async startUpdate(_input: StartSystemUpdateInput): Promise<SystemUpdateOperationView> {
    throw new SystemUpdateBackendError(409, 'manual_update_required', 'This installation is updated by its deployment platform.');
  }

  async getOperation(_operationId: string): Promise<SystemUpdateOperationView> {
    throw new SystemUpdateBackendError(404, 'operation_not_found', 'Update operation was not found.');
  }

  async getEvents(_operationId: string, _afterSequence: number): Promise<SystemUpdateOperationSnapshot> {
    throw new SystemUpdateBackendError(404, 'operation_not_found', 'Update operation was not found.');
  }

  async createStatusAccess(_operationId: string): Promise<SystemUpdateStatusAccess | null> {
    return null;
  }
}
