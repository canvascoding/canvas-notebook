import assert from 'node:assert/strict';

type Listener = (event: Event) => void;

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

class TestCustomEvent<T = unknown> extends Event {
  readonly detail: T;

  constructor(type: string, init: CustomEventInit<T> = {}) {
    super(type);
    this.detail = init.detail as T;
  }
}

const localStorage = new MemoryStorage();
const listeners = new Map<string, Set<Listener>>();

(globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = TestCustomEvent as unknown as typeof CustomEvent;
(globalThis as unknown as { window: unknown }).window = {
  localStorage,
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const set = listeners.get(type) ?? new Set<Listener>();
    const normalizedListener: Listener =
      typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
    set.add(normalizedListener);
    listeners.set(type, set);
  },
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const set = listeners.get(type);
    if (!set) return;
    if (typeof listener === 'function') {
      set.delete(listener);
    }
  },
  dispatchEvent(event: Event) {
    for (const listener of listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  },
};

const personalWorkspace = {
  id: 'ws_personal',
  type: 'personal',
  name: 'Personal Workspace',
  organizationId: 'org_1',
  ownerUserId: 'user_1',
  rootRelativePath: 'workspaces/personal/user_1/files',
  status: 'active',
  legacy: false,
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: true,
    canRunAgent: true,
  },
};

const teamWorkspace = {
  id: 'ws_team',
  type: 'team',
  name: 'Team Workspace',
  organizationId: 'org_1',
  ownerUserId: null,
  rootRelativePath: 'workspaces/team/org_1/files',
  status: 'active',
  legacy: false,
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: false,
    canRunAgent: true,
  },
};

(globalThis as unknown as { fetch: typeof fetch }).fetch = async () => (
  new Response(
    JSON.stringify({
      success: true,
      organizationId: 'org_1',
      teamFeaturesEnabled: true,
      databaseProvider: 'sqlite',
      activeWorkspaceId: personalWorkspace.id,
      defaultWorkspace: personalWorkspace,
      workspaces: [personalWorkspace, teamWorkspace],
      warnings: [],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
);

async function main() {
  const {
    WORKSPACE_CHANGED_EVENT,
    selectActiveWorkspace,
    useWorkspaceStore,
  } = await import('../app/store/workspace-store');

  await useWorkspaceStore.getState().hydrateWorkspaces({ force: true });
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, personalWorkspace.id);
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.type, 'personal');

  localStorage.setItem('canvas.activeWorkspaceId', teamWorkspace.id);
  await useWorkspaceStore.getState().hydrateWorkspaces({ force: true });
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, teamWorkspace.id);
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.type, 'team');

  const receivedDetails: Array<{
    previousWorkspaceId: string | null;
    activeWorkspaceId: string;
    source: string;
  }> = [];
  window.addEventListener(WORKSPACE_CHANGED_EVENT, (event) => {
    receivedDetails.push((event as CustomEvent).detail);
  });

  const changed = useWorkspaceStore.getState().setActiveWorkspace(personalWorkspace.id, 'test');
  assert.equal(changed, true);
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, personalWorkspace.id);
  const [receivedDetail] = receivedDetails;
  assert.equal(receivedDetail.previousWorkspaceId, teamWorkspace.id);
  assert.equal(receivedDetail.activeWorkspaceId, personalWorkspace.id);
  assert.equal(receivedDetail.source, 'test');

  const unchanged = useWorkspaceStore.getState().setActiveWorkspace(personalWorkspace.id, 'test');
  assert.equal(unchanged, false);

  (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => (
    new Response(
      JSON.stringify({
        success: false,
        error: 'License does not include Team runtime',
        code: 'LICENSE_FEATURE_REQUIRED',
        feature: 'teamWorkspace',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    )
  );

  await useWorkspaceStore.getState().hydrateWorkspaces({ force: true });
  assert.equal(useWorkspaceStore.getState().error, null);
  assert.equal(useWorkspaceStore.getState().teamModeUnavailable?.feature, 'teamWorkspace');
  assert.equal(useWorkspaceStore.getState().teamFeaturesEnabled, true);
  assert.deepEqual(useWorkspaceStore.getState().workspaces, []);

  console.log('workspace-switcher-ui-test passed');
}

void main();
