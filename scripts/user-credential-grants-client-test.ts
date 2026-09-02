import assert from 'node:assert/strict';

import { enableInteractiveUserCredentialGrant } from '@/app/lib/agent-runtime-policy/user-credential-grants-client';

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];
const grant = {
  organizationId: 'org_test',
  userId: 'user_test',
  workspaceId: 'workspace_test',
  agentId: 'agent_test',
  providerInstallationId: 'aip_0123456789abcdef01234567',
  allowedExecutionModes: ['interactive'] as const,
  status: 'active' as const,
  revision: 4,
  updatedAt: '2026-09-02T08:00:00.000Z',
};

async function main() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (requests.length === 1) {
      return Response.json({ success: true, data: { grant: { ...grant, revision: 3 } } });
    }
    return Response.json({ success: true, data: { grant } });
  }) as typeof fetch;

  try {
    const result = await enableInteractiveUserCredentialGrant({
      workspaceId: grant.workspaceId,
      agentId: grant.agentId,
      providerInstallationId: grant.providerInstallationId,
      fallbackError: 'grant failed',
    });

    assert.equal(result.revision, 4);
    assert.match(requests[0]?.url ?? '', /workspaceId=workspace_test/u);
    assert.match(requests[0]?.url ?? '', /agentId=agent_test/u);
    assert.equal(requests[1]?.url, '/api/agent-runtime/user-credential-grants');
    assert.equal(requests[1]?.init?.method, 'PUT');
    const body = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;
    assert.equal(body.expectedRevision, 3);
    assert.deepEqual(body.allowedExecutionModes, ['interactive']);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().then(() => {
  console.log('user-credential-grants-client-test: ok');
});
