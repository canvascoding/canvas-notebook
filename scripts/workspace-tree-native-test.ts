import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runWithAgentExecutionContext } from '../app/lib/pi/agent-execution-context';

test('the real native ls tool exposes the same bounded tree and continuation contract', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tree-native-'));
  try {
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
    const first = await run({ path: '.', max_depth: 0, max_entries: 1 });
    const data = first.details as { entries: Array<{ path: string }>; next_cursor: string };
    assert.equal(data.entries[0].path, 'a.md');
    assert.ok(data.next_cursor);
    const second = await run({ path: '.', max_depth: 0, max_entries: 1, cursor: data.next_cursor });
    assert.equal((second.details as { entries: Array<{ path: string }> }).entries[0].path, 'b.md');
    assert.ok(second.content.some(part => part.type === 'text' && part.text.includes('b.md')));
    const outside = await run({ path: '..', max_depth: 0 });
    assert.ok((outside.details as { error?: string }).error);
  } finally { await fs.rm(rootPath, { recursive: true, force: true }); }
});
