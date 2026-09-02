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
      'account.preferences',
      'account.profile.read',
      'account.profile.update',
      'account.profile.avatar',
      'workspace.bootstrap',
      'license.status',
      'license.register',
      'license.activate',
      'chat.sessions',
      'chat.realtime_ticket',
      'chat.session_manage',
      'chat.attachments',
      'chat.runtime_control',
      'chat.runtime_selection',
      'browser.live_view',
      'agents.manage',
      'push.devices',
      'push.agent_response_ready',
      'push.attention_categories',
      'push.device_session_sync',
      'push.preference_updates',
      'push.automation_run_status',
      'push.receipts',
      'push.rich_previews',
      'push.app_badge',
      'notebook.documents',
      'notebook.revision_write',
      'notebook.image_import',
      'notebook.collaboration.yjs',
      'notebook.collaboration.session.v1',
      'files.browse',
      'files.sort.v1',
      'files.html_preview',
      'files.marp_preview.v1',
      'files.mutate',
      'files.excalidraw_edit',
      'files.copy',
      'files.export',
      'files.upload',
      'files.public_share',
      'inbox.feed',
      'inbox.aggregate',
      'inbox.sources',
      'inbox.categories',
      'inbox.email_attention',
      'inbox.read_state',
      'inbox.dismiss',
      'todos.read',
      'todos.write',
      'todos.follow_up',
      'studio.quick_create',
      'studio.generations',
      'studio.references',
      'studio.outputs',
      'studio.advanced_options',
      'studio.library',
      'studio.output_actions',
      'studio.library_manage',
      'studio.presets_manage',
      'studio.bulk',
      'studio.aspect_ratio',
      'studio.aspect_ratio.positioned_crop',
      'studio.aspect_ratio.canvas_frame',
      'automations.jobs',
      'automations.run_control',
      'automations.run_history',
      'automations.webhooks',
      'automations.composio_triggers',
      'extensions.store',
      'extensions.marketplace_v2',
      'integrations.composio_catalog',
      'integrations.composio_mobile_auth',
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
        'account.preferences',
        'account.profile.read',
        'account.profile.update',
        'account.profile.avatar',
        'workspace.bootstrap',
        'license.status',
        'license.register',
        'license.activate',
        'chat.sessions',
        'chat.realtime_ticket',
        'chat.session_manage',
        'chat.attachments',
        'chat.runtime_control',
        'chat.runtime_selection',
        'browser.live_view',
        'agents.manage',
        'push.devices',
        'push.agent_response_ready',
        'push.attention_categories',
        'push.device_session_sync',
        'push.preference_updates',
        'push.automation_run_status',
        'push.receipts',
        'push.rich_previews',
        'push.app_badge',
        'notebook.documents',
        'notebook.revision_write',
        'notebook.image_import',
        'notebook.collaboration.yjs',
        'notebook.collaboration.session.v1',
        'files.browse',
        'files.sort.v1',
        'files.html_preview',
        'files.marp_preview.v1',
        'files.mutate',
        'files.excalidraw_edit',
        'files.copy',
        'files.export',
        'files.upload',
        'files.public_share',
        'inbox.feed',
        'inbox.aggregate',
        'inbox.sources',
        'inbox.categories',
        'inbox.email_attention',
        'inbox.read_state',
        'inbox.dismiss',
        'todos.read',
        'todos.write',
        'todos.follow_up',
        'studio.quick_create',
        'studio.generations',
        'studio.references',
        'studio.outputs',
        'studio.advanced_options',
        'studio.library',
        'studio.output_actions',
        'studio.library_manage',
        'studio.presets_manage',
        'studio.bulk',
        'studio.aspect_ratio',
        'studio.aspect_ratio.positioned_crop',
        'studio.aspect_ratio.canvas_frame',
        'automations.jobs',
        'automations.run_control',
        'automations.run_history',
        'automations.webhooks',
        'automations.composio_triggers',
        'extensions.store',
        'extensions.marketplace_v2',
        'integrations.composio_catalog',
        'integrations.composio_mobile_auth',
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
