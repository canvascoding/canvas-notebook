import assert from 'node:assert/strict';

import {
  clearStudioGenerateHandoff,
  consumeStudioGenerateHandoff,
  persistStudioGenerateHandoff,
} from '../app/apps/studio/utils/studio-generate-handoff';

class MemoryStorage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { sessionStorage: storage },
});

const request = {
  id: 'handoff-1',
  workspaceId: 'workspace-1',
  payload: { prompt: 'A studio handoff', mode: 'image' as const },
};

assert.equal(persistStudioGenerateHandoff(request), true);
assert.equal(consumeStudioGenerateHandoff(request.id, 'workspace-2'), null, 'a workspace mismatch must not claim the request');
assert.deepEqual(consumeStudioGenerateHandoff(request.id, request.workspaceId), request);
assert.equal(consumeStudioGenerateHandoff(request.id, request.workspaceId), null, 'a claimed request must not run twice');

clearStudioGenerateHandoff(request.id);
assert.equal(persistStudioGenerateHandoff(request), true);
const originalNow = Date.now;
Date.now = () => originalNow() + (6 * 60 * 1000);
assert.equal(consumeStudioGenerateHandoff(request.id, request.workspaceId), null, 'expired requests must not run');
Date.now = originalNow;

console.log('Studio generate handoff checks passed.');
