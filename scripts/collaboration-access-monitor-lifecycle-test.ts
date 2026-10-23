import assert from 'node:assert/strict';
import { createCollaborationAccessMonitor } from '../app/lib/collaboration/access-monitor';

async function main() {
  const busy = new Error('Transient fixture contention');
  let validations = 0, denials = 0, rejectBusy = true;
  const monitor = createCollaborationAccessMonitor<object>({
    validate: async () => { validations++; if (rejectBusy) throw busy; },
    isTransient: error => error === busy,
    deny: () => { denials++; },
  });
  const peer = {};
  const unregister = monitor.add(peer);
  try {
    let applied = false;
    await assert.rejects(monitor.check(peer).then(() => { applied = true; }), error => error === busy);
    assert.equal(applied,false,'A transient check never accepts a write');
    assert.equal(denials,0,'Busy alone never permanently revokes the peer');
    rejectBusy = false;
    await monitor.check(peer);
    assert.equal(validations,2,'The retry performs a fresh check instead of accepting a cached success');
    rejectBusy = true;
    await monitor.sweep();
    assert.equal(denials,0);
    await unregister();
    await assert.rejects(monitor.check(peer));
  } finally { await monitor.dispose(); }

  let unblock!: () => void, entered!: () => void;
  let pendingDenials = 0, checks = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { unblock = resolve; });
  const pending = createCollaborationAccessMonitor<object>({
    validate: async () => { checks++; entered(); await release; },
    deny: () => { pendingDenials++; },
  });
  const closingPeer = {};
  const stop = pending.add(closingPeer);
  const first = pending.check(closingPeer), second = pending.check(closingPeer);
  await started;
  assert.equal(checks,1,'Concurrent checks share only their active validation');
  let stopped = false;
  const stoppedPromise = stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped,false,'Unregister awaits the actual active validation before credential disposal');
  unblock();
  const outcomes = await Promise.allSettled([first,second]);
  await stoppedPromise;
  assert(outcomes.every(result => result.status === 'rejected'),'Closing prevents both queued writes');
  assert.equal(pendingDenials,0,'A local close is not another remote access-revoked notification');
  await pending.dispose();

  let releaseShutdown!: () => void, beginShutdown!: () => void;
  const shutdownEntered = new Promise<void>(resolve => { beginShutdown = resolve; });
  const shutdownRelease = new Promise<void>(resolve => { releaseShutdown = resolve; });
  const shutdown = createCollaborationAccessMonitor<object>({
    validate: async () => { beginShutdown(); await shutdownRelease; },
    deny: () => {},
  });
  const shutdownPeer = {};
  shutdown.add(shutdownPeer);
  const inFlight = shutdown.check(shutdownPeer);
  await shutdownEntered;
  let shutdownSettled = false;
  const closing = shutdown.dispose().then(() => { shutdownSettled = true; });
  await Promise.resolve();
  assert.equal(shutdownSettled,false,'Host shutdown settles all in-flight checks');
  releaseShutdown();
  await assert.rejects(inFlight);
  await closing;

  let permanentDenials = 0;
  const permanent = createCollaborationAccessMonitor<object>({
    validate: async () => { throw new Error('Actual permanent failure'); },
    isTransient: error => error === busy,
    deny: () => { permanentDenials++; },
  });
  const deniedPeer = {};
  permanent.add(deniedPeer);
  await assert.rejects(permanent.check(deniedPeer));
  await assert.rejects(permanent.check(deniedPeer));
  assert.equal(permanentDenials,1,'Permanent denial still happens exactly once');
  await permanent.dispose();
  console.log('Access monitor: transient rejection/fresh retry, active-check sharing, unregister/shutdown settlement and permanent denial passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
