import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

function getDetails<T>(result: unknown): T {
  return (result as { details: T }).details;
}

type DelegateTaskRequest = {
  userId: string;
  sourceAgentId: string;
  targetAgentId: string;
  goal: string;
  context?: string;
  sessionId?: string;
  waitForResult: boolean;
  timeoutSeconds: number;
};

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-delegate-task-'));
  process.env.DATA = dataDir;

  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { db } = await import('../app/lib/db');
    const { user } = await import('../app/lib/db/schema');
    const { createAgentProfile } = await import('../app/lib/agents/registry');
    const { createDelegateTaskTool } = await import('../app/lib/pi/delegate-task-tool');
    const { buildPiToolRegistry, getPiTools } = await import('../app/lib/pi/tool-registry');

    const now = new Date('2026-05-28T10:00:00.000Z');
    await db.insert(user).values({
      id: 'user-1',
      name: 'User One',
      email: 'user1@example.test',
      emailVerified: true,
      image: null,
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await createAgentProfile({
      name: 'Research Agent',
      agentId: 'research-agent',
      defaultProvider: 'test-provider',
      defaultModel: 'test-model',
      defaultThinking: 'off',
      enabledTools: [],
    });

    const calls: DelegateTaskRequest[] = [];
    const tool = createDelegateTaskTool({
      userId: 'user-1',
      sourceAgentId: 'canvas-agent',
      startDelegatedRunFn: async (request) => {
        calls.push(request);
        return {
          status: request.waitForResult ? 'ok' : 'accepted',
          source_agent_id: request.sourceAgentId,
          target_agent_id: request.targetAgentId,
          session_id: request.sessionId || 'sess-child',
          wait_for_result: request.waitForResult,
          timeout_seconds: request.timeoutSeconds,
          reply: request.waitForResult ? 'research reply' : undefined,
        };
      },
    });

    const accepted = await tool.execute('delegate', {
      target_agent_id: 'Research-Agent',
      goal: 'Find the deployment notes',
      context: 'Look only at the docs folder',
      wait_for_result: false,
    });
    assert.match(getText(accepted), /accepted by research-agent/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].targetAgentId, 'research-agent');
    assert.equal(calls[0].waitForResult, false);
    assert.equal(calls[0].context, 'Look only at the docs folder');
    assert.equal(calls[0].timeoutSeconds, 120);

    const completed = await tool.execute('delegate-wait', {
      target_agent_id: 'research-agent',
      goal: 'Summarize the deployment notes',
      timeout_seconds: 5,
    });
    assert.match(getText(completed), /research reply/);
    assert.equal(calls[1].waitForResult, true);
    assert.equal(calls[1].timeoutSeconds, 5);
    assert.equal(getDetails<{ status: string }>(completed).status, 'ok');

    const selfResult = await tool.execute('delegate-self', {
      target_agent_id: 'canvas-agent',
      goal: 'Loop',
    });
    assert.match(getText(selfResult), /requires a different target_agent_id/);

    const nonMainTool = createDelegateTaskTool({
      userId: 'user-1',
      sourceAgentId: 'research-agent',
      startDelegatedRunFn: async () => {
        throw new Error('should not dispatch');
      },
    });
    assert.match(
      getText(await nonMainTool.execute('non-main', { target_agent_id: 'canvas-agent', goal: 'Try recursion' })),
      /Only the main Canvas Agent can use delegate_task/,
    );

    const missingUserTool = createDelegateTaskTool({ sourceAgentId: 'canvas-agent' });
    assert.match(
      getText(await missingUserTool.execute('missing-user', { target_agent_id: 'research-agent', goal: 'No user' })),
      /User ID is required/,
    );

    const mainRegistryTools = buildPiToolRegistry('user-1', 'canvas-agent');
    const childTools = await getPiTools('user-1', 'research-agent');
    assert.equal(mainRegistryTools.some((mainTool) => mainTool.name === 'delegate_task'), true);
    assert.equal(childTools.some((childTool) => childTool.name === 'delegate_task'), false);
    assert.equal(childTools.some((childTool) => childTool.name === 'session_search'), true);

    console.log('pi-delegate-task-tool-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
