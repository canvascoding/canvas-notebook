import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { AgentToolInvocationError, assertCurrentAgentToolInvocation, captureCurrentAgentToolInvocation,
  withAgentToolInvocation, withCapturedAgentToolInvocation, type AgentToolInvocation,
  type AgentToolInvocationOrigin } from '../app/lib/pi/agent-tool-invocation';

function context(): AgentExecutionContext {
  return { userId: 'invocation-user', sessionId: 'invocation-session', agentId: 'invocation-agent',
    workspaceId: 'invocation-workspace', workspaceType: 'personal', workspaceName: null,
    organizationId: null, customerId: null, projectId: null, workspaceRoot: '/tmp/invocation-workspace',
    workspaceRootRelativePath: 'workspaces/invocation', agentTurnId: 'invocation-turn',
    legacy: false, canWrite: true, canDelete: true, canShare: true };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function invoke<T>(execution: AgentExecutionContext, operation: () => Promise<T>,
  input: { toolName: string; toolCallId: string; signal?: AbortSignal } = { toolName: 'invocation_probe', toolCallId: 'call-1' }) {
  return runWithAgentExecutionContext(execution, () => withAgentToolInvocation(execution, input, operation));
}

const errorCode = (code: AgentToolInvocationError['code']) => (error: unknown) => error instanceof AgentToolInvocationError && error.code === code;

test('ordinary execution context alone and a caller-created handle provide no invocation', async () => {
  assert.throws(captureCurrentAgentToolInvocation, errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
  const execution = context();
  await runWithAgentExecutionContext(execution, async () => {
    assert.throws(captureCurrentAgentToolInvocation, errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
    await assert.rejects(withCapturedAgentToolInvocation(Object.freeze({}) as AgentToolInvocation, async () => true),
      errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
  });
  await assert.rejects(withAgentToolInvocation(execution, { toolName: 'probe', toolCallId: 'call' }, async () => true),
    errorCode('AGENT_TOOL_INVOCATION_INVALID'));
});

test('actual invocation exposes one frozen primitive origin without permission grants', async () => {
  let held!: AgentToolInvocation;
  await invoke(context(), async () => {
    held = captureCurrentAgentToolInvocation();
    const origin = assertCurrentAgentToolInvocation(held);
    assert(Object.isFrozen(held)); assert(Object.isFrozen(origin));
    assert(Object.values(origin).every(value => value === null || ['string', 'boolean'].includes(typeof value)));
    for (const key of ['canWrite', 'canShare', 'canDelete', 'workspaceName', 'skillReadRoots', 'skillPackageBindings']) {
      assert.equal(Object.hasOwn(origin, key), false);
    }
    assert.equal(origin.toolName, 'invocation_probe'); assert.equal(origin.toolCallId, 'call-1');
    await Promise.resolve();
    assert.equal(assertCurrentAgentToolInvocation(captureCurrentAgentToolInvocation()), origin);
    assert.equal(await withCapturedAgentToolInvocation(held, async assertCurrent => {
      assert.equal(assertCurrent(), origin); await Promise.resolve(); return assertCurrent();
    }), origin);
  });
  assert.throws(() => assertCurrentAgentToolInvocation(held), errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
  await assert.rejects(withCapturedAgentToolInvocation(held, async () => true), errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
});

test('null main-agent identity, legacy contexts, optional turn and long SDK call IDs remain valid', async () => {
  const execution = { ...context(), agentId: null, legacy: true, agentTurnId: undefined, workspaceRootRelativePath: null };
  await invoke(execution, async () => {
    const origin = assertCurrentAgentToolInvocation(captureCurrentAgentToolInvocation());
    assert.equal(origin.agentId, null); assert.equal(origin.legacy, true); assert.equal(origin.agentTurnId, undefined);
    assert.equal(origin.toolCallId.length, 4096);
  }, { toolName: 'ordinary_read', toolCallId: 'x'.repeat(4096) });
  let called = false;
  await assert.rejects(invoke(context(), async () => { called = true; }, { toolName: 'probe', toolCallId: 'x'.repeat(4097) }),
    errorCode('AGENT_TOOL_INVOCATION_INVALID'));
  assert.equal(called, false);
});

test('a serialized or copied genuine handle cannot be reused', async () => {
  for (const clone of [(held: AgentToolInvocation) => ({ ...held }), (held: AgentToolInvocation) => JSON.parse(JSON.stringify(held))]) {
    await assert.rejects(invoke(context(), async () => {
      const held = captureCurrentAgentToolInvocation();
      assert.throws(() => assertCurrentAgentToolInvocation(clone(held) as AgentToolInvocation), errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
      return 'a swallowed forged-handle error is not success';
    }), errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
  }
});

test('nested actual invocations retain separate tool/call origins and restore the parent', async () => {
  await invoke(context(), async () => {
    const parent = captureCurrentAgentToolInvocation(), parentOrigin = assertCurrentAgentToolInvocation(parent);
    const childContext = { ...context(), agentTurnId: 'child-turn' };
    await invoke(childContext, async () => {
      const child = captureCurrentAgentToolInvocation();
      assert.notEqual(child, parent);
      const childOrigin = assertCurrentAgentToolInvocation(child);
      assert.equal(childOrigin.toolName, 'child_probe'); assert.equal(childOrigin.toolCallId, 'child-call');
      assert.equal(childOrigin.agentTurnId, 'child-turn');
      await withCapturedAgentToolInvocation(child, async assertCurrent => { await Promise.resolve(); assert.equal(assertCurrent(), childOrigin); });
    }, { toolName: 'child_probe', toolCallId: 'child-call' });
    assert.equal(captureCurrentAgentToolInvocation(), parent);
    assert.equal(assertCurrentAgentToolInvocation(parent), parentOrigin);
  });
});

test('a genuine parent handle is unusable in a child but does not poison the parent', async () => {
  await invoke(context(), async () => {
    const parent = captureCurrentAgentToolInvocation();
    await assert.rejects(invoke(context(), async () => {
      assert.throws(() => assertCurrentAgentToolInvocation(parent), errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
    }), errorCode('AGENT_TOOL_INVOCATION_REQUIRED'));
    assert.equal(captureCurrentAgentToolInvocation(), parent);
    assertCurrentAgentToolInvocation(parent);
  });
});

test('parallel invocation ALS origins remain separate across an actual await', async () => {
  const started = deferred(), release = deferred();
  let firstOrigin!: AgentToolInvocationOrigin;
  const first = invoke(context(), async () => {
    const held = captureCurrentAgentToolInvocation(); firstOrigin = assertCurrentAgentToolInvocation(held);
    started.resolve(); await release.promise; assert.equal(assertCurrentAgentToolInvocation(held), firstOrigin);
  });
  await started.promise;
  try {
    await invoke({ ...context(), sessionId: 'second-session' }, async () => {
      const second = assertCurrentAgentToolInvocation(captureCurrentAgentToolInvocation());
      assert.equal(second.sessionId, 'second-session'); assert.notEqual(second, firstOrigin);
    });
  } finally { release.resolve(); await first; }
});

test('mutable execution-origin drift poisons even a swallowed guard rejection', async () => {
  const execution = context();
  await assert.rejects(invoke(execution, async () => {
    const held = captureCurrentAgentToolInvocation(); execution.workspaceId = 'other-workspace';
    assert.throws(() => assertCurrentAgentToolInvocation(held), errorCode('AGENT_TOOL_INVOCATION_ORIGIN_CHANGED'));
    execution.workspaceId = 'invocation-workspace';
  }), errorCode('AGENT_TOOL_INVOCATION_ORIGIN_CHANGED'));
});

test('a changed ordinary ALS context cannot replace the active invocation origin', async () => {
  await assert.rejects(invoke(context(), async () => {
    const held = captureCurrentAgentToolInvocation();
    await runWithAgentExecutionContext({ ...context(), userId: 'other-user' }, async () => {
      assert.throws(() => assertCurrentAgentToolInvocation(held), errorCode('AGENT_TOOL_INVOCATION_ORIGIN_CHANGED'));
    });
  }), errorCode('AGENT_TOOL_INVOCATION_ORIGIN_CHANGED'));
});

test('pre-abort never invokes a tool and an ignored mid-tool abort cannot return success', async () => {
  for (const preAborted of [true, false]) {
    const controller = new AbortController(); let called = false;
    if (preAborted) controller.abort('private reason must not become an invocation message');
    const listenersBefore = getEventListeners(controller.signal, 'abort').length;
    await assert.rejects(invoke(context(), async () => {
      called = true; controller.abort('private reason must not become an invocation message'); return 'stale success';
    }, { toolName: 'probe', toolCallId: 'call', signal: controller.signal }), errorCode('AGENT_TOOL_INVOCATION_ABORTED'));
    assert.equal(called, !preAborted);
    assert.equal(getEventListeners(controller.signal, 'abort').length, listenersBefore);
  }
});

test('a swallowed registered-operation rejection remains poison with the original error identity', async () => {
  const original = new Error('operation sentinel');
  await assert.rejects(invoke(context(), async () => {
    const held = captureCurrentAgentToolInvocation();
    await assert.rejects(withCapturedAgentToolInvocation(held, async () => { throw original; }), error => error === original);
  }), error => error === original);
});

test('detached registered work is drained and cannot return either local or outer success', async () => {
  const started = deferred(), release = deferred();
  let settled = false, outerSettled = false;
  const outer = invoke(context(), async () => {
    const held = captureCurrentAgentToolInvocation();
    void withCapturedAgentToolInvocation(held, async assertCurrent => {
      started.resolve();
      try { await release.promise; assertCurrent(); return 'unconfirmed local result'; }
      finally { settled = true; }
    });
    await started.promise;
    return 'unconfirmed outer result';
  });
  void outer.then(() => { outerSettled = true; }, () => { outerSettled = true; });
  await started.promise; await Promise.resolve(); await Promise.resolve();
  assert.equal(outerSettled, false); assert.equal(settled, false);
  release.resolve();
  await assert.rejects(outer, errorCode('AGENT_TOOL_INVOCATION_DETACHED'));
  assert.equal(settled, true);
});

test('a final registered cleanup error takes priority over an earlier swallowed origin poison', async () => {
  const cleanup = new AggregateError([new Error('cleanup sentinel')], 'cleanup failed');
  const execution = context();
  await assert.rejects(invoke(execution, async () => {
    const held = captureCurrentAgentToolInvocation();
    await assert.rejects(withCapturedAgentToolInvocation(held, async assertCurrent => {
      execution.workspaceId = 'other-workspace';
      assert.throws(assertCurrent, errorCode('AGENT_TOOL_INVOCATION_ORIGIN_CHANGED'));
      execution.workspaceId = 'invocation-workspace';
      throw cleanup;
    }), error => error === cleanup);
  }), error => error === cleanup);
});

test('outer cleanup error keeps its identity after draining detached registered work', async () => {
  const started = deferred(), release = deferred();
  const cleanup = new AggregateError([new Error('rollback sentinel')], 'outer cleanup failed');
  let settled = false;
  const outer = invoke(context(), async () => {
    const held = captureCurrentAgentToolInvocation();
    void withCapturedAgentToolInvocation(held, async () => {
      started.resolve(); try { await release.promise; } finally { settled = true; }
    });
    await started.promise; throw cleanup;
  });
  const rejected = assert.rejects(outer, error => error === cleanup);
  await started.promise; assert.equal(settled, false); release.resolve();
  await rejected; assert.equal(settled, true);
});

test('a retained registered assertion closes with its own scope', async () => {
  await assert.rejects(invoke(context(), async () => {
    let retained!: () => AgentToolInvocationOrigin;
    await withCapturedAgentToolInvocation(captureCurrentAgentToolInvocation(), async assertCurrent => { retained = assertCurrent; });
    assert.throws(retained, errorCode('AGENT_TOOL_INVOCATION_CLOSED'));
  }), errorCode('AGENT_TOOL_INVOCATION_CLOSED'));
});

test('original outer primitive failures are preserved rather than turned into success', async () => {
  for (const original of [undefined, null, 0]) {
    await assert.rejects(invoke(context(), async () => { throw original; }), error => error === original);
  }
});

test('parent abort rejects an awaited child without its own signal and its local result', async () => {
  const controller = new AbortController(), started = deferred(), release = deferred();
  let localSuccess = false;
  const parent = invoke(context(), async () => invoke(context(), async () => {
    const held = captureCurrentAgentToolInvocation();
    return withCapturedAgentToolInvocation(held, async assertCurrent => {
      started.resolve(); await release.promise; assertCurrent(); localSuccess = true; return 'child result';
    });
  }), { toolName: 'parent_probe', toolCallId: 'parent-call', signal: controller.signal });
  const rejected = assert.rejects(parent, errorCode('AGENT_TOOL_INVOCATION_ABORTED'));
  try { await started.promise; controller.abort(); }
  finally { release.resolve(); await rejected; }
  assert.equal(localSuccess, false, 'An aborted parent must not leave its child authority live.');
});

test('a detached actual child wrapper is drained and neither child nor parent may succeed', async () => {
  const started = deferred(), release = deferred();
  let child!: Promise<unknown>, localSuccess = false, childSettled = false, parentSettled = false;
  const parent = invoke(context(), async () => {
    child = invoke(context(), async () => {
      const held = captureCurrentAgentToolInvocation();
      return withCapturedAgentToolInvocation(held, async assertCurrent => {
        started.resolve(); try { await release.promise; assertCurrent(); localSuccess = true; }
        finally { childSettled = true; }
      });
    });
    void child.catch(() => undefined);
    await started.promise;
    return 'parent result';
  });
  void parent.then(() => { parentSettled = true; }, () => { parentSettled = true; });
  try {
    await started.promise; await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(parentSettled, false, 'The real parent must remain pending until its detached child cleans up.');
    assert.equal(childSettled, false);
  } finally { release.resolve(); await Promise.allSettled([parent, child]); }
  await assert.rejects(parent, errorCode('AGENT_TOOL_INVOCATION_DETACHED'));
  await assert.rejects(child, errorCode('AGENT_TOOL_INVOCATION_DETACHED'));
  assert.equal(childSettled, true); assert.equal(localSuccess, false);
});

test('an inherited closed parent ALS cannot mint a new child invocation', async () => {
  const release = deferred(); let delayed!: Promise<unknown>, called = false;
  await invoke(context(), async () => {
    delayed = release.promise.then(() => invoke(context(), async () => { called = true; }));
    void delayed.catch(() => undefined);
  });
  try { release.resolve(); await assert.rejects(delayed, errorCode('AGENT_TOOL_INVOCATION_CLOSED')); }
  finally { release.resolve(); await Promise.allSettled([delayed]); }
  assert.equal(called, false);
});
