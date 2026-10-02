import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://notebook.example.test/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const moduleInternals = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = moduleInternals._load;
  let userId: string | null = 'admin';
  const sources: FakeLiveEventSource[] = [];
  class FakeLiveEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) { sources.push(this); }
    close() { this.closed = true; }
    emit(state: unknown) { this.onmessage?.({ data: JSON.stringify(state) }); }
  }
  moduleInternals._load = (name, ...args) => {
    if (name === '@/app/lib/auth-client' || name.endsWith('/app/lib/auth-client')) {
      return { authClient: { useSession: () => ({ data: userId ? { user: { id: userId } } : null }) } };
    }
    if (name === '@/app/lib/live-events/client' || name.endsWith('/app/lib/live-events/client')) {
      return { LiveEventSource: FakeLiveEventSource };
    }
    return originalLoad(name, ...args);
  };
  const { render, cleanup } = await import('@testing-library/react');
  try {
    const { StudioBulkAvailabilityProvider, useStudioBulkAvailability } = await import('../app/apps/studio/components/StudioBulkAvailabilityProvider');
    function AvailabilityProbe() {
      const state = useStudioBulkAvailability();
      return <output data-testid="availability">{JSON.stringify({
        enabled: state.studioBulkEnabled, ready: state.ready, error: state.error, updatedAt: state.updatedAt,
      })}</output>;
    }
    const tree = () => <StudioBulkAvailabilityProvider><AvailabilityProbe /></StudioBulkAvailabilityProvider>;
    const screen = render(tree());
    const state = () => JSON.parse(screen.getByTestId('availability').textContent!);
    assert.deepEqual(state(), { enabled: false, ready: false, error: false, updatedAt: null }, 'cold load hides Bulk');
    assert.equal(sources[0].url, '/api/studio/bulk/availability?stream=1');

    const revision = '2026-10-02T10:00:00.000Z';
    const olderRevision = '2026-10-02T09:00:00.000Z';
    await act(async () => sources[0].emit({ studioBulkEnabled: true, updatedAt: revision }));
    assert.equal(state().enabled, true);
    await act(async () => sources[0].emit({ studioBulkEnabled: false, updatedAt: null }));
    assert.deepEqual(state(), { enabled: false, ready: true, error: false, updatedAt: null },
      'missing or malformed preferences must revoke a previously enabled feature');
    await act(async () => sources[0].emit({ studioBulkEnabled: true, updatedAt: olderRevision }));
    assert.equal(state().enabled, false, 'late older enable cannot override no-revision revocation');
    await act(async () => sources[0].emit({ studioBulkEnabled: true, updatedAt: revision }));
    assert.equal(state().enabled, false, 'the last enabled revision cannot undo no-revision revocation');
    await act(async () => sources[0].emit({ studioBulkEnabled: true, updatedAt: null }));
    assert.equal(state().enabled, false, 'late unversioned enable cannot override known revision');

    const nextRevision = '2026-10-02T11:00:00.000Z';
    await act(async () => sources[0].emit({ studioBulkEnabled: true, updatedAt: nextRevision }));
    assert.equal(state().enabled, true);
    await act(async () => sources[0].onerror?.());
    assert.equal(state().enabled, false, 'disconnect hides Bulk');
    assert.equal(state().ready, false);
    assert.equal(state().error, true);
    await act(async () => sources[0].emit({ studioBulkEnabled: true, updatedAt: nextRevision }));
    assert.equal(state().enabled, true, 'current reconnect snapshot restores availability');
    await act(async () => sources[0].emit({ studioBulkEnabled: true, updatedAt: 'invalid' }));
    assert.equal(state().enabled, false, 'invalid snapshot hides Bulk');

    userId = 'member';
    await act(async () => screen.rerender(tree()));
    assert.equal(sources[0].closed, true);
    assert.equal(state().ready, false, 'another user must wait for their own snapshot');
    await act(async () => sources[1].onerror?.());
    await act(async () => sources[1].emit({ studioBulkEnabled: true, updatedAt: olderRevision }));
    assert.equal(state().enabled, true, 'another user does not inherit an old user revision');
    userId = null;
    await act(async () => screen.rerender(tree()));
    assert.equal(state().enabled, false, 'sign-out hides Bulk');
    assert.equal(sources[1].closed, true);
    console.log('studio-bulk-availability-ui-test: ok (cold load, revocation, stale revisions, reconnect, user scope)');
  } finally {
    cleanup();
    moduleInternals._load = originalLoad;
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
