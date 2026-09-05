import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-compaction-status-'));
process.env.DATA = dataDir;
const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  }
  if (request.endsWith('/session-compaction-coordinator')) {
    return {
      getActivePiSessionCompaction: () => null,
      runPiSessionCompaction: async () => { throw new Error('Injected compaction store failure'); },
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { LivePiRuntime } = await import('../app/lib/pi/live-runtime');
  for (const kind of ['manual', 'automatic'] as const) {
    const states: string[] = [];
    const runtime = Object.create(LivePiRuntime.prototype) as Record<string, unknown>;
    Object.assign(runtime, {
      sessionId: 'failure-test', provider: 'test', model: { id: 'test' }, options: {},
      summary: { summaryText: null, summaryRevision: 0, summaryThroughSequence: null },
      getCompactionScope: () => ({ sessionId: 'failure-test', userId: 'test', agentId: 'test', workspaceId: 'test' }),
      persistMessages: async () => undefined,
      createCompactionGeneration: () => 'generation',
      getEffectiveSystemPrompt: () => '', getEffectiveTools: () => [],
      composeHistory: () => ({ estimatedHistoryTokens: 1, estimatedHistoryBytes: 1, triggerHistoryTokens: 100, targetHistoryTokens: 20 }),
      publishStatus: () => states.push((runtime.compactionStatus as { state: string }).state),
    });
    await assert.rejects((runtime as {
      coordinateCompaction: (input: unknown) => Promise<unknown>;
    }).coordinateCompaction({ kind, cause: kind === 'manual' ? 'manual' : 'threshold', messages: [], additionalContextTokens: 0, runtimeContext: null }), /Injected compaction store failure/);
    assert.deepEqual(states, ['running', 'failed']);
    assert.equal((runtime.compactionStatus as { reasonCode: string }).reasonCode, 'compaction_error');
    assert.equal((runtime.summary as { summaryText: string | null }).summaryText, null);
  }
  console.log('Compaction store failures publish a terminal status for manual and automatic attempts.');
}

void main().finally(() => {
  loader._load = originalLoad;
  rmSync(dataDir, { recursive: true, force: true });
}).catch((error) => { console.error(error); process.exitCode = 1; });
