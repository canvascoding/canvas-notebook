import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'canvas-community-token-storage-'));
const previousData = process.env.DATA;
const previousInstanceId = process.env.CANVAS_INSTANCE_ID;
process.env.DATA = tempRoot;

const initialToken = `cinst_initial_${'a'.repeat(48)}`;
const rotatedToken = `cinst_rotated_${'b'.repeat(48)}`;
const concurrentToken = `cinst_concurrent_${'c'.repeat(48)}`;
const wrongToken = `cinst_wrong_${'d'.repeat(48)}`;
const instanceId = 'self_79acda7f-90c8-49e3-8f3f-3e2d0a06a2aa';
process.env.CANVAS_INSTANCE_ID = instanceId;

async function modeOf(targetPath: string): Promise<number> {
  return (await fs.stat(targetPath)).mode & 0o777;
}

async function main(): Promise<void> {
  const storage = await import('../app/lib/license/storage');
  const {
    CommunityInstanceTokenStorageError,
    communityInstanceTokenPrefix,
    getCommunityInstanceTokenStatus,
    loadCommunityInstanceToken,
    removeCommunityInstanceToken,
    resolveCommunityInstanceTokenPath,
    rotateCommunityInstanceToken,
    saveCommunityInstanceToken,
  } = storage;

  const filePath = resolveCommunityInstanceTokenPath();
  assert.equal(filePath, path.join(tempRoot, 'secrets', 'license', 'community-instance-token.json'));

  const logged: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.info = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));

  try {
    const initialStatus = await saveCommunityInstanceToken({
      instanceId,
      instanceToken: initialToken,
      tokenType: 'Bearer',
      scopes: ['seat:snapshot', 'license:refresh', 'token:rotate'],
      expiresAt: '2030-08-01T00:00:00.000Z',
      now: new Date('2026-08-01T10:00:00.000Z'),
    });
    assert.equal(initialStatus.configured, true);
    assert.equal(initialStatus.tokenPrefix, communityInstanceTokenPrefix(initialToken));
    assert.equal(initialStatus.generation, 1);
    assert.equal(JSON.stringify(initialStatus).includes(initialToken), false);
    assert.equal(initialStatus.tokenPrefix?.endsWith('…'), true);
    assert.ok((initialStatus.tokenPrefix?.length || 0) < initialToken.length);
    await assert.rejects(
      loadCommunityInstanceToken('self_00000000-0000-4000-8000-000000000000'),
      (error: unknown) => (
        error instanceof CommunityInstanceTokenStorageError
        && error.code === 'TOKEN_INSTANCE_MISMATCH'
      ),
    );

    assert.equal(await modeOf(path.join(tempRoot, 'secrets')), 0o700);
    assert.equal(await modeOf(path.dirname(filePath)), 0o700);
    assert.equal(await modeOf(filePath), 0o600);

    const loaded = await loadCommunityInstanceToken(instanceId);
    assert.equal(loaded?.instanceToken, initialToken);
    assert.deepEqual(loaded?.scopes, ['license:refresh', 'seat:snapshot', 'token:rotate']);

    const idempotentStatus = await saveCommunityInstanceToken({
      instanceId,
      instanceToken: initialToken,
      tokenType: 'Bearer',
      scopes: ['token:rotate', 'seat:snapshot', 'license:refresh'],
      expiresAt: '2030-08-01T00:00:00.000Z',
      now: new Date('2026-08-01T10:01:00.000Z'),
    });
    assert.equal(idempotentStatus.generation, 1);
    assert.equal(idempotentStatus.updatedAt, '2026-08-01T10:00:00.000Z');

    await assert.rejects(
      rotateCommunityInstanceToken({
        instanceId,
        previousToken: wrongToken,
        instanceToken: rotatedToken,
        tokenType: 'Bearer',
        scopes: ['seat:snapshot', 'license:refresh', 'token:rotate'],
        expiresAt: '2031-08-01T00:00:00.000Z',
      }),
      (error: unknown) => (
        error instanceof CommunityInstanceTokenStorageError
        && error.code === 'TOKEN_ROTATION_CONFLICT'
      ),
    );
    assert.equal((await loadCommunityInstanceToken(instanceId))?.instanceToken, initialToken);

    const rotatedStatus = await rotateCommunityInstanceToken({
      instanceId,
      previousToken: initialToken,
      instanceToken: rotatedToken,
      tokenType: 'Bearer',
      scopes: ['seat:snapshot', 'seat:prepare', 'seat:execute', 'license:refresh', 'token:rotate'],
      expiresAt: '2031-08-01T00:00:00.000Z',
      now: new Date('2026-08-01T10:02:00.000Z'),
    });
    assert.equal(rotatedStatus.generation, 2);
    assert.equal(rotatedStatus.rotatedAt, '2026-08-01T10:02:00.000Z');
    assert.equal(rotatedStatus.tokenPrefix, communityInstanceTokenPrefix(rotatedToken));
    assert.equal(await modeOf(filePath), 0o600);
    const rotatedFile = await fs.readFile(filePath, 'utf8');
    assert.equal(rotatedFile.includes(initialToken), false);
    assert.equal(rotatedFile.includes(rotatedToken), true);
    assert.doesNotThrow(() => JSON.parse(rotatedFile));

    const concurrentResults = await Promise.allSettled([
      rotateCommunityInstanceToken({
        instanceId,
        previousToken: rotatedToken,
        instanceToken: concurrentToken,
        tokenType: 'Bearer',
        scopes: ['seat:snapshot', 'license:refresh', 'token:rotate'],
        expiresAt: '2032-08-01T00:00:00.000Z',
        now: new Date('2026-08-01T10:03:00.000Z'),
      }),
      rotateCommunityInstanceToken({
        instanceId,
        previousToken: rotatedToken,
        instanceToken: `${concurrentToken}x`,
        tokenType: 'Bearer',
        scopes: ['seat:snapshot', 'license:refresh', 'token:rotate'],
        expiresAt: '2032-08-01T00:00:00.000Z',
        now: new Date('2026-08-01T10:03:01.000Z'),
      }),
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrentResults.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await loadCommunityInstanceToken(instanceId))?.instanceToken, concurrentToken);

    const temporaryFiles = (await fs.readdir(path.dirname(filePath)))
      .filter((name) => name.includes('.tmp-'));
    assert.deepEqual(temporaryFiles, []);

    const sqlite = new Database(path.join(tempRoot, 'sqlite.db'), { readonly: true });
    try {
      const storedCerts = sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM license_certs
        WHERE cert LIKE ?
      `).get(`%${concurrentToken}%`) as { count: number };
      assert.equal(storedCerts.count, 0, 'the instance token must never be stored in license_certs');
    } finally {
      sqlite.close();
    }

    const safeStatus = await getCommunityInstanceTokenStatus(instanceId);
    assert.equal(JSON.stringify(safeStatus).includes(concurrentToken), false);
    assert.equal(logged.some((line) => line.includes(initialToken)), false);
    assert.equal(logged.some((line) => line.includes(rotatedToken)), false);
    assert.equal(logged.some((line) => line.includes(concurrentToken)), false);

    await assert.rejects(
      removeCommunityInstanceToken({
        instanceId,
        expectedToken: wrongToken,
      }),
      (error: unknown) => (
        error instanceof CommunityInstanceTokenStorageError
        && error.code === 'TOKEN_ROTATION_CONFLICT'
      ),
    );
    assert.equal((await loadCommunityInstanceToken(instanceId))?.instanceToken, concurrentToken);

    assert.equal(await removeCommunityInstanceToken({
      instanceId,
      expectedToken: concurrentToken,
    }), true);
    assert.equal(await loadCommunityInstanceToken(instanceId), null);
    assert.equal(await removeCommunityInstanceToken({ instanceId }), false);

    const victimPath = path.join(tempRoot, 'victim.txt');
    await fs.writeFile(victimPath, 'do-not-read-or-replace', { mode: 0o600 });
    await fs.symlink(victimPath, filePath);
    await assert.rejects(
      loadCommunityInstanceToken(instanceId),
      (error: unknown) => (
        error instanceof CommunityInstanceTokenStorageError
        && error.code === 'TOKEN_STORAGE_UNSAFE'
      ),
    );
    assert.equal(await fs.readFile(victimPath, 'utf8'), 'do-not-read-or-replace');
    await fs.rm(filePath);

    const storageSource = await fs.readFile(
      path.join(process.cwd(), 'app/lib/license/storage.ts'),
      'utf8',
    );
    assert.match(storageSource, /^import 'server-only';/u);
    const certificateStorageSection = storageSource.slice(
      storageSource.indexOf('export async function loadStoredLicenseCert'),
    );
    assert.doesNotMatch(certificateStorageSection, /instanceToken/u);

    originalInfo('community-instance-token-storage-test: ok');
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

void main()
  .finally(() => {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousInstanceId === undefined) delete process.env.CANVAS_INSTANCE_ID;
    else process.env.CANVAS_INSTANCE_ID = previousInstanceId;
    rmSync(tempRoot, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
