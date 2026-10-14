import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withMarkdownCreateBirthClaim } from '../app/lib/files/markdown-create-birth';
import { assertAuthenticatedManualMarkdownBirthStorageAllowed, assertAuthenticatedManualMarkdownBirthWithinTurn } from '../app/lib/collaboration/markdown-file-import-persistence';

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'canvas-manual-entry-'));
  const previous = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT };
  Object.assign(process.env, { DATA: root, CANVAS_DATA_ROOT: root });
  const operationId = `manual-create:${randomUUID()}`;
  const origin = { workspaceId: 'own-space', userId: 'own-user', sessionId: 'own-session' };
  const source = { kind: 'manual-empty-v1', workspaceId: origin.workspaceId, targetPath: 'not-authorized.md',
    actorUserId: origin.userId, actorSessionId: origin.sessionId, requestId: operationId, operationId,
    sourceHash: createHash('sha256').update('').digest('hex'), sourceBytes: 0 };
  const input = { workspaceRoot: root, targetPath: source.targetPath, origin, source, operationId };
  let callbacks = 0;
  const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && Reflect.get(error, 'code') === expected;
  const rejected = async (value: typeof input, expected: string) => {
    await assert.rejects(withMarkdownCreateBirthClaim(value, async () => { callbacks++; }, async claim => {
      callbacks++; await claim.publish('', async () => { callbacks++; }, () => { callbacks++; });
    }), code(expected));
    assert.deepEqual(await readdir(root), [], 'A free manual record cannot initialize even a private store/claim.');
    assert.equal(callbacks, 0);
  };
  try {
    await rejected(input, 'MARKDOWN_IMPORT_INVALID_INPUT');
    await rejected({ ...input, source: { ...source, kind: 'unknown' } }, 'MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    await rejected({ ...input, source: { ...source, extra: 'untrusted' } } as typeof input, 'MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    await rejected({ ...input, source: { ...source, sourceBytes: 1 } }, 'MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    await rejected({ ...input, source: { ...source, sourceHash: '0'.repeat(64) } }, 'MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    let getterReads = 0;
    const flip = { ...input };
    Object.defineProperty(flip, 'source', { enumerable: true, get: () => { getterReads++; return getterReads === 1 ? undefined : source; } });
    await rejected(flip, 'MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    assert.equal(getterReads, 0, 'The mechanical entry must reject an accessor without evaluating it.');
    await assert.rejects(assertAuthenticatedManualMarkdownBirthStorageAllowed(input, 'entry'), code('MARKDOWN_IMPORT_INVALID_INPUT'));
    await assert.rejects(assertAuthenticatedManualMarkdownBirthStorageAllowed(input, 'parent_link'), code('MARKDOWN_IMPORT_INVALID_INPUT'));
    assert.throws(() => assertAuthenticatedManualMarkdownBirthWithinTurn(input), code('MARKDOWN_IMPORT_INVALID_INPUT'));
    assert.deepEqual(await readdir(root), []);
    console.log('Manual Markdown Birth entry: 9 genuine free-record/accessor/closed-context boundaries; no Auth/PG/host.');
  } finally {
    for (const key of ['DATA', 'CANVAS_DATA_ROOT'] as const) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
