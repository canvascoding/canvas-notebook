import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { APIRequestContext } from '@playwright/test';

/** Call after closing every page using these exact, caller-owned fixture paths.
 * Busy is retryable only before an operation exists; ambiguous writes are retained.
 */
export async function deleteOwnedFixtureFiles(api: APIRequestContext, workspaceId: string,
  paths: readonly string[], timeoutMs = 45_000): Promise<void> {
  assert(workspaceId && paths.length);
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000);
  const selected = [...new Set(paths)];
  for (const filePath of selected) {
    assert(filePath && !filePath.startsWith('/') && !filePath.split('/').some(part => ['', '.', '..'].includes(part)),
      'Cleanup requires exact relative fixture paths.');
  }
  for (const filePath of selected) {
    const idempotencyKey = randomUUID();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      assert(remaining > 0, 'Owned fixture cleanup remained busy; retain its data.');
      const response = await api.delete('/api/files/delete', { headers: { 'x-canvas-workspace-id': workspaceId },
        data: { path: filePath, idempotencyKey }, timeout: remaining });
      const payload = await response.json();
      if (response.status() === 200) {
        assert.equal(payload.success, true);
        assert.deepEqual(payload.deleted, [filePath]);
        assert.deepEqual(payload.failed, []);
        break;
      }
      assert(response.status() === 409 && payload.code === 'COLLABORATION_FILE_LIFECYCLE_BUSY'
        && !payload.operation, `Owned fixture cleanup rejected (${response.status()}/${String(payload.code ?? 'unknown')}); retain its data.`);
      await wait(Math.min(500, Math.max(1, deadline - Date.now())));
    }
  }
}
