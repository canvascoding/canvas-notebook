import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

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

const personalWorkspace: ClientWorkspaceSummary = {
  id: 'ws_personal',
  type: 'personal',
  name: 'Personal Workspace',
  description: 'Personal planning and notes.',
  organizationId: 'org_1',
  ownerUserId: 'user_1',
  rootRelativePath: 'workspaces/personal/user_1/files',
  icon: 'notebook-pen',
  color: '#2563EB',
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

const teamWorkspace: ClientWorkspaceSummary = {
  id: 'ws_team',
  type: 'team',
  name: 'Team Workspace',
  organizationId: 'org_1',
  ownerUserId: null,
  rootRelativePath: 'workspaces/team/org_1/files',
  color: '#047857',
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

const additionalPersonalWorkspace: ClientWorkspaceSummary = {
  ...personalWorkspace,
  id: 'ws_personal_research',
  name: 'Research Workspace',
  rootRelativePath: 'workspaces/personal/user_1/research/files',
  isDefault: false,
};

(globalThis as unknown as { fetch: typeof fetch }).fetch = async () => (
  new Response(
    JSON.stringify({
      success: true,
      organizationId: 'org_1',
      teamFeaturesEnabled: true,
      canCreateSharedWorkspaces: true,
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
  const createWorkspaceDialogSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'components', 'settings', 'CreateWorkspaceDialog.tsx'),
    'utf8',
  );
  const editWorkspaceDialogSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'components', 'settings', 'EditWorkspaceDialog.tsx'),
    'utf8',
  );
  const workspaceManagementCardSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'components', 'settings', 'WorkspaceManagementCard.tsx'),
    'utf8',
  );
  const onboardingWizardSource = fs.readFileSync(
    path.join(process.cwd(), 'app', '[locale]', '(routes)', 'onboarding', 'onboarding-wizard.tsx'),
    'utf8',
  );
  for (const dialogSource of [createWorkspaceDialogSource, editWorkspaceDialogSource]) {
    assert.match(dialogSource, /<Textarea/u);
    assert.match(dialogSource, /maxLength=\{WORKSPACE_DESCRIPTION_MAX_LENGTH\}/u);
    assert.match(dialogSource, /fields\.descriptionCount/u);
    assert.match(dialogSource, /description\.trim\(\)/u);
    assert.match(dialogSource, /<WorkspaceColorPicker/u);
    assert.match(dialogSource, /color,/u);
  }
  assert.match(
    createWorkspaceDialogSource,
    /Extract<ClientWorkspaceType, 'personal' \| 'organization' \| 'team' \| 'project'>/u,
  );
  assert.match(createWorkspaceDialogSource, /value: 'organization'/u);
  assert.match(createWorkspaceDialogSource, /hints\.organizationAccess/u);
  assert.doesNotMatch(workspaceManagementCardSource, /organizationNotDeletable/u);
  assert.match(onboardingWizardSource, /\{shared \? \(/u);

  const knowledgeGraphShellSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'apps', 'knowledge-graph', 'components', 'KnowledgeGraphShell.tsx'),
    'utf8',
  );
  assert.match(
    knowledgeGraphShellSource,
    /headerActions=\{<WorkspaceSwitcher source="navbar" variant="compact" \/>\}/,
  );
  const chatHeaderSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'components', 'canvas-agent-chat', 'ChatHeader.tsx'),
    'utf8',
  );
  const workspaceSwitcherSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'components', 'workspaces', 'WorkspaceSwitcher.tsx'),
    'utf8',
  );
  const workspaceIdentityMarkSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'components', 'workspaces', 'WorkspaceIdentityMark.tsx'),
    'utf8',
  );
  const workspaceBadgeSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'components', 'workspaces', 'WorkspaceBadge.tsx'),
    'utf8',
  );
  const workspaceExportCardSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'components', 'settings', 'WorkspaceExportCard.tsx'),
    'utf8',
  );
  assert.match(chatHeaderSource, /@container relative z-10/u);
  assert.match(chatHeaderSource, /\{sessionId \? \(/u);
  assert.match(chatHeaderSource, /hidden @\[44rem\]:inline-flex/u);
  assert.match(
    chatHeaderSource,
    /<DropdownMenuItem onSelect=\{\(\) => setWorkspaceSheetOpen\(true\)\}>/u,
  );
  assert.match(
    chatHeaderSource,
    /<\/DropdownMenu>\s*\{showWorkspaceSwitcher \? \(\s*<WorkspaceSwitcher[\s\S]*?mobileSheetOpen=\{workspaceSheetOpen\}[\s\S]*?hideMobileSheetTrigger/u,
  );
  assert.match(workspaceSwitcherSource, /const mobileSheetOpen = controlledMobileSheetOpen \?\? internalMobileSheetOpen/u);
  assert.match(workspaceSwitcherSource, /\{!hideMobileSheetTrigger \? \(\s*<SheetTrigger asChild>/u);
  assert.match(workspaceIdentityMarkSource, /data-workspace-color=\{color\}/u);
  assert.match(workspaceIdentityMarkSource, /style=\{\{ backgroundColor: color \}\}/u);
  assert.ok((workspaceSwitcherSource.match(/<WorkspaceIdentityMark/gu) || []).length >= 4);
  assert.match(workspaceBadgeSource, /<WorkspaceIdentityMark/u);
  assert.match(workspaceManagementCardSource, /<WorkspaceIdentityMark/u);
  assert.match(workspaceExportCardSource, /<WorkspaceIdentityMark/u);

  const {
    WORKSPACE_CHANGED_EVENT,
    selectActiveWorkspace,
    useWorkspaceStore,
  } = await import('../app/store/workspace-store');
  const {
    hasWorkspaceManagementControls,
    hasWorkspaceSwitcherOptions,
  } = await import('../app/components/workspaces/WorkspaceSwitcher');
  const { canExportWorkspaceFiles } = await import('../app/lib/workspaces/export-access');
  const {
    getSoleActiveWorkspaceManagerId,
    wouldRemoveLastWorkspaceManager,
  } = await import('../app/lib/workspaces/member-manager-policy');

  assert.equal(hasWorkspaceSwitcherOptions([personalWorkspace]), false);
  assert.equal(hasWorkspaceSwitcherOptions([personalWorkspace, additionalPersonalWorkspace]), true);
  assert.equal(hasWorkspaceManagementControls([personalWorkspace]), true);
  assert.equal(hasWorkspaceManagementControls([teamWorkspace]), false);
  assert.equal(canExportWorkspaceFiles({
    workspaceType: 'personal',
    isPersonalOwner: true,
    isInstanceAdmin: false,
    canRead: true,
    status: 'active',
  }), true);
  assert.equal(getSoleActiveWorkspaceManagerId([
    { userId: 'manager-1', status: 'active', canManage: true },
    { userId: 'editor-1', status: 'active', canManage: false },
  ]), 'manager-1');
  assert.equal(getSoleActiveWorkspaceManagerId([
    { userId: 'manager-1', status: 'active', canManage: true },
    { userId: 'manager-2', status: 'active', canManage: true },
  ]), null);
  assert.equal(wouldRemoveLastWorkspaceManager({
    targetIsActiveManager: true,
    activeManagerCount: 1,
    nextCanManage: false,
  }), true);
  assert.equal(wouldRemoveLastWorkspaceManager({
    targetIsActiveManager: true,
    activeManagerCount: 2,
    nextCanManage: false,
  }), false);
  assert.equal(canExportWorkspaceFiles({
    workspaceType: 'team',
    isPersonalOwner: false,
    isInstanceAdmin: false,
    canRead: true,
    status: 'active',
  }), false);
  assert.equal(canExportWorkspaceFiles({
    workspaceType: 'team',
    isPersonalOwner: false,
    isInstanceAdmin: true,
    canRead: true,
    status: 'active',
  }), true);

  await useWorkspaceStore.getState().hydrateWorkspaces({ force: true });
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, personalWorkspace.id);
  assert.equal(useWorkspaceStore.getState().canCreateSharedWorkspaces, true);
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.type, 'personal');
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.icon, 'notebook-pen');
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.description, 'Personal planning and notes.');
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.color, '#2563EB');

  localStorage.setItem('canvas.activeWorkspaceId', teamWorkspace.id);
  await useWorkspaceStore.getState().hydrateWorkspaces({ force: true });
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, teamWorkspace.id);
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.type, 'team');
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.color, '#047857');

  const receivedDetails: Array<{
    previousWorkspaceId: string | null;
    activeWorkspaceId: string;
    source: string;
  }> = [];
  window.addEventListener(WORKSPACE_CHANGED_EVENT, (event) => {
    receivedDetails.push((event as CustomEvent).detail);
  });

  const changed = await useWorkspaceStore.getState().setActiveWorkspace(personalWorkspace.id, 'test');
  assert.equal(changed, true);
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, personalWorkspace.id);
  const [receivedDetail] = receivedDetails;
  assert.equal(receivedDetail.previousWorkspaceId, teamWorkspace.id);
  assert.equal(receivedDetail.activeWorkspaceId, personalWorkspace.id);
  assert.equal(receivedDetail.source, 'test');

  const unchanged = await useWorkspaceStore.getState().setActiveWorkspace(personalWorkspace.id, 'test');
  assert.equal(unchanged, false);

  (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => (
    new Response(
      JSON.stringify({
        success: true,
        organizationId: 'org_1',
        teamFeaturesEnabled: false,
        canCreateSharedWorkspaces: false,
        databaseProvider: 'sqlite',
        activeWorkspaceId: personalWorkspace.id,
        defaultWorkspace: personalWorkspace,
        workspaces: [personalWorkspace, additionalPersonalWorkspace],
        warnings: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  );

  await useWorkspaceStore.getState().hydrateWorkspaces({ force: true });
  assert.equal(useWorkspaceStore.getState().teamFeaturesEnabled, false);
  assert.equal(useWorkspaceStore.getState().canCreateSharedWorkspaces, false);
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.id, personalWorkspace.id);
  const personalWorkspaceChanged = await useWorkspaceStore.getState().setActiveWorkspace(additionalPersonalWorkspace.id, 'test');
  assert.equal(personalWorkspaceChanged, true);
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.id, additionalPersonalWorkspace.id);
  assert.equal(selectActiveWorkspace(useWorkspaceStore.getState())?.type, 'personal');

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
