import assert from 'node:assert/strict';

import {
  createMobileCompatibility,
  createPublicMobileInstanceId,
} from '../app/lib/mobile/compatibility';

const rawInstanceId = 'private-control-plane-instance-id';
const publicInstanceId = createPublicMobileInstanceId(rawInstanceId);

assert.match(publicInstanceId, /^cni_[a-f0-9]{24}$/u);
assert.equal(publicInstanceId.includes(rawInstanceId), false);
assert.equal(createPublicMobileInstanceId(rawInstanceId), publicInstanceId);
assert.notEqual(createPublicMobileInstanceId('another-instance'), publicInstanceId);

const compatibility = createMobileCompatibility({
  rawInstanceId,
  instanceName: '  Customer\nNotebook  ',
  serverVersion: '2026.7.19',
  deploymentMode: 'managed-single',
});

assert.deepEqual(compatibility, {
  product: 'canvas-notebook',
  instance: {
    id: publicInstanceId,
    name: 'Customer Notebook',
    serverVersion: '2026.7.19',
    deploymentMode: 'managed-single',
  },
  mobileApi: {
    version: 'v1',
    minimumClientVersion: '0.1.0',
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
    basePath: '/api/auth',
    methods: ['email-password'],
    cookiePrefix: 'better-auth',
    expoPlugin: true,
  },
});

const fallback = createMobileCompatibility({
  rawInstanceId,
  instanceName: '\u0000\n',
  serverVersion: '',
  deploymentMode: '',
});

assert.equal(fallback.instance.name, 'Canvas Notebook');
assert.equal(fallback.instance.serverVersion, '0.0.0');
assert.equal(fallback.instance.deploymentMode, 'unknown');

console.log('mobile-compatibility-test: ok');
