import 'server-only';

import { createHash } from 'node:crypto';

export const MOBILE_API_VERSION = 'v1' as const;
export const MINIMUM_MOBILE_CLIENT_VERSION = '0.1.0' as const;
export const MOBILE_AUTH_BASE_PATH = '/api/auth' as const;

export type MobileCompatibility = {
  product: 'canvas-notebook';
  instance: {
    id: string;
    name: string;
    serverVersion: string;
    deploymentMode: string;
  };
  mobileApi: {
    version: typeof MOBILE_API_VERSION;
    minimumClientVersion: typeof MINIMUM_MOBILE_CLIENT_VERSION;
    capabilities: [
      'auth.email_password',
      'workspace.bootstrap',
      'chat.sessions',
      'chat.realtime_ticket',
      'push.devices',
      'push.agent_response_ready',
      'push.attention_categories',
      'push.receipts',
      'notebook.documents',
      'notebook.revision_write',
      'files.browse',
      'files.mutate',
      'files.upload',
      'files.public_share',
      'inbox.feed',
      'inbox.read_state',
      'todos.read',
      'todos.write',
      'todos.follow_up',
      'studio.quick_create',
      'studio.generations',
      'studio.references',
      'studio.outputs',
    ];
  };
  auth: {
    provider: 'better-auth';
    basePath: typeof MOBILE_AUTH_BASE_PATH;
    methods: ['email-password'];
    cookiePrefix: 'better-auth';
    expoPlugin: true;
  };
};

function normalizePublicText(value: string | undefined, fallback: string, maximumLength: number): string {
  const normalized = value?.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maximumLength) : fallback;
}

export function createPublicMobileInstanceId(rawInstanceId: string): string {
  const digest = createHash('sha256').update(rawInstanceId).digest('hex').slice(0, 24);
  return `cni_${digest}`;
}

export function createMobileCompatibility(input: {
  rawInstanceId: string;
  instanceName?: string;
  serverVersion: string;
  deploymentMode: string;
}): MobileCompatibility {
  return {
    product: 'canvas-notebook',
    instance: {
      id: createPublicMobileInstanceId(input.rawInstanceId),
      name: normalizePublicText(input.instanceName, 'Canvas Notebook', 80),
      serverVersion: normalizePublicText(input.serverVersion, '0.0.0', 40),
      deploymentMode: normalizePublicText(input.deploymentMode, 'unknown', 40),
    },
    mobileApi: {
      version: MOBILE_API_VERSION,
      minimumClientVersion: MINIMUM_MOBILE_CLIENT_VERSION,
      capabilities: [
        'auth.email_password',
        'workspace.bootstrap',
        'chat.sessions',
        'chat.realtime_ticket',
        'push.devices',
        'push.agent_response_ready',
        'push.attention_categories',
        'push.receipts',
        'notebook.documents',
        'notebook.revision_write',
        'files.browse',
        'files.mutate',
        'files.upload',
        'files.public_share',
        'inbox.feed',
        'inbox.read_state',
        'todos.read',
        'todos.write',
        'todos.follow_up',
        'studio.quick_create',
        'studio.generations',
        'studio.references',
        'studio.outputs',
      ],
    },
    auth: {
      provider: 'better-auth',
      basePath: MOBILE_AUTH_BASE_PATH,
      methods: ['email-password'],
      cookiePrefix: 'better-auth',
      expoPlugin: true,
    },
  };
}
