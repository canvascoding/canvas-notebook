import assert from 'node:assert/strict';
import { notifyWorkspacePathsDeleted } from '../app/lib/files/workspace-file-events';

const previous = globalThis.window;
const events: CustomEvent[] = [];
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  dispatchEvent: (event: CustomEvent) => { events.push(event); return true; },
} });
try {
  notifyWorkspacePathsDeleted(['old.md'], 'workspace');
  notifyWorkspacePathsDeleted(['deleted.md'], 'workspace', true);
  assert.deepEqual(events[0].detail, { paths: ['old.md'], workspaceId: 'workspace' });
  assert.deepEqual(events[1].detail, { paths: ['deleted.md'], workspaceId: 'workspace', confirmed: true });
  console.log('PASS physical unlink and completed local deletion retain distinct event contracts');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
}
