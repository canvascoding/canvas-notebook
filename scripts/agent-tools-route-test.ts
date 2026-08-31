import assert from 'node:assert/strict';
import Module from 'node:module';

import { NextRequest } from 'next/server';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
const adminSession = {
  user: { id: 'tools-admin', role: 'admin' },
  session: { id: 'tools-session', userId: 'tools-admin' },
};
type TestConfig = {
  version: number;
  activeProvider: string;
  providers: Record<string, {
    id: string;
    model: string;
    thinking: string;
    enabledTools: string[];
  }>;
  updatedAt: string;
};

let config: TestConfig = {
  version: 1,
  activeProvider: 'google',
  providers: {
    google: {
      id: 'google',
      model: 'legacy-main-model',
      thinking: 'off',
      enabledTools: ['tool-a'],
    },
    openai: {
      id: 'openai',
      model: 'legacy-secondary-model',
      thinking: 'high',
      enabledTools: [],
    },
  },
  updatedAt: '2026-07-12T00:00:00.000Z',
};
const auditEvents: unknown[] = [];

function matches(request: string, suffix: string): boolean {
  return request === `@/app/lib/${suffix}` || request.endsWith(`/app/lib/${suffix}`);
}

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (matches(request, 'admin-auth')) {
    return { requireInstanceAdmin: async () => ({ ok: true, session: adminSession }) };
  }
  if (matches(request, 'auth')) {
    return { auth: { api: { getSession: async () => adminSession } } };
  }
  if (matches(request, 'audit/audit-service')) {
    return { recordAuditEvent: async (event: unknown) => { auditEvents.push(event); } };
  }
  if (matches(request, 'agents/registry')) {
    return {
      normalizeManagedAgentId: (agentId?: string | null) => {
        const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
        if (!normalized) return 'canvas-agent';
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
          throw new Error('Invalid agentId.');
        }
        return normalized;
      },
    };
  }
  if (matches(request, 'agents/access')) {
    class AgentAccessError extends Error {
      constructor(readonly status: number) {
        super('Agent access denied.');
      }
    }
    return {
      AgentAccessError,
      requireAgentAccess: async () => ({ canUse: true, canEdit: true, canManage: true }),
    };
  }
  if (matches(request, 'agents/storage')) {
    return {
      DEFAULT_MANAGED_AGENT_ID: 'canvas-agent',
      readPiRuntimeConfig: async () => structuredClone(config),
      writePiRuntimeConfig: async (next: typeof config) => {
        config = structuredClone(next);
        return structuredClone(config);
      },
    };
  }
  if (matches(request, 'agents/effective-runtime-config')) {
    return {
      resolveAgentRuntimeSettings: async (agentId: string) => ({
        agentId,
        enabledTools: [...config.providers[config.activeProvider].enabledTools],
        overrideState: { model: false, tools: false },
        isMainAgent: true,
      }),
    };
  }
  if (matches(request, 'pi/browser/settings-service')) {
    return { assertBrowserToolCanBeEnabled: async () => undefined };
  }
  if (matches(request, 'pi/tool-registry')) {
    return {
      getPiToolMetadata: async () => [
        { name: 'tool-a', label: 'Tool A', description: 'A', group: 'test' },
        { name: 'tool-b', label: 'Tool B', description: 'B', group: 'test' },
      ],
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const route = await import('../app/api/agents/tools/route');

    const getResponse = await route.GET(new NextRequest(
      'http://localhost:3000/api/agents/tools?agentId=canvas-agent',
    ));
    assert.equal(getResponse.status, 200);
    const getPayload = await getResponse.json();
    assert.deepEqual(getPayload.data.config.enabledTools, ['tool-a']);
    assert.equal('piConfig' in getPayload.data, false);
    assert.equal('discovery' in getPayload.data, false);
    assert.equal(JSON.stringify(getPayload).includes('legacy-main-model'), false);

    const patchResponse = await route.PATCH(new NextRequest(
      'http://localhost:3000/api/agents/tools',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'canvas-agent', enabledTools: ['tool-b'] }),
      },
    ));
    assert.equal(patchResponse.status, 200);
    assert.deepEqual(config.providers.google.enabledTools, ['tool-b']);
    assert.equal(config.activeProvider, 'google');
    assert.equal(config.providers.google.model, 'legacy-main-model');
    assert.equal(config.providers.openai.model, 'legacy-secondary-model');
    const patchPayload = await patchResponse.json();
    assert.deepEqual(patchPayload.data.config.enabledTools, ['tool-b']);
    assert.equal(JSON.stringify(patchPayload).includes('legacy-main-model'), false);
    assert.equal(auditEvents.length, 1);

    const unknownToolResponse = await route.PATCH(new NextRequest(
      'http://localhost:3000/api/agents/tools',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'canvas-agent', enabledTools: ['unknown-tool'] }),
      },
    ));
    assert.equal(unknownToolResponse.status, 400);
    assert.deepEqual(config.providers.google.enabledTools, ['tool-b']);

    const customAgentResponse = await route.PATCH(new NextRequest(
      'http://localhost:3000/api/agents/tools',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'research-agent', enabledTools: ['tool-a'] }),
      },
    ));
    assert.equal(customAgentResponse.status, 400);

    const invalidAgentResponse = await route.PATCH(new NextRequest(
      'http://localhost:3000/api/agents/tools',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: '../invalid', enabledTools: ['tool-a'] }),
      },
    ));
    assert.equal(invalidAgentResponse.status, 400);

    console.log('agent-tools-route-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
