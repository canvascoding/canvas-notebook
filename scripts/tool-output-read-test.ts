import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((part) => part.type === 'text')?.text || '';
}

function detailsOf(result: unknown): Record<string, unknown> {
  return ((result as { details?: Record<string, unknown> }).details || {});
}

function hasUnpairedSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

async function main(): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tool-output-read-'));
  const workspaceRoot = path.join(dataDir, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });
  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@earendil-works/pi-agent-core') return {};
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    }
    if (request === '@earendil-works/pi-ai/oauth') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    const { storeToolOutput, readStoredToolOutput } = await import('../app/lib/pi/tool-output-store');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { piTools } = await import('../app/lib/pi/tool-registry');

    const identity = {
      userId: 'tool-output-read-user',
      sessionId: 'tool-output-read-session',
      organizationId: null,
      workspaceId: 'tool-output-read-workspace',
    };
    const otherIdentity = { ...identity, sessionId: 'other-session' };
    const content = [
      'Anfang — emoji 😀 — erster Abschnitt.',
      'Mitte-Marker: dieser Text muss über rg und offset lesbar bleiben.',
      'Ende — 마지막 Abschnitt — конец.',
    ].join('\n');
    const stored = await storeToolOutput({
      identity,
      toolCallId: 'read-call',
      content,
      format: 'text',
    });
    assert.equal(stored.ok, true);
    assert.match(stored.reference, /^tool-output:\/\//);
    assert.equal(stored.characters, content.length, 'characters use UTF-16 offsets');
    assert.equal(stored.complete, true);

    const full = await readStoredToolOutput(identity, stored.reference);
    assert.equal(full.content, content);
    assert.equal(full.bytes, Buffer.byteLength(content));
    assert.equal(full.sha256, stored.sha256);
    await assert.rejects(() => readStoredToolOutput(otherIdentity, stored.reference));

    const readTool = piTools.find((tool) => tool.name === 'read');
    const rgTool = piTools.find((tool) => tool.name === 'rg');
    const writeTool = piTools.find((tool) => tool.name === 'write');
    assert.ok(readTool);
    assert.ok(rgTool);
    assert.ok(writeTool);

    const context = {
      userId: identity.userId,
      sessionId: identity.sessionId,
      agentId: null,
      workspaceId: identity.workspaceId,
      workspaceType: 'personal' as const,
      workspaceName: null,
      organizationId: identity.organizationId,
      customerId: null,
      projectId: null,
      workspaceRoot,
      workspaceRootRelativePath: null,
      canWrite: true,
      canDelete: true,
      canShare: false,
      legacy: false,
    };
    const executeRead = (offset: number | null, maxChars: number) => runWithAgentExecutionContext(context, () => readTool.execute('read-saved-output', {
      path: stored.reference,
      offset,
      maxChars,
    }));

    const first = await executeRead(0, 38);
    assert.match(textOf(first), /Anfang/);
    assert.match(textOf(first), /emoji/);
    assert.equal(hasUnpairedSurrogate(textOf(first)), false);
    assert.equal(detailsOf(first).offset, 0);
    assert.equal(detailsOf(first).nextOffset, 38);
    assert.equal(detailsOf(first).eof, false);

    const middleOffset = detailsOf(first).nextOffset;
    assert.equal(typeof middleOffset, 'number');
    const middle = await executeRead(middleOffset as number, 62);
    assert.match(textOf(middle), /Mitte-Marker/);
    assert.equal(hasUnpairedSurrogate(textOf(middle)), false);
    assert.equal(detailsOf(middle).offset, middleOffset);
    assert.equal(detailsOf(middle).eof, false);

    const nextOffset = detailsOf(middle).nextOffset;
    assert.equal(typeof nextOffset, 'number');
    const last = await executeRead(nextOffset as number, 200);
    assert.match(textOf(last), /Ende/);
    assert.match(textOf(last), /конец/);
    assert.equal(hasUnpairedSurrogate(textOf(last)), false);
    assert.equal(detailsOf(last).eof, true);
    assert.equal(detailsOf(last).totalChars, content.length);
    assert.equal(detailsOf(last).sha256, stored.sha256);

    const emojiOffset = content.indexOf('😀');
    const emojiBoundary = await executeRead(emojiOffset, 1);
    assert.equal(hasUnpairedSurrogate(textOf(emojiBoundary)), false, 'a one-character window must not split an emoji pair');

    const longStored = await storeToolOutput({
      identity,
      toolCallId: 'long-read-call',
      content: '😀'.repeat(7_000),
      format: 'text',
    });
    assert.equal(longStored.ok, true);
    if (longStored.ok !== true) throw new Error('long tool output was not stored');
    const readLong = (maxChars?: number) => runWithAgentExecutionContext(context, () => readTool.execute('read-long-output', {
      path: longStored.reference,
      ...(maxChars === undefined ? {} : { maxChars }),
    }));
    const defaultBudget = await readLong();
    assert.ok(textOf(defaultBudget).length <= 6_000, 'default saved-output read budget must remain compact including metadata');
    assert.equal(hasUnpairedSurrogate(textOf(defaultBudget)), false);
    const maximumBudget = await readLong(9_600);
    assert.ok(textOf(maximumBudget).length <= 10_000, 'maximum saved-output read budget must remain bounded including metadata');
    assert.equal(hasUnpairedSurrogate(textOf(maximumBudget)), false);

    const foreignContext = { ...context, sessionId: otherIdentity.sessionId, workspaceRoot: dataDir };
    const foreignRead = await runWithAgentExecutionContext(foreignContext, () => readTool.execute('read-foreign-output', {
      path: stored.reference,
      offset: 0,
      maxChars: 40,
    }));
    assert.match(textOf(foreignRead), /Error|not found|denied|restricted|unauthorized/i);

    const writeResult = await runWithAgentExecutionContext(context, () => writeTool.execute('write-saved-output', {
      path: stored.reference,
      content: 'must not mutate saved output',
    }));
    assert.match(textOf(writeResult), /Error|restricted|read-only|not writable/i);
    assert.equal((await readStoredToolOutput(identity, stored.reference)).content, content);

    const rgResult = await runWithAgentExecutionContext(context, () => rgTool.execute('rg-saved-output', {
      pattern: 'Mitte-Marker',
      path: stored.reference,
    }));
    assert.match(textOf(rgResult), /Mitte-Marker/);
    assert.doesNotMatch(textOf(rgResult), /No files were searched/);

    const jsonStored = await storeToolOutput({
      identity,
      toolCallId: 'json-call',
      content: JSON.stringify({ unicode: '東京 😀', nested: { ok: true } }),
      format: 'json',
    });
    assert.equal(jsonStored.ok, true);
    const jsonRead = await readStoredToolOutput(identity, jsonStored.reference);
    assert.deepEqual(JSON.parse(jsonRead.content), { unicode: '東京 😀', nested: { ok: true } });

    console.log('tool-output-read-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
