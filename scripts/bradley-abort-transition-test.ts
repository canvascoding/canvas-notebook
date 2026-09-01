import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  isRuntimeStatusStale,
  type RuntimeStatus,
} from '../app/lib/chat/runtime-status';

const streamingStatus: RuntimeStatus = {
  sessionId: 'abort-transition-session',
  revision: 7,
  phase: 'streaming',
  activeTool: null,
  pendingToolCalls: 0,
  followUpQueue: [],
  steeringQueue: [],
  canAbort: true,
  contextWindow: 10_000,
  estimatedHistoryTokens: 100,
  availableHistoryTokens: 9_000,
  contextUsagePercent: 1,
  includedSummary: false,
  omittedMessageCount: 0,
  summaryUpdatedAt: null,
  lastCompactionAt: null,
  lastCompactionKind: null,
  lastCompactionOmittedCount: 0,
};

function main(): void {
  const optimisticAbort: RuntimeStatus = {
    ...streamingStatus,
    optimistic: true,
    phase: 'aborting',
  };

  assert.equal(
    isRuntimeStatusStale(optimisticAbort, { ...streamingStatus, revision: 8 }),
    true,
  );
  assert.equal(
    isRuntimeStatusStale(optimisticAbort, {
      ...streamingStatus,
      revision: 8,
      phase: 'running_tool',
      activeTool: { toolCallId: 'tool-1', name: 'read_file' },
    }),
    true,
  );
  assert.equal(
    isRuntimeStatusStale(optimisticAbort, {
      ...streamingStatus,
      revision: 8,
      phase: 'aborting',
    }),
    false,
  );
  assert.equal(
    isRuntimeStatusStale(optimisticAbort, {
      ...streamingStatus,
      revision: 8,
      phase: 'idle',
      canAbort: false,
    }),
    false,
  );
  assert.equal(
    isRuntimeStatusStale(optimisticAbort, {
      ...streamingStatus,
      sessionId: 'another-session',
      revision: 1,
    }),
    false,
  );

  const controlSource = readFileSync(
    path.join(
      process.cwd(),
      'app/components/canvas-agent-chat/useChatControlActions.ts',
    ),
    'utf8',
  );
  const handleStopSource = controlSource.slice(
    controlSource.indexOf('const handleStop = useCallback'),
    controlSource.indexOf('const handleEditQueuedMessage = useCallback'),
  );
  assert.ok(handleStopSource.includes("setOptimisticRuntimePhase('aborting', targetSessionId)"));
  assert.ok(
    handleStopSource.indexOf("setOptimisticRuntimePhase('aborting', targetSessionId)")
      < handleStopSource.indexOf("await postControl(targetSessionId, 'abort')"),
  );
  assert.ok(handleStopSource.includes("setOptimisticRuntimePhase(runtimePhase ?? 'idle', targetSessionId)"));

  console.log('bradley-abort-transition-test: ok');
}

main();
