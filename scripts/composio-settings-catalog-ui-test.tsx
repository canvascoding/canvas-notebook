import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider, createTranslator, useLocale } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://canvas.test/en/settings?tab=integrations',
  pretendToBeVisual: true,
});
for (const key of [
  'self',
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLFormElement',
  'HTMLBodyElement',
  'Element',
  'Node',
  'NodeFilter',
  'DocumentFragment',
  'MutationObserver',
  'CustomEvent',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'getComputedStyle',
])
  Object.defineProperty(globalThis, key, {
    value: dom.window[key as keyof Window],
    configurable: true,
  });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
Object.defineProperty(globalThis, 'PointerEvent', {
  value: dom.window.MouseEvent,
  configurable: true,
});
Object.defineProperty(dom.window, 'PointerEvent', {
  value: dom.window.MouseEvent,
  configurable: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: FixtureResizeObserver,
  configurable: true,
});

type Profile = {
  id: string;
  name: string;
  isDefault: boolean;
  status: 'active';
  connectedApps: [];
  workspaceOverrideCount: number;
  automationCount: number;
};
type Receipt = {
  path: string;
  method: string;
  workspaceId: string | null;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null | undefined;
};
type Held = { release: (response: Response) => void; receipt: Receipt };

/** Actual Settings/ProfileSwitcher React and HTTP mechanics; provider responses are controlled UI evidence. */
async function main() {
  const loader = Module as typeof Module & {
    _load: (name: string, parent: NodeModule | null, main: boolean) => unknown;
  };
  const originalLoad = loader._load,
    originalFetch = globalThis.fetch;
  loader._load = (name, parent, isMain) =>
    name === '@/i18n/navigation'
      ? {
          Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
            function FixtureLink(props, ref) {
              const locale = useLocale();
              return <a {...props} href={`/${locale}${props.href}`} ref={ref} />;
            },
          ),
        }
      : originalLoad(name, parent, isMain);
  const { render, screen, fireEvent, waitFor, cleanup, act, within } = await import(
    '@testing-library/react'
  );
  let actor = 'actor-a',
    sessionId = 'session-a',
    scenario:
      | 'local'
      | 'missing'
      | 'degraded'
      | 'invalid'
      | 'failed'
      | 'managed'
      | 'managed-degraded' = 'local';
  let failProfiles = false,
    pauseStatus = false,
    pauseCreate = false,
    pauseKey = false;
  const heldStatuses: Held[] = [],
    heldCreates: Held[] = [],
    heldKeys: Held[] = [],
    receipts: Receipt[] = [];
  const profileLists = new Map<string, Profile[]>(),
    selectedProfiles = new Map<string, string>();
  const session = () => ({
    user: {
      id: actor,
      name: actor,
      email: `${actor}@fixture.invalid`,
      emailVerified: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      role: 'admin',
      banned: false,
    },
    session: {
      id: sessionId,
      token: 'CONTROLLED_UI_SESSION',
      userId: actor,
      expiresAt: new Date('2099-01-01'),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  });
  const seedSession = () =>
    atom.set({
      ...atom.get(),
      data: session(),
      error: null,
      isPending: false,
      isRefetching: false,
    });
  const workspace = (id: string): ClientWorkspaceSummary => ({
    id,
    type: 'personal',
    name: id,
    ownerUserId: actor,
    organizationId: 'fixture-org',
    description: '',
    customerId: null,
    projectId: null,
    status: 'active',
    isDefault: true,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
  });
  const seedWorkspace = (id = 'ws-a') =>
    useWorkspaceStore.setState({
      workspaces: [workspace('ws-a'), workspace('ws-b')],
      activeWorkspaceId: id,
      initialized: true,
      isLoading: false,
      hydrateWorkspaces: async () => {},
    });
  const profiles = (id: string) => {
    if (!profileLists.has(id))
      profileLists.set(id, [
        {
          id: `default-${id}`,
          name: `Default ${id}`,
          isDefault: true,
          status: 'active',
          connectedApps: [],
          workspaceOverrideCount: 0,
          automationCount: 0,
        },
        {
          id: `design-${id}`,
          name: `Design ${id}`,
          isDefault: false,
          status: 'active',
          connectedApps: [],
          workspaceOverrideCount: 0,
          automationCount: 0,
        },
      ]);
    return profileLists.get(id)!;
  };
  const effective = (id: string) => {
    const profile =
      profiles(id).find((value) => value.id === selectedProfiles.get(id)) || profiles(id)[0]!;
    return {
      id: profile.id,
      name: profile.name,
      source: profile.isDefault ? ('default' as const) : ('workspace_override' as const),
      workspaceId: id,
      isDefault: profile.isDefault,
    };
  };
  const status = (id: string) =>
    scenario === 'failed'
      ? Response.json({ error: 'PRIVATE_STATUS_ERROR' }, { status: 500 })
      : Response.json({
          configured: scenario !== 'missing',
          apiKeyValid: scenario === 'local' || scenario === 'managed',
          mode:
            scenario === 'missing'
              ? 'disabled'
              : scenario.startsWith('managed')
                ? 'managed'
                : 'local',
          apiKeyState:
            scenario === 'missing'
              ? 'missing'
              : scenario === 'invalid'
                ? 'invalid_or_insufficient_scope'
                : scenario === 'degraded' || scenario === 'managed-degraded'
                  ? 'unknown'
                  : 'valid',
          providerHealthy: scenario === 'local' || scenario === 'managed',
          effectiveProfile: effective(id),
          workspace: { id, name: id, type: 'personal' },
          connectedAccounts: [],
        });
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://canvas.test',
    );
    if (url.pathname === '/api/auth/get-session') return Response.json(session());
    const receipt: Receipt = {
      path: url.pathname,
      method: init?.method || 'GET',
      workspaceId: new Headers(init?.headers).get('x-canvas-workspace-id'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      signal: init?.signal,
    };
    receipts.push(receipt);
    const id = receipt.workspaceId || 'ws-a';
    if (receipt.path === '/api/composio/status') {
      if (pauseStatus) {
        pauseStatus = false;
        return new Promise((resolve) => heldStatuses.push({ release: resolve, receipt }));
      }
      return status(id);
    }
    if (receipt.path === '/api/composio/profiles' && receipt.method === 'GET')
      return failProfiles
        ? Response.json({ success: false, error: 'PRIVATE_PROFILE_ERROR' }, { status: 503 })
        : Response.json({ success: true, profiles: profiles(id), effectiveProfile: effective(id) });
    if (receipt.path === '/api/composio/profiles' && receipt.method === 'POST') {
      if (pauseCreate) {
        pauseCreate = false;
        return new Promise((resolve) => heldCreates.push({ release: resolve, receipt }));
      }
      const profile: Profile = {
        id: `created-${id}`,
        name: String(receipt.body?.name),
        isDefault: false,
        status: 'active',
        connectedApps: [],
        workspaceOverrideCount: 0,
        automationCount: 0,
      };
      profiles(id).push(profile);
      return Response.json({ success: true, profile });
    }
    if (receipt.path === '/api/composio/workspace-profile') {
      if (receipt.method === 'DELETE') selectedProfiles.delete(id);
      else selectedProfiles.set(id, String(receipt.body?.profileId));
      return Response.json({
        success: true,
        effectiveProfile: effective(id),
        triggerChanges:
          receipt.method === 'DELETE'
            ? []
            : [
                {
                  jobId: 'one',
                  jobName: 'Owned workflow one',
                  toolkitSlug: 'canva',
                  status: 'migrated',
                },
                {
                  jobId: 'two',
                  jobName: 'Owned workflow two',
                  toolkitSlug: 'canva',
                  status: 'paused_missing_connection',
                },
              ],
      });
    }
    if (receipt.path === '/api/integrations/env' && receipt.method === 'PATCH') {
      if (pauseKey) {
        pauseKey = false;
        return new Promise((resolve) => heldKeys.push({ release: resolve, receipt }));
      }
      return Response.json({ success: true, data: {} });
    }
    throw new Error(`Unexpected Settings UI HTTP ${receipt.method} ${receipt.path}`);
  };
  const { authClient } = await import('../app/lib/auth-client');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { ConnectedAppsPanel } = await import('../app/components/settings/ConnectedAppsPanel');
  const atom = authClient.$store.atoms.session,
    previousSession = atom.get(),
    previousWorkspaces = useWorkspaceStore.getState();
  const mount = (locale: 'en' | 'de' = 'en', admin = true) =>
    render(
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
        <ConnectedAppsPanel isOpen onOpenChange={() => undefined} isAdmin={admin} />
      </NextIntlClientProvider>,
    );
  const profileContext = () => within(screen.getByTestId('composio-profile-context'));
  const catalogLink = (locale = 'en', id = 'ws-a') =>
    assert.equal(
      screen.getByTestId('composio-open-catalog').getAttribute('href'),
      `/${locale}/plugins?view=browse&kind=integration&workspaceId=${id}`,
    );
  const createDraft = async (name: string) => {
    const change = await screen.findByTestId('composio-change-profile');
    await waitFor(() => assert.equal(change.hasAttribute('disabled'), false));
    fireEvent.click(change);
    fireEvent.click(
      screen.getByRole('button', { name: en.settings.connectedApps.profiles.create, exact: true }),
    );
    fireEvent.change(screen.getByLabelText(en.settings.connectedApps.profiles.newName), {
      target: { value: name },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: en.settings.connectedApps.profiles.createAndUse,
        exact: true,
      }),
    );
  };
  try {
    seedSession();
    seedWorkspace();
    mount();
    await screen.findByTestId('composio-change-profile');
    catalogLink();
    assert(
      screen.getByTestId('composio-open-secrets').getAttribute('href') ===
        '/en/settings?tab=secrets',
    );
    assert(
      !receipts.some((value) =>
        /\/(?:toolkits|trigger-apps|connect|disconnect|refresh)(?:\/|$)/u.test(value.path),
      ),
      'Settings performs no duplicate provider catalog or account actions',
    );
    cleanup();
    scenario = 'missing';
    seedSession();
    mount();
    await waitFor(() =>
      assert(document.body.textContent?.includes(en.settings.connectedApps.notConfiguredShort)),
    );
    catalogLink();
    fireEvent.change(screen.getByLabelText('Composio API Key'), {
      target: { value: ' own-ui-key ' },
    });
    await waitFor(() =>
      assert.equal(
        screen.getByTestId('composio-save-api-key').hasAttribute('disabled'),
        false,
        JSON.stringify({
          pending: atom.get().isPending,
          error: Boolean(atom.get().error),
          userMatches: atom.get().data?.user.id === actor,
          sessionMatches: atom.get().data?.session.id === sessionId,
          draftEntered:
            (screen.getByLabelText('Composio API Key') as HTMLInputElement).value.length > 0,
        }),
      ),
    );
    fireEvent.click(screen.getByTestId('composio-save-api-key'));
    await screen.findByTestId('composio-api-key-saved');
    const patches = receipts.filter((value) => value.path === '/api/integrations/env');
    assert.equal(patches.length, 1);
    assert.equal(patches[0]!.method, 'PATCH');
    assert.deepEqual(patches[0]!.body, {
      scope: 'integrations',
      secretScope: 'system',
      patches: [{ key: 'COMPOSIO_API_KEY', value: 'own-ui-key' }],
    });
    assert.equal((screen.getByLabelText('Composio API Key') as HTMLInputElement).value, '');
    cleanup();
    seedSession();
    mount('de', false);
    await waitFor(() =>
      assert(document.body.textContent?.includes(de.settings.connectedApps.notConfiguredShort)),
    );
    catalogLink('de');
    assert.equal(
      screen.queryByTestId('composio-key-configuration'),
      null,
      'Ordinary member sees catalog and Secrets, without admin key form',
    );
    cleanup();
    scenario = 'degraded';
    seedSession();
    mount();
    await waitFor(() =>
      assert(document.body.textContent?.includes(en.settings.connectedApps.providerUnavailable)),
    );
    catalogLink();
    assert(
      !document.body.textContent?.includes(en.settings.connectedApps.notConfiguredShort),
      'Temporary provider failure is separate from missing key',
    );
    cleanup();
    scenario = 'invalid';
    seedSession();
    mount();
    await waitFor(() =>
      assert(document.body.textContent?.includes(en.settings.connectedApps.apiKeyInvalid)),
    );
    catalogLink();
    assert(
      !document.body.textContent?.includes(en.settings.connectedApps.providerUnavailable),
      'Confirmed invalid key has priority over unhealthy provider flag',
    );
    cleanup();
    scenario = 'failed';
    seedSession();
    mount();
    await waitFor(() =>
      assert(document.body.textContent?.includes(en.settings.connectedApps.statusUnknown)),
    );
    catalogLink();
    assert(
      !document.body.textContent?.includes('PRIVATE_STATUS_ERROR') &&
        !document.body.textContent?.includes(en.settings.connectedApps.notConfiguredShort),
      'Unknown status remains unknown and excludes private upstream error',
    );
    cleanup();
    scenario = 'managed';
    seedSession();
    mount();
    await waitFor(() =>
      assert(document.body.textContent?.includes(en.settings.connectedApps.managedDescription)),
    );
    catalogLink();
    assert(
      !document.body.textContent?.includes(en.settings.connectedApps.notConfiguredShort) &&
        !document.body.textContent?.includes(en.settings.connectedApps.providerUnavailable),
      'Healthy Control Plane mode is managed rather than missing or degraded',
    );
    cleanup();
    scenario = 'managed-degraded';
    seedSession();
    mount();
    await waitFor(() =>
      assert(document.body.textContent?.includes(en.settings.connectedApps.providerUnavailable)),
    );
    catalogLink();
    assert(
      document.body.textContent?.includes(en.settings.connectedApps.managedDescription) &&
        !document.body.textContent?.includes(en.settings.connectedApps.notConfiguredShort),
      'Degraded Control Plane mode retains managed status and catalog access',
    );
    cleanup();
    scenario = 'local';
    seedSession();
    seedWorkspace();
    pauseStatus = true;
    mount();
    await waitFor(() => assert.equal(heldStatuses.length, 1));
    await act(async () => {
      seedWorkspace('ws-b');
    });
    await screen.findByTestId('composio-change-profile');
    await waitFor(() =>
      assert(profileContext().getByRole('heading').textContent === 'Default ws-b'),
    );
    catalogLink('en', 'ws-b');
    const oldStatus = heldStatuses.shift()!;
    await act(async () => {
      oldStatus.release(
        Response.json({
          configured: true,
          apiKeyValid: true,
          mode: 'local',
          effectiveProfile: { ...effective('ws-a'), name: 'PRIVATE_OLD_PROFILE' },
          workspace: { id: 'ws-a' },
        }),
      );
    });
    assert.equal(oldStatus.receipt.signal?.aborted, true);
    assert(!document.body.textContent?.includes('PRIVATE_OLD_PROFILE'));
    catalogLink('en', 'ws-b');
    cleanup();
    seedWorkspace();
    seedSession();
    pauseCreate = true;
    mount();
    await createDraft('Old session profile');
    await waitFor(() => assert.equal(heldCreates.length, 1));
    const writesBefore = receipts.filter(
      (value) => value.path === '/api/composio/workspace-profile',
    ).length;
    await act(async () => {
      sessionId = 'session-b';
      seedSession();
    });
    await screen.findByTestId('composio-change-profile');
    const oldCreate = heldCreates.shift()!;
    await act(async () => {
      oldCreate.release(
        Response.json({
          success: true,
          profile: {
            id: 'private-old-created',
            name: 'Old session profile',
            isDefault: false,
            status: 'active',
            connectedApps: [],
          },
        }),
      );
    });
    assert.equal(oldCreate.receipt.signal?.aborted, true);
    assert.equal(
      receipts.filter((value) => value.path === '/api/composio/workspace-profile').length,
      writesBefore,
      'Old create acknowledgment cannot apply a workspace override in the new session',
    );
    assert(!document.body.textContent?.includes('Old session profile'));
    cleanup();
    seedWorkspace();
    seedSession();
    mount();
    await createDraft('Actual UI profile');
    await waitFor(() =>
      assert(profileContext().getByRole('heading').textContent === 'Actual UI profile'),
    );
    const translatedPausedNotice = createTranslator({ locale: 'en', messages: en })(
      'settings.connectedApps.profiles.changePaused',
      { paused: 1, migrated: 1 },
    );
    await waitFor(() => assert(document.body.textContent?.includes(translatedPausedNotice)));
    const applied = receipts
      .filter((value) => value.path === '/api/composio/workspace-profile' && value.method === 'PUT')
      .at(-1)!;
    assert.deepEqual(
      applied.body,
      { workspaceId: 'ws-a', profileId: 'created-ws-a' },
      'Existing create-and-use semantics and explicit current workspace preserved',
    );
    fireEvent.click(
      profileContext().getByRole('button', {
        name: en.settings.connectedApps.profiles.restoreDefault,
      }),
    );
    await waitFor(() =>
      assert(profileContext().getByRole('heading').textContent === 'Default ws-a'),
    );
    assert(
      receipts.some(
        (value) =>
          value.path === '/api/composio/workspace-profile' &&
          value.method === 'DELETE' &&
          value.body === null,
      ),
      'Restore uses the real DELETE/default contract',
    );
    await waitFor(() =>
      assert.equal(screen.getByTestId('composio-change-profile').hasAttribute('disabled'), false),
    );
    fireEvent.click(screen.getByTestId('composio-change-profile'));
    failProfiles = true;
    fireEvent.click(screen.getByTestId('composio-profile-option-design-ws-a'));
    await waitFor(() =>
      assert(document.body.textContent?.includes(en.settings.connectedApps.profiles.loadError)),
    );
    assert.equal(
      screen.getByTestId('composio-change-profile').hasAttribute('disabled'),
      true,
      'A failed profile reload clears old metadata and disables actions',
    );
    assert.equal(screen.queryByTestId('composio-profile-option-design-ws-a'), null);
    assert(!document.body.textContent?.includes('PRIVATE_PROFILE_ERROR'));
    failProfiles = false;
    cleanup();
    seedWorkspace();
    seedSession();
    pauseKey = true;
    mount();
    await screen.findByTestId('composio-change-profile');
    fireEvent.change(screen.getByLabelText('Composio API Key'), {
      target: { value: 'old-session-key' },
    });
    fireEvent.click(screen.getByTestId('composio-save-api-key'));
    await waitFor(() => assert.equal(heldKeys.length, 1));
    await act(async () => {
      actor = 'actor-b';
      sessionId = 'session-c';
      seedSession();
    });
    await screen.findByTestId('composio-change-profile');
    const oldKey = heldKeys.shift()!;
    await act(async () => {
      oldKey.release(Response.json({ success: true, data: {} }));
    });
    assert.equal(oldKey.receipt.signal?.aborted, true);
    assert.equal(
      screen.queryByTestId('composio-api-key-saved'),
      null,
      'Stale key acknowledgment does not mark a new actor configuration saved',
    );
    assert.equal((screen.getByLabelText('Composio API Key') as HTMLInputElement).value, '');
    cleanup();
    seedSession();
    useWorkspaceStore.setState({
      activeWorkspaceId: null,
      workspaces: [],
      initialized: false,
      isLoading: true,
    });
    const countBeforeHydration = receipts.length;
    mount();
    await act(async () => {});
    assert.equal(
      receipts.length,
      countBeforeHydration,
      'Pending workspace hydration never reads an implicit old workspace',
    );
    assert(document.body.textContent?.includes(en.settings.connectedApps.apiKeyChecking));
    await act(async () => {
      seedWorkspace();
    });
    await screen.findByTestId('composio-change-profile');
    catalogLink();
    assert(
      !receipts.some((value) => value.path === '/api/integrations/env' && value.method !== 'PATCH'),
      'The Settings panel never reads or replaces all secrets',
    );
    console.log(
      'PASS real React Composio Settings/catalog: localized exact workspace link, config-only reads, scoped one-key PATCH/admin UI, degraded/invalid/unknown/missing states, late workspace/session/write acknowledgments, profile create/apply/default and trigger notices, failed profiles fail closed, pending hydration. Controlled HTTP/UI evidence; full browser/API acceptance remains separate.',
    );
  } finally {
    cleanup();
    atom.set(previousSession);
    useWorkspaceStore.setState(previousWorkspaces);
    globalThis.fetch = originalFetch;
    loader._load = originalLoad;
    dom.window.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
