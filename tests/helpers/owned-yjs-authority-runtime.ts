import assert from 'node:assert/strict';
import { assertOrigin, requireOwnedYjsQaTarget } from '../../scripts/lib/owned-yjs-authority-qa';

/** Test supervisor control, never an application endpoint or a stored-PID kill. */
export async function restartOwnedYjsAuthorityHost(mode: 'graceful' | 'crash'): Promise<void> {
  const before = await requireOwnedYjsQaTarget();
  const endpoint = new URL(process.env.CANVAS_YJS_QA_RESTART_URL ?? '');
  assert.equal(endpoint.pathname, '/restart');
  const origin = new URL(endpoint); origin.pathname = '/'; assertOrigin(origin.href);
  assert.notEqual(origin.port, String(before.port));
  const token = process.env.CANVAS_YJS_QA_RESTART_TOKEN; assert(token && token.length >= 48);
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: before.nonce, mode }) });
  assert.equal(response.status, 200, 'Owned supervisor restart was not confirmed.');
  const value = await response.json() as { success: boolean; nonce: string; restartCount: number };
  assert.equal(value.success, true); assert.equal(value.nonce, before.nonce); assert.equal(value.restartCount, before.restartCount + 1);
  const after = await requireOwnedYjsQaTarget();
  for (const key of ['fixtureRoot', 'rootDevice', 'rootInode', 'dataRoot', 'dataDevice', 'dataInode',
    'databaseName', 'databaseOid', 'databaseOwner', 'ownerMarker', 'head', 'sourceFingerprint', 'buildFingerprint', 'port'] as const) {
    assert.equal(after[key], before[key], `Restart changed the owned fixture (${key}).`);
  }
  assert.equal(after.restartCount, before.restartCount + 1);
  assert.notEqual(`${after.serverPid}:${after.serverStart}`, `${before.serverPid}:${before.serverStart}`);
}
