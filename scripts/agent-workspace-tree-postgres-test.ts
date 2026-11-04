import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
async function main() {
  await withDocumentReadToolDispatchFixture(async h => {
    await h.setPiEnabledTools(['ls']);
    const { getPiTools, piTools } = await import('../app/lib/pi/tool-registry');
    const { validateToolArguments } = await import('@earendil-works/pi-ai');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const { resolveAgentRuntimeTempDir } = await import('../app/lib/pi/agent-runtime-temp');
    const registered = (await getPiTools('reader', h.agentId, h.piSessionId,
      { strictAuthorization: true, metadataOnlyExternal: true })).find(tool => tool.name === 'ls');
    assert(registered); const raw = piTools.find(tool => tool.name === 'ls'); assert(raw && raw !== registered);
    const invoke = async (tool: AgentTool, args: Record<string, unknown>) => {
      const id = `agent-tree-${crypto.randomUUID()}`, prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
      const validated = validateToolArguments(tool, { type: 'toolCall', id, name: 'ls',
        arguments: prepared as Parameters<typeof validateToolArguments>[1]['arguments'] });
      return tool.execute(id, validated);
    };
    const page = (out: AgentToolResult<unknown>) => {
      if (Reflect.get(out, 'isError') === true) {
        const error = Reflect.get(out.details as object, 'error');
        console.error(JSON.stringify({ suite: 'agent-workspace-tree-public-error', stage,
          error: typeof error === 'string' ? error.slice(0, 240) : 'Missing public error.' }));
      }
      assert.notEqual(Reflect.get(out, 'isError'), true);
      const result = out.details as { entries: { path: string; type: string }[]; files: { path: string }[];
        has_more: boolean; next_cursor: string | null; truncated: boolean };
      assert(Array.isArray(result.entries) && Array.isArray(result.files));
      assert.deepEqual(result.files.map(file => file.path), result.entries.map(entry => entry.path));
      return result;
    };
    const denied = async (operation: () => Promise<AgentToolResult<unknown>>) => {
      try { const out = await operation(); assert.equal(Reflect.get(out, 'isError'), true);
        assert.equal(Reflect.get(out.details as object, 'entries'), undefined); }
      catch (error) { if (error instanceof assert.AssertionError) throw error; }
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); groups++; console.log(JSON.stringify({ suite: 'agent-workspace-tree-group', name, passed: true }));
    };
    const native = await h.seed({ filePath: 'logical/cafe\u0301 😀.md', text: 'Native only; no projection.' });
    await assert.rejects(fs.stat(path.join(h.workspaceRoot, native.filePath)), { code: 'ENOENT' });
    await fs.writeFile(path.join(h.workspaceRoot, 'physical.txt'), 'Physical file.');
    await fs.mkdir(path.join(h.workspaceRoot, 'physical-folder'));
    await fs.writeFile(path.join(h.workspaceRoot, '.hidden.txt'), 'Do not disclose.');
    let snapshot = await h.snapshot();
    await check('real registry plain and bounded ls include logical native-only folders and files without writing a projection', async () => {
      const root = page(await invoke(registered, {}));
      assert.deepEqual(root.entries.map(entry => entry.path), ['logical', 'physical-folder', 'physical.txt']);
      const logical = page(await invoke(registered, { path: 'logical' }));
      assert.deepEqual(logical.entries.map(entry => entry.path), [native.filePath]);
      const tree = page(await invoke(registered, { path: '.', max_depth: 2, max_entries: 20 }));
      assert(tree.entries.some(entry => entry.path === native.filePath));
      assert.deepEqual(await h.snapshot(), snapshot);
      await assert.rejects(fs.stat(path.join(h.workspaceRoot, native.filePath)), { code: 'ENOENT' });
    });
    await check('pagination preserves every namespace entry and a real native catalogue change invalidates the old cursor', async () => {
      const first = page(await invoke(registered, { max_depth: 2, max_entries: 1 })); assert(first.next_cursor);
      const found = first.entries.map(entry => entry.path); let cursor: string | null = first.next_cursor;
      while (cursor) {
        const next = page(await invoke(registered, { max_depth: 2, max_entries: 1, cursor }));
        found.push(...next.entries.map(entry => entry.path)); cursor = next.next_cursor;
      }
      assert.equal(new Set(found).size, found.length); assert(found.includes(native.filePath));
      await h.seed({ filePath: 'new-native.md', text: 'Invalidate the captured namespace.' }); snapshot = await h.snapshot();
      await denied(() => invoke(registered, { max_depth: 2, max_entries: 1, cursor: first.next_cursor }));
      assert.deepEqual(await h.snapshot(), snapshot);
    });
    await check('logical directories work through a real root alias while hidden and internal alias paths remain unavailable', async () => {
      if (h.workspaceRoot.startsWith('/private/')) {
        stage = 'root_alias';
        const alias = h.workspaceRoot.slice('/private'.length);
        assert.equal(await fs.realpath(alias), await fs.realpath(h.workspaceRoot));
        assert.deepEqual(page(await invoke(registered, { path: `${alias}/logical` })).entries.map(entry => entry.path), [native.filePath]);
      }
      await fs.symlink(path.join(h.workspaceRoot, 'physical-folder'), path.join(h.workspaceRoot, 'internal-alias'));
      try {
        stage = 'internal_alias';
        await denied(() => invoke(registered, { path: 'internal-alias' }));
        stage = 'hidden_path';
        await denied(() => invoke(registered, { path: '.hidden.txt' }));
      } finally { await fs.unlink(path.join(h.workspaceRoot, 'internal-alias')); }
      stage = 'alias_snapshot';
      assert.deepEqual(await h.snapshot(), snapshot);
    });
    await check('a native/physical name conflict fails closed instead of returning the physical-only fallback', async () => {
      await fs.writeFile(path.join(h.workspaceRoot, 'logical'), 'A physical file conflicts with the native logical folder.');
      try { await denied(() => invoke(registered, {})); assert.deepEqual(await h.snapshot(), snapshot); }
      finally { await fs.unlink(path.join(h.workspaceRoot, 'logical')); }
    });
    await check('authorized session temp remains bounded and foreign data directories remain denied', async () => {
      const context = await resolveAgentExecutionContextForSession({ userId: 'reader', sessionId: h.piSessionId, agentId: h.agentId });
      const temporary = resolveAgentRuntimeTempDir(context); await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(temporary, 'temp-a.txt'), 'Temp A.'); await fs.writeFile(path.join(temporary, 'temp-b.txt'), 'Temp B.');
      const first = page(await invoke(registered, { path: temporary, max_entries: 1 })); assert(first.next_cursor);
      const next = page(await invoke(registered, { path: temporary, max_entries: 1, cursor: first.next_cursor }));
      assert.deepEqual([...first.entries, ...next.entries].map(entry => entry.path), ['temp-a.txt', 'temp-b.txt']);
      await denied(() => invoke(registered, { path: h.dataRoot }));
      await denied(() => runWithAgentExecutionContext(context, () => invoke(raw, {})));
      assert.deepEqual(await h.snapshot(), snapshot);
    });
    await check('current user denial after tool creation exposes no namespace and a restored user can read', async () => {
      await h.admin.query('UPDATE "user" SET banned=1 WHERE id=$1', ['reader']);
      try { await denied(() => invoke(registered, {})); assert.deepEqual(await h.snapshot(), snapshot); }
      finally { await h.admin.query('UPDATE "user" SET banned=0 WHERE id=$1', ['reader']); }
      assert(page(await invoke(registered, {})).entries.some(entry => entry.path === 'new-native.md'));
    });
    await check('revocation after an actual directory read denies the prepared page at the fresh final authorization', async () => {
      const original = fs.readdir; let armed = true, nativeProducerObserved = false;
      fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
        const result = await Reflect.apply(original, fs, args);
        if (armed && String(args[0]) === h.workspaceRoot && /buildFileTree/u.test(new Error().stack ?? '')) {
          nativeProducerObserved = true; armed = false;
          await h.admin.query('UPDATE "user" SET banned=1 WHERE id=$1', ['reader']);
        }
        return result;
      }) as typeof fs.readdir;
      try { await denied(() => invoke(registered, {})); assert.equal(armed, false); assert.equal(nativeProducerObserved, true);
        assert.deepEqual(await h.snapshot(), snapshot); }
      finally { fs.readdir = original; await h.admin.query('UPDATE "user" SET banned=0 WHERE id=$1', ['reader']); }
      assert(page(await invoke(registered, {})).entries.some(entry => entry.path === native.filePath.split('/')[0]));
    });
    assert.deepEqual(await h.snapshot(), snapshot); complete = true;
    console.log(JSON.stringify({ suite: 'agent-native-workspace-tree', passed: true, groups,
      actualRegistryAndInvocation: true, actualCurrentUserRevocation: true, fakeContextAuthorizes: false,
      nativeOnlyIncluded: true, physicalFallbackAfterNativeError: false, nativeRowsAndProjectionUnchanged: true }));
  });
}
main().catch(error => { process.exitCode = 1;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : undefined;
  const assertion = error instanceof assert.AssertionError ? { operator: error.operator,
    actual: typeof error.actual === 'boolean' || error.actual === null ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'boolean' || error.expected === null ? error.expected : typeof error.expected } : undefined;
  console.error(JSON.stringify({ suite: 'agent-native-workspace-tree', stage, error: error instanceof Error ? error.name : 'UnknownError', code, assertion })); });
