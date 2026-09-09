import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-output-search-'));
  process.env.CANVAS_DATA_ROOT = data;
  try {
    const { storeToolOutput } = await import('../app/lib/pi/tool-output-store');
    const { searchStoredToolOutput } = await import('../app/lib/pi/tool-output-search');
    const { createRipgrepTool } = await import('../app/lib/pi/web-tools');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const identity = { userId: 'owner', organizationId: null, sessionId: 'session', workspaceId: 'workspace' };
    const content = JSON.stringify({ content: '😀'.repeat(300000) + 'MIDDLE-NEEDLE' + 'a'.repeat(1200000) });
    const saved = await storeToolOutput({ identity, toolCallId: 'call', content, format: 'json' });
    if (!saved.ok) throw new Error(saved.error);
    const result = await searchStoredToolOutput(identity, saved.reference, 'middle-needle', { ignoreCase: true });
    assert.equal(result.details.matches[0].matchOffset, content.indexOf('MIDDLE-NEEDLE'));
    assert.ok(result.content[0].text.length < 1000);
    const context = { ...identity, agentId: 'agent', workspaceRoot: data, workspaceType: 'personal' as const,
      workspaceName: null, customerId: null, projectId: null, workspaceRootRelativePath: null,
      canWrite: false, canDelete: false, canShare: false, legacy: false };
    const toolResult = await runWithAgentExecutionContext(context, () => createRipgrepTool().execute('search', { pattern: 'MIDDLE-NEEDLE', path: saved.reference }));
    assert.match(JSON.stringify(toolResult.content), /MIDDLE-NEEDLE/);
    const many = await searchStoredToolOutput(identity, saved.reference, 'a', { maxResults: 200 });
    assert.equal(many.details.matches.length, 20); assert.equal(many.details.truncated, true);
    assert.ok(many.content[0].text.length < 6000);
    const greedy = await searchStoredToolOutput(identity, saved.reference, '.*');
    assert.ok(greedy.content[0].text.length < 6000, 'greedy matches never print the full JSON line');
    await assert.rejects(() => searchStoredToolOutput({ ...identity, sessionId: 'foreign' }, saved.reference, 'MIDDLE'));
    await assert.rejects(() => searchStoredToolOutput(identity, saved.reference, '['));
    await assert.rejects(() => searchStoredToolOutput(identity, saved.reference, 'a', { signal: AbortSignal.abort() }));
    console.log('tool-output-search-test: ok (2.4 MB JSON line, Unicode read offsets, bounded many/greedy matches, actual rg tool, isolation, abort)');
  } finally { await fs.rm(data, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
