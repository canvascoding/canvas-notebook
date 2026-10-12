import assert from 'node:assert/strict';
import React, { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { useOnboardingProfileSession } from '../app/components/onboarding/useOnboardingProfileSession';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import { useWorkspaceStore, WORKSPACE_CHANGED_EVENT } from '../app/store/workspace-store';

// Exercise the production hook and reactive store. Only transport and deferred
// workspace I/O are controlled; this does not claim to render the full chat.
const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test/en/onboarding' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'DOMException', 'CustomEvent'] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom.window : dom.window[key],
  });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const originalFetch = globalThis.fetch;
const originalStore = useWorkspaceStore.getState();
const originalHydrate = originalStore.hydrateWorkspaces;
const originalSwitch = originalStore.setActiveWorkspace;
const errorMessage = 'The personal profile workspace could not be loaded.';
type ProfileState = ReturnType<typeof useOnboardingProfileSession>;
type SwitchArgs = Parameters<typeof originalSwitch>;
type FetchCall = { input: string; init: RequestInit | undefined };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function personal(id: string): ClientWorkspaceSummary {
  return {
    id, type: 'personal', name: id, color: '#2563EB', status: 'active',
    ownerUserId: 'onboarding-test-user',
    permissions: { canRead: true, canWrite: true, canDelete: true,
      canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
  };
}
const target = personal('personal-profile');
const previous = { ...personal('previous-team'), type: 'team' as const };
const successful = (sessionId = 'profile-session', workspaceId = target.id) =>
  Response.json({ success: true, sessionId, workspaceId });

let root: Root | null = null;
let state: ProfileState | null = null;
let fetchCalls: FetchCall[] = [];
let hydrateCalls: Parameters<typeof originalHydrate>[] = [];
let switchCalls: SwitchArgs[] = [];
let chatMounts: string[] = [];
let chatUnmounts = 0;
let completeCalls = 0;
let responseHandler: (input: string, init?: RequestInit) => Promise<Response>;
let hydrateHandler: typeof originalHydrate;
let switchHandler: typeof originalSwitch;
const completed = () => { completeCalls++; };

function ProfileChat({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) {
  useEffect(() => {
    chatMounts.push(`${workspaceId}:${sessionId}`);
    return () => { chatUnmounts++; };
  }, [sessionId, workspaceId]);
  return <div data-profile-chat data-session-id={sessionId} data-workspace-id={workspaceId} />;
}

function Harness({ onAlreadyComplete = completed, locale = 'de' }: {
  onAlreadyComplete?: () => void; locale?: string;
}) {
  const profile = useOnboardingProfileSession({ locale, errorMessage, onAlreadyComplete });
  const [skipped, setSkipped] = useState(false);
  useEffect(() => { state = profile; });
  return <div data-loading={profile.loading} data-skipped={skipped}>
    <output data-error>{profile.error}</output>
    <button data-retry onClick={() => void profile.retry()}>Retry</button>
    <button data-skip onClick={() => { profile.cancel(); setSkipped(true); }}>Skip</button>
    {!skipped && profile.ready && profile.sessionId && profile.workspaceId
      && <ProfileChat sessionId={profile.sessionId} workspaceId={profile.workspaceId} />}
  </div>;
}

async function tick() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function unmount() {
  const mountedRoot = root;
  root = null;
  if (mountedRoot) await act(async () => { mountedRoot.unmount(); });
}

async function reset() {
  await unmount();
  state = null;
  fetchCalls = []; hydrateCalls = []; switchCalls = []; chatMounts = [];
  chatUnmounts = 0; completeCalls = 0;
  dom.window.localStorage.clear();
  useWorkspaceStore.setState({ ...originalStore, workspaces: [previous],
    activeWorkspaceId: previous.id, initialized: true, isLoading: false, error: null });
  responseHandler = async () => successful();
  hydrateHandler = async () => {
    useWorkspaceStore.setState({ workspaces: [previous, target], error: null });
  };
  switchHandler = async (workspaceId, _source, options) => {
    if (options?.signal?.aborted) return false;
    const changed = useWorkspaceStore.getState().activeWorkspaceId !== workspaceId;
    useWorkspaceStore.setState({ activeWorkspaceId: workspaceId, error: null });
    return changed;
  };
  useWorkspaceStore.setState({
    hydrateWorkspaces: async (...args) => { hydrateCalls.push(args); await hydrateHandler(...args); },
    setActiveWorkspace: async (...args) => { switchCalls.push(args); return switchHandler(...args); },
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url === '/api/onboarding/profile-session' || url === '/api/workspaces',
      `Unexpected network request: ${url}`);
    fetchCalls.push({ input: url, init });
    return responseHandler(url, init);
  };
}

async function render(props: React.ComponentProps<typeof Harness> = {}) {
  if (!root) root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(<Harness {...props} />); });
  await tick();
}

function current(): ProfileState {
  assert.ok(state, 'the hook must have committed');
  return state;
}

async function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(button);
  await act(async () => { button.click(); });
  await tick();
}

async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => { pending.resolve(value); });
  await tick();
}

function assertNoChat() {
  assert.equal(current().ready, false);
  assert.equal(document.querySelector('[data-profile-chat]'), null);
  assert.deepEqual(chatMounts, []);
}

function assertReady(sessionId = 'profile-session', workspaceId = target.id) {
  assert.equal(current().loading, false);
  assert.equal(current().error, null);
  assert.equal(current().ready, true);
  assert.equal(current().sessionId, sessionId);
  assert.equal(current().workspaceId, workspaceId);
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, workspaceId);
  assert.equal(document.querySelector('[data-profile-chat]')?.getAttribute('data-workspace-id'), workspaceId);
}

async function main() {
  let groups = 0;
  await reset();
  const fetchBarrier = deferred<Response>();
  const hydrateBarrier = deferred<void>();
  responseHandler = async () => fetchBarrier.promise;
  hydrateHandler = async () => {
    await hydrateBarrier.promise;
    useWorkspaceStore.setState({ workspaces: [previous, target], error: null });
  };
  await render();
  assertNoChat();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init?.method, 'POST');
  assert.equal(fetchCalls[0].init?.credentials, 'include');
  assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), { locale: 'de' });
  await settle(fetchBarrier, successful());
  assert.deepEqual(hydrateCalls, [[{ force: true }]]);
  assertNoChat();
  assert.equal(switchCalls.length, 0);
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, previous.id);
  await settle(hydrateBarrier, undefined);
  assertReady();
  assert.equal(switchCalls[0][0], target.id);
  assert.equal(switchCalls[0][1], 'system');
  assert.equal(switchCalls[0][2]?.signal, fetchCalls[0].init?.signal);
  assert.deepEqual(chatMounts, [`${target.id}:profile-session`]);
  groups++;

  // A cancelled fetch is deliberately resolved despite its AbortSignal.
  for (const stage of ['fetch', 'hydrate', 'switch'] as const) {
    await reset();
    const lateFetch = deferred<Response>();
    const lateHydrate = deferred<void>();
    const lateSwitch = deferred<void>();
    responseHandler = async () => lateFetch.promise;
    hydrateHandler = async () => {
      await lateHydrate.promise;
      useWorkspaceStore.setState({ workspaces: [previous, target], error: null });
    };
    switchHandler = async (id, _source, options) => {
      await lateSwitch.promise;
      if (options?.signal?.aborted) return false;
      useWorkspaceStore.setState({ activeWorkspaceId: id });
      return true;
    };
    await render();
    if (stage !== 'fetch') await settle(lateFetch, successful());
    if (stage === 'switch') await settle(lateHydrate, undefined);
    await click('[data-skip]');
    assert.equal(fetchCalls[0].init?.signal?.aborted, true);
    if (stage === 'fetch') await settle(lateFetch, successful());
    if (stage === 'hydrate') await settle(lateHydrate, undefined);
    if (stage === 'switch') await settle(lateSwitch, undefined);
    assertNoChat();
    assert.equal(current().loading, false);
    assert.equal(current().sessionId, null);
    assert.equal(completeCalls, 0);
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, previous.id);
    assert.equal(hydrateCalls.length, stage === 'fetch' ? 0 : 1);
    assert.equal(switchCalls.length, stage === 'switch' ? 1 : 0);
  }
  groups++;

  for (const stage of ['fetch', 'hydrate', 'switch'] as const) {
    await reset();
    const lateFetch = deferred<Response>();
    const lateHydrate = deferred<void>();
    const lateSwitch = deferred<void>();
    responseHandler = async () => lateFetch.promise;
    hydrateHandler = async () => {
      await lateHydrate.promise;
      useWorkspaceStore.setState({ workspaces: [previous, target], error: null });
    };
    switchHandler = async (id, _source, options) => {
      await lateSwitch.promise;
      if (options?.signal?.aborted) return false;
      useWorkspaceStore.setState({ activeWorkspaceId: id });
      return true;
    };
    await render();
    if (stage !== 'fetch') await settle(lateFetch, successful());
    if (stage === 'switch') await settle(lateHydrate, undefined);
    await unmount();
    assert.equal(fetchCalls[0].init?.signal?.aborted, true);
    if (stage === 'fetch') await settle(lateFetch, successful());
    if (stage === 'hydrate') await settle(lateHydrate, undefined);
    if (stage === 'switch') await settle(lateSwitch, undefined);
    assert.deepEqual(chatMounts, []);
    assert.equal(completeCalls, 0);
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, previous.id);
    assert.equal(switchCalls.length, stage === 'switch' ? 1 : 0);
  }
  groups++;

  await reset();
  useWorkspaceStore.setState({ workspaces: [target], activeWorkspaceId: target.id });
  switchHandler = async () => false;
  await render();
  assertReady();
  assert.equal(switchCalls.length, 1, 'already-active false is valid only after checking the exact final ID');
  groups++;

  // Both HTTP failures and a successful response without the server binding
  // settle as errors and require explicit retry rather than an effect loop.
  for (const response of [Response.json({ success: false, error: 'Profile unavailable' }, { status: 503 }),
    Response.json({ success: true, sessionId: 'missing-workspace' })]) {
    await reset();
    responseHandler = async () => response;
    await render();
    assertNoChat();
    assert.equal(current().loading, false);
    assert.ok(current().error);
    await tick(); await tick();
    assert.equal(fetchCalls.length, 1);
    assert.equal(hydrateCalls.length, 0);
    responseHandler = async () => successful('retry-session');
    await click('[data-retry]');
    assertReady('retry-session');
    assert.equal(fetchCalls.length, 2);
  }
  groups++;

  await reset();
  hydrateHandler = async () => {
    useWorkspaceStore.setState({ workspaces: [target], activeWorkspaceId: target.id, error: 'Workspace reload failed' });
  };
  await render();
  assertNoChat();
  assert.equal(current().error, 'Workspace reload failed');
  assert.equal(switchCalls.length, 0, 'cached permissions cannot override a failed authoritative hydration');
  hydrateHandler = async () => { useWorkspaceStore.setState({ workspaces: [target], error: null }); };
  await click('[data-retry]');
  assertReady();
  groups++;

  for (const invalid of [
    { ...target, type: 'team' as const },
    { ...target, status: 'archived' as const },
    { ...target, permissions: { ...target.permissions, canRead: false } },
    { ...target, permissions: { ...target.permissions, canRunAgent: false } },
  ]) {
    await reset();
    hydrateHandler = async () => {
      useWorkspaceStore.setState({ workspaces: [invalid], activeWorkspaceId: invalid.id, error: null });
    };
    await render();
    assertNoChat();
    assert.equal(current().error, errorMessage);
    assert.equal(switchCalls.length, 0);
  }
  groups++;

  await reset();
  switchHandler = async () => false;
  await render();
  assertNoChat();
  assert.equal(current().error, errorMessage, 'a denied switch must never mount chat in the previous workspace');
  groups++;

  // Use the real hydration/normalization path on reload: an allowed cached
  // workspace stays selected until the hook binds the fresh server response.
  await reset();
  await render();
  assertReady();
  await unmount();
  const reloadTarget = personal('personal-after-reload');
  dom.window.localStorage.setItem('canvas.activeWorkspaceId', target.id);
  useWorkspaceStore.setState({ hydrateWorkspaces: async (...args) => {
    hydrateCalls.push(args);
    await originalHydrate(...args);
  } });
  responseHandler = async (url) => url === '/api/onboarding/profile-session'
    ? successful('reloaded-session', reloadTarget.id)
    : Response.json({ success: true, workspaces: [target, reloadTarget], activeWorkspaceId: reloadTarget.id });
  await render();
  assertReady('reloaded-session', reloadTarget.id);
  assert.equal(fetchCalls.filter((call) => call.input === '/api/onboarding/profile-session').length, 2);
  assert.equal(fetchCalls.filter((call) => call.input === '/api/workspaces').length, 1);
  assert.deepEqual(chatMounts, [`${target.id}:profile-session`, `${reloadTarget.id}:reloaded-session`]);
  groups++;

  await reset();
  await render();
  assertReady();
  await act(async () => { useWorkspaceStore.setState({ activeWorkspaceId: previous.id }); });
  assert.equal(current().ready, false);
  assert.equal(current().error, errorMessage);
  assert.equal(document.querySelector('[data-profile-chat]'), null);
  assert.equal(chatUnmounts, 1);
  assert.equal(fetchCalls.length, 1, 'a reactive binding loss does not automatically bootstrap another profile');
  await act(async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: target.id,
      workspaces: [{ ...target, permissions: { ...target.permissions, canRunAgent: false } }] });
  });
  assert.equal(current().ready, false);
  assert.equal(document.querySelector('[data-profile-chat]'), null);
  groups++;

  await reset();
  const older = deferred<Response>();
  responseHandler = async () => fetchCalls.length === 1 ? older.promise : successful('newer-session');
  await render();
  await click('[data-retry]');
  assertReady('newer-session');
  assert.equal(fetchCalls[0].init?.signal?.aborted, true);
  await settle(older, successful('obsolete-session', previous.id));
  assertReady('newer-session');
  assert.equal(hydrateCalls.length, 1);
  assert.deepEqual(chatMounts, [`${target.id}:newer-session`]);
  groups++;

  await reset();
  const alreadyComplete = deferred<Response>();
  responseHandler = async () => alreadyComplete.promise;
  await render();
  let replacementCallbacks = 0;
  await render({ onAlreadyComplete: () => { replacementCallbacks++; } });
  assert.equal(fetchCalls.length, 1, 'a callback change must not restart the profile request');
  await settle(alreadyComplete, Response.json({ success: true, complete: true }));
  assert.equal(completeCalls, 0);
  assert.equal(replacementCallbacks, 1);
  assertNoChat();
  assert.equal(hydrateCalls.length, 0);
  assert.equal(switchCalls.length, 0);
  for (const stop of ['skip', 'unmount'] as const) {
    await reset();
    const lateComplete = deferred<Response>();
    responseHandler = async () => lateComplete.promise;
    await render();
    if (stop === 'skip') await click('[data-skip]');
    else await unmount();
    await settle(lateComplete, Response.json({ success: true, complete: true }));
    assert.equal(completeCalls, 0, 'completion cannot navigate after the profile step has been cancelled');
  }
  groups++;

  // This calls the production store method, not the deferred stand-in. An
  // already-aborted onboarding switch must not touch views, cache or events.
  await reset();
  useWorkspaceStore.setState({ workspaces: [previous, target], activeWorkspaceId: previous.id });
  dom.window.localStorage.setItem('canvas.activeWorkspaceId', previous.id);
  let changedEvents = 0;
  const observe = () => { changedEvents++; };
  dom.window.addEventListener(WORKSPACE_CHANGED_EVENT, observe);
  const abort = new AbortController();
  abort.abort();
  const before = useWorkspaceStore.getState();
  assert.equal(await originalSwitch(target.id, 'system', { signal: abort.signal }), false);
  assert.equal(useWorkspaceStore.getState(), before);
  assert.equal(dom.window.localStorage.getItem('canvas.activeWorkspaceId'), previous.id);
  assert.equal(changedEvents, 0);
  assert.equal(fetchCalls.length, 0);
  dom.window.removeEventListener(WORKSPACE_CHANGED_EVENT, observe);
  groups++;

  // Also cross the real lazy FileStore import and awaited document save. The
  // new signal fence must prevent the subsequent workspace/view/cache commit.
  const { useFileStore } = await import('../app/store/file-store');
  const fileStoreBefore = useFileStore.getState();
  try {
    for (const result of ['saved', 'save-error'] as const) {
      await reset();
      useWorkspaceStore.setState({ workspaces: [previous, target], activeWorkspaceId: previous.id });
      dom.window.localStorage.setItem('canvas.activeWorkspaceId', previous.id);
      const saving = deferred<void>();
      let saveCalls = 0;
      let resetCalls = 0;
      useFileStore.setState({
        prepareCurrentFileForTransition: async () => { saveCalls++; await saving.promise; },
        resetWorkspaceView: () => { resetCalls++; },
      });
      changedEvents = 0;
      dom.window.addEventListener(WORKSPACE_CHANGED_EVENT, observe);
      const controller = new AbortController();
      const beforeSave = useWorkspaceStore.getState();
      const switching = originalSwitch(target.id, 'system', { signal: controller.signal });
      for (let tries = 0; saveCalls === 0 && tries < 10; tries++) await tick();
      assert.equal(saveCalls, 1, 'the actual workspace switch must reach the deferred save');
      controller.abort();
      await act(async () => {
        if (result === 'saved') saving.resolve();
        else saving.reject(new Error('A save completed with an error after cancellation'));
        assert.equal(await switching, false);
      });
      assert.equal(useWorkspaceStore.getState(), beforeSave);
      assert.equal(useWorkspaceStore.getState().activeWorkspaceId, previous.id);
      assert.equal(useWorkspaceStore.getState().error, null, 'a cancelled save cannot publish an obsolete error');
      assert.equal(resetCalls, 0);
      assert.equal(dom.window.localStorage.getItem('canvas.activeWorkspaceId'), previous.id);
      assert.equal(changedEvents, 0);
      assert.equal(fetchCalls.length, 0);
      dom.window.removeEventListener(WORKSPACE_CHANGED_EVENT, observe);
    }
  } finally {
    dom.window.removeEventListener(WORKSPACE_CHANGED_EVENT, observe);
    useFileStore.setState({
      prepareCurrentFileForTransition: fileStoreBefore.prepareCurrentFileForTransition,
      resetWorkspaceView: fileStoreBefore.resetWorkspaceView,
    });
  }
  groups++;

  console.log(`PASS ${groups} onboarding profile workspace UI regression groups`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await unmount();
  globalThis.fetch = originalFetch;
  useWorkspaceStore.setState(originalStore, true);
  dom.window.close();
});
