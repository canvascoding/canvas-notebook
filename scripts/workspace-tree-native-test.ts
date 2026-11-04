import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runWithAgentExecutionContext } from '../app/lib/pi/agent-execution-context';

test('an ambient execution context alone cannot authorize native ls; genuine positive coverage runs on owned PostgreSQL', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tree-native-'));
  const loader = Module as typeof Module & {
    _load: (name: string, parent: NodeModule | null, main: boolean) => unknown;
  };
  const originalLoad = loader._load;
  const actualEsm = new Map<string, unknown>();
  try {
    // The SDK exposes ESM-only entry points; tsx loads application .ts files as CJS.
    // Bridge the actual namespaces without mocking the native tool or its dependencies.
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) {
      actualEsm.set(name, await import(name));
    }
    loader._load = (name, parent, isMain) => actualEsm.has(name) ? actualEsm.get(name) : originalLoad(name, parent, isMain);
    const { piTools } = await import('../app/lib/pi/core-tools');
    await fs.writeFile(path.join(rootPath, 'a.md'), '# A');
    await fs.writeFile(path.join(rootPath, 'b.md'), '# B');
    const ls = piTools.find(tool => tool.name === 'ls')!;
    assert.ok(ls);
    const run = (args: Record<string, unknown>) => runWithAgentExecutionContext({
      userId: 'tree-user', sessionId: 'tree-session', agentId: null,
      workspaceId: 'native-tree', workspaceType: 'personal', workspaceName: 'Tree',
      organizationId: null, customerId: null, projectId: null, workspaceRoot: rootPath,
      workspaceRootRelativePath: null, canWrite: false, canDelete: false, canShare: false, legacy: false,
    }, () => ls.execute('native-tree', args));
    for (const args of [{}, { path: '.', max_depth: 0, max_entries: 1 }]) {
      const denied = await run(args);
      assert.equal(Reflect.get(denied, 'isError'), true);
      assert.equal(Reflect.get(denied.details as object, 'entries'), undefined);
      assert.equal(Reflect.get(denied.details as object, 'files'), undefined);
      assert.ok(!(denied.content ?? []).some(part => part.type === 'text' && /a\.md|b\.md/u.test(part.text)));
    }
    const outside = await run({ path: '..', max_depth: 0 });
    assert.ok((outside.details as { error?: string }).error);
  } finally {
    loader._load = originalLoad;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
