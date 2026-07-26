import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createMobileCompatibility } from '../app/lib/mobile/compatibility';

const routeExports = new Map<string, string>([
  ['app/api/mobile/v1/automations/jobs/route.ts', "export { GET, POST } from '@/app/api/automations/jobs/route';"],
  ['app/api/mobile/v1/automations/jobs/[jobId]/route.ts', "export { DELETE, GET, PATCH } from '@/app/api/automations/jobs/[jobId]/route';"],
  ['app/api/mobile/v1/automations/jobs/[jobId]/runs/route.ts', "export { GET } from '@/app/api/automations/jobs/[jobId]/runs/route';"],
  ['app/api/mobile/v1/automations/jobs/[jobId]/run-now/route.ts', "export { POST } from '@/app/api/automations/jobs/[jobId]/run-now/route';"],
  ['app/api/mobile/v1/automations/jobs/[jobId]/workspace/route.ts', "export { POST } from '@/app/api/automations/jobs/[jobId]/workspace/route';"],
  ['app/api/mobile/v1/automations/runs/[runId]/route.ts', "export { GET } from '@/app/api/automations/runs/[runId]/route';"],
  ['app/api/mobile/v1/automations/runs/[runId]/logs/route.ts', "export { GET } from '@/app/api/automations/runs/[runId]/logs/route';"],
  ['app/api/mobile/v1/automations/webhooks/route.ts', "export { POST } from '@/app/api/automations/webhooks/route';"],
  ['app/api/mobile/v1/automations/webhooks/[webhookId]/secret/route.ts', "export { POST } from '@/app/api/automations/webhooks/[webhookId]/secret/route';"],
  ['app/api/mobile/v1/automations/heartbeat/route.ts', "export { GET, PUT } from '@/app/api/automations/heartbeat/route';"],
  ['app/api/mobile/v1/automations/agents/route.ts', "export { GET } from '@/app/api/agents/route';"],
  ['app/api/mobile/v1/automations/channels/route.ts', "export { GET } from '@/app/api/channels/status/route';"],
  ['app/api/mobile/v1/automations/skills/route.ts', "export { GET } from '@/app/api/skills/route';"],
  ['app/api/mobile/v1/automations/composio/apps/route.ts', "export { GET } from '@/app/api/composio/trigger-apps/route';"],
  ['app/api/mobile/v1/automations/composio/profiles/route.ts', "export { GET, POST } from '@/app/api/composio/profiles/route';"],
  ['app/api/mobile/v1/automations/composio/profiles/[profileId]/route.ts', "export { DELETE, PATCH } from '@/app/api/composio/profiles/[profileId]/route';"],
  ['app/api/mobile/v1/automations/composio/workspace-profile/route.ts', "export { DELETE, PUT } from '@/app/api/composio/workspace-profile/route';"],
  ['app/api/mobile/v1/automations/composio/connect/[toolkit]/route.ts', "export { POST } from '@/app/api/composio/connect/[toolkit]/route';"],
  ['app/api/mobile/v1/automations/composio/disconnect/[toolkit]/route.ts', "export { DELETE } from '@/app/api/composio/disconnect/[toolkit]/route';"],
  ['app/api/mobile/v1/automations/composio/refresh/[toolkit]/route.ts', "export { POST } from '@/app/api/composio/refresh/[toolkit]/route';"],
  ['app/api/mobile/v1/automations/composio/triggers/route.ts', "export { GET, POST } from '@/app/api/composio/triggers/route';"],
  ['app/api/mobile/v1/automations/composio/triggers/[triggerId]/route.ts', "export { DELETE, PATCH } from '@/app/api/composio/triggers/[triggerId]/route';"],
]);

async function main() {
  const compatibility = createMobileCompatibility({
    rawInstanceId: 'mobile-automations-test',
    instanceName: 'Automation Test',
    serverVersion: '2026.7.21',
    deploymentMode: 'managed-single',
  });
  assert.deepEqual(
    compatibility.mobileApi.capabilities.filter((capability) => capability.startsWith('automations.')),
    [
      'automations.jobs',
      'automations.run_control',
      'automations.run_history',
      'automations.heartbeat',
      'automations.webhooks',
      'automations.composio_triggers',
    ],
  );

  for (const [file, expected] of routeExports) {
    const content = (await readFile(path.resolve(process.cwd(), file), 'utf8')).trim();
    assert.equal(content, expected, `${file} must remain a versioned alias of the authorized domain route.`);
  }

  console.log('mobile-automations-test: ok');
}

void main();
