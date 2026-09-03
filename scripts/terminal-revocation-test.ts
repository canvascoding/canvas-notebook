import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'terminal-revocation-'));
  const previousRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = root;
  try {
    const { setTerminalEnabled } = await import('../app/lib/server-settings');
    const { createTerminalPolicyEnforcer } = await import('../server/terminal-access-policy');
    await setTerminalEnabled('admin', true);
    const sessions = new Map<string, { clients: Set<Socket> }>();
    const synchronize = createTerminalPolicyEnforcer(sessions, id => { sessions.delete(id); });
    sessions.set('old-session', { clients: new Set() });
    assert.equal(synchronize().closed, 0);
    // No synchronization between these writes: simulate a busy service missing
    // the disabled state before a second administrator re-enables the feature.
    await setTerminalEnabled('admin', false);
    await setTerminalEnabled('admin', true);
    const state = synchronize();
    assert.equal(state.terminalEnabled, true);
    assert.equal(sessions.size, 0, 'an off/on transition must still revoke old sessions');
    sessions.set('new-session', { clients: new Set() });
    assert.equal(synchronize().closed, 0, 'the same revocation must not kill new sessions');
    assert.equal(sessions.size, 1);
    console.log('terminal-revocation-test: ok');
  } finally {
    if (previousRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
