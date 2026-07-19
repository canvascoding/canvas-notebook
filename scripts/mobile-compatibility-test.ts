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
