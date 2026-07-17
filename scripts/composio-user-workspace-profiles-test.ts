import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
const createdComposioSessions: string[] = [];
const connectedAccountsByComposioUser = new Map<string, Array<{
  id: string;
  toolkit: { slug: string; name: string };
  status: string;
  createdAt: string;
}>>();
const fakeTriggers = new Map<string, { connectedAccountId: string; disabled: boolean }>();
const fakeTriggerActions: string[] = [];
let fakeTriggerSequence = 0;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@composio/core') {
    return {
      Composio: class {
        connectedAccounts = {
          list: async (input: { userIds?: string[] }) => ({
            items: connectedAccountsByComposioUser.get(input.userIds?.[0] || '') || [],
          }),
          delete: async () => undefined,
        };
        triggers = {
          getType: async () => ({ toolkit: { slug: 'instagram' } }),
          create: async (_userId: string, _slug: string, input: { connectedAccountId?: string }) => {
            const triggerId = `migrated-trigger-${++fakeTriggerSequence}`;
            fakeTriggers.set(triggerId, {
              connectedAccountId: input.connectedAccountId || '',
              disabled: false,
            });
            fakeTriggerActions.push(`create:${triggerId}`);
            return { triggerId };
          },
          listActive: async (input: { triggerIds?: string[] }) => ({
            items: (input.triggerIds || []).flatMap((triggerId) => {
              const trigger = fakeTriggers.get(triggerId);
              return trigger ? [{ triggerId, connectedAccountId: trigger.connectedAccountId }] : [];
            }),
          }),
          disable: async (triggerId: string) => {
            const trigger = fakeTriggers.get(triggerId);
            if (trigger) trigger.disabled = true;
            fakeTriggerActions.push(`disable:${triggerId}`);
          },
          enable: async (triggerId: string) => {
            const trigger = fakeTriggers.get(triggerId);
            if (trigger) trigger.disabled = false;
            fakeTriggerActions.push(`enable:${triggerId}`);
          },
          delete: async (triggerId: string) => {
            fakeTriggers.delete(triggerId);
            fakeTriggerActions.push(`delete:${triggerId}`);
          },
        };
        create = async (userId: string) => {
          createdComposioSessions.push(userId);
          return { userId, sessionNumber: createdComposioSessions.length };
        };
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-profiles-'));
  process.env.DATA = tmpRoot;
  process.env.CANVAS_DATA_ROOT = tmpRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';

  const { openDb, closeDatabaseConnections } = await import('../app/lib/db');
  const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
  const { getLocalComposioApiKey } = await import('../app/lib/composio/composio-client');
  const { resolveComposioContext } = await import('../app/lib/composio/composio-context');
  const {
    createComposioOAuthFlowState,
    consumeComposioOAuthFlowState,
  } = await import('../app/lib/composio/composio-oauth-state');
  const { getComposioSession } = await import('../app/lib/composio/composio-session');
  const { changeComposioWorkspaceProfile } = await import('../app/lib/composio/composio-workspace-profile-change');
  const { createWebhookAutomationJob, getAutomationJob } = await import('../app/lib/automations/store');
  const {
    ComposioProfileError,
    archiveComposioProfile,
    createComposioProfile,
    ensureDefaultComposioProfile,
    listComposioProfiles,
    renameComposioProfile,
    resolveEffectiveComposioProfile,
    setComposioWorkspaceProfileOverride,
  } = await import('../app/lib/composio/composio-profiles');

  const database = await openDb();
  const now = Date.now();
  try {
    for (const id of ['user-a', 'user-b', 'user-c']) {
      await database.run(`
        INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `, [id, id, `${id}@example.test`, now, now]);
    }
    await database.run(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES ('org-1', 'user-a', 'team', 1, ?, ?)
    `, [now, now]);
    for (const [userId, role] of [['user-a', 'owner'], ['user-b', 'member'], ['user-c', 'member']]) {
      await database.run(`
        INSERT INTO organization_user_permissions (
          organization_id, user_id, role, status, can_write_team_workspace,
          can_create_public_links, can_create_team_automations,
          can_share_plugins_and_skills, can_export, can_delete_team_files,
          can_delete_studio_assets, can_manage_backups, can_migrate_database,
          can_enable_knowledge, can_recover_workspaces, created_at, updated_at
        ) VALUES ('org-1', ?, ?, 'active', 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, ?, ?)
      `, [userId, role, now, now]);
    }
    const workspaces = [
      ['ws-personal-a', 'personal', 'user-a', 'workspaces/personal/user-a/files', 'A Personal', 1],
      ['ws-personal-b', 'personal', 'user-b', 'workspaces/personal/user-b/files', 'B Personal', 1],
      ['ws-personal-c', 'personal', 'user-c', 'workspaces/personal/user-c/files', 'C Personal', 1],
      ['ws-team', 'team', null, 'workspaces/team/org-1/test/files', 'Team', 0],
    ] as const;
    for (const [id, type, ownerUserId, rootRelativePath, displayName, isDefault] of workspaces) {
      await database.run(`
        INSERT INTO canvas_workspaces (
          id, organization_id, type, owner_user_id, root_relative_path,
          display_name, status, is_default, created_at, updated_at
        ) VALUES (?, 'org-1', ?, ?, ?, ?, 'active', ?, ?, ?)
      `, [id, type, ownerUserId, rootRelativePath, displayName, isDefault, now, now]);
    }
    for (const userId of ['user-a', 'user-b']) {
      await database.run(`
        INSERT INTO canvas_workspace_members (
          organization_id, workspace_id, user_id, role, status,
          can_read, can_write, can_manage, created_at, updated_at
        ) VALUES ('org-1', 'ws-team', ?, 'member', 'active', 1, 1, 0, ?, ?)
      `, [userId, now, now]);
    }
  } finally {
    await database.close();
  }

  await replaceScopedEnvEntries('integrations', [
    { key: 'COMPOSIO_USER_ID', value: 'legacy-user-a' },
  ], { userId: 'user-a' });
  await replaceScopedEnvEntries('integrations', [
    { key: 'COMPOSIO_API_KEY', value: 'one-project-key' },
  ], { secretScope: 'legacy' });

  const defaultA = await ensureDefaultComposioProfile('user-a');
  const defaultAAgain = await ensureDefaultComposioProfile('user-a');
  const defaultB = await ensureDefaultComposioProfile('user-b');
  assert.equal(defaultA.composioUserId, 'legacy-user-a');
  assert.equal(defaultAAgain.id, defaultA.id);
  assert.equal(defaultB.isDefault, true);
  assert.notEqual(defaultB.composioUserId, defaultA.composioUserId);

  const companyA = await createComposioProfile({ ownerUserId: 'user-a', name: '  Company   A  ' });
  assert.equal(companyA.name, 'Company A');
  assert.equal(companyA.isDefault, false);
  assert.notEqual(companyA.composioUserId, defaultA.composioUserId);

  const renamed = await renameComposioProfile({
    ownerUserId: 'user-a',
    profileId: companyA.id,
    name: 'Company A Social',
  });
  assert.equal(renamed.name, 'Company A Social');

  connectedAccountsByComposioUser.set(defaultA.composioUserId, [{
    id: 'account-default-instagram',
    toolkit: { slug: 'instagram', name: 'Instagram' },
    status: 'ACTIVE',
    createdAt: new Date(now).toISOString(),
  }]);
  connectedAccountsByComposioUser.set(companyA.composioUserId, [{
    id: 'account-company-instagram',
    toolkit: { slug: 'instagram', name: 'Instagram' },
    status: 'ACTIVE',
    createdAt: new Date(now).toISOString(),
  }]);
  fakeTriggers.set('original-trigger', {
    connectedAccountId: 'account-default-instagram',
    disabled: false,
  });
  const webhookDatabase = await openDb();
  try {
    await webhookDatabase.run(`
      INSERT INTO composio_webhook_subscriptions (
        id, subscription_id, webhook_url, encrypted_secret, secret_preview,
        event_types, status, mode, created_at, updated_at, rotated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'local', ?, ?, NULL)
    `, [
      'subscription-local-test',
      'subscription-remote-test',
      'http://localhost:3000/api/composio/webhook',
      'test-secret',
      'test',
      '[]',
      now,
      now,
    ]);
  } finally {
    await webhookDatabase.close();
  }
  const triggerJob = await createWebhookAutomationJob({
    name: 'Instagram trigger',
    prompt: 'Handle the incoming event.',
    scope: 'organization',
    workspaceId: 'ws-team',
    composioTriggerId: 'original-trigger',
    composioTriggerSlug: 'INSTAGRAM_NEW_MEDIA',
    composioToolkitSlug: 'instagram',
    composioConnectedAccountId: 'account-default-instagram',
    composioProfileId: defaultA.id,
    composioUserId: defaultA.composioUserId,
    webhookTriggerConfig: { page: 'company-a' },
  }, { id: 'user-a', email: 'user-a@example.test', role: 'admin' });

  const teamAChange = await changeComposioWorkspaceProfile({
    userId: 'user-a',
    workspaceId: 'ws-team',
    profileId: companyA.id,
  });
  const teamA = teamAChange.effectiveContext;
  assert.equal(teamA.profileId, companyA.id);
  assert.equal(teamA.profileSource, 'workspace_override');
  assert.equal(teamAChange.triggerChanges[0]?.status, 'migrated');
  const migratedJob = await getAutomationJob(triggerJob.id);
  assert.equal(migratedJob?.composioProfileId, companyA.id);
  assert.equal(migratedJob?.composioUserId, companyA.composioUserId);
  assert.equal(migratedJob?.composioConnectedAccountId, 'account-company-instagram');
  assert.match(migratedJob?.composioTriggerId || '', /^migrated-trigger-/u);
  assert.ok(fakeTriggerActions.includes('disable:original-trigger'));
  assert.ok(fakeTriggerActions.includes('delete:original-trigger'));
  assert.ok(fakeTriggerActions.includes(`enable:${migratedJob?.composioTriggerId}`));

  const teamContextA = await resolveComposioContext({ userId: 'user-a', workspaceId: 'ws-team' });
  const personalContextA = await resolveComposioContext({ userId: 'user-a', workspaceId: 'ws-personal-a' });
  assert.equal(teamContextA.profileId, companyA.id);
  assert.equal(teamContextA.composioUserId, companyA.composioUserId);
  assert.equal(personalContextA.profileId, defaultA.id);
  assert.equal(await getLocalComposioApiKey(teamContextA.storageScope), 'one-project-key');

  const teamSessionA = await getComposioSession(teamContextA) as { userId: string };
  const teamSessionAAgain = await getComposioSession(teamContextA);
  const personalSessionA = await getComposioSession(personalContextA) as { userId: string };
  assert.equal(teamSessionA.userId, companyA.composioUserId);
  assert.equal(teamSessionAAgain, teamSessionA);
  assert.equal(personalSessionA.userId, defaultA.composioUserId);
  assert.deepEqual(createdComposioSessions, [companyA.composioUserId, defaultA.composioUserId]);

  const oauthFlow = await createComposioOAuthFlowState({
    context: teamContextA,
    toolkitSlug: 'instagram',
  });
  assert.match(oauthFlow.callbackUrl, /\/api\/composio\/callback\?flow=/u);
  assert.ok(!oauthFlow.callbackUrl.includes(companyA.composioUserId));
  await assert.rejects(
    consumeComposioOAuthFlowState({ state: oauthFlow.state, userId: 'user-b' }),
    (error: unknown) => error instanceof ComposioProfileError && error.code === 'COMPOSIO_OAUTH_STATE_INVALID',
  );
  const consumedFlow = await consumeComposioOAuthFlowState({ state: oauthFlow.state, userId: 'user-a' });
  assert.equal(consumedFlow.profileId, companyA.id);
  assert.equal(consumedFlow.workspaceId, 'ws-team');
  assert.equal(consumedFlow.toolkitSlug, 'instagram');
  await assert.rejects(
    consumeComposioOAuthFlowState({ state: oauthFlow.state, userId: 'user-a' }),
    (error: unknown) => error instanceof ComposioProfileError && error.code === 'COMPOSIO_OAUTH_STATE_INVALID',
  );

  const personalA = await resolveEffectiveComposioProfile({ userId: 'user-a', workspaceId: 'ws-personal-a' });
  const teamB = await resolveEffectiveComposioProfile({ userId: 'user-b', workspaceId: 'ws-team' });
  assert.equal(personalA.id, defaultA.id);
  assert.equal(personalA.source, 'default');
  assert.equal(teamB.id, defaultB.id);
  assert.equal(teamB.source, 'default');

  const profilesA = await listComposioProfiles('user-a');
  assert.equal(profilesA.length, 2);
  assert.equal(profilesA[0]?.id, defaultA.id);
  assert.equal(profilesA.find((profile) => profile.id === companyA.id)?.workspaceOverrideCount, 1);

  await assert.rejects(
    setComposioWorkspaceProfileOverride({
      userId: 'user-a',
      workspaceId: 'ws-team',
      profileId: defaultB.id,
    }),
    (error: unknown) => error instanceof ComposioProfileError && error.code === 'COMPOSIO_PROFILE_NOT_FOUND',
  );
  await assert.rejects(
    resolveEffectiveComposioProfile({ userId: 'user-c', workspaceId: 'ws-team' }),
    (error: unknown) => error instanceof ComposioProfileError && error.code === 'COMPOSIO_WORKSPACE_INACCESSIBLE',
  );
  await assert.rejects(
    archiveComposioProfile({ ownerUserId: 'user-a', profileId: companyA.id }),
    (error: unknown) => error instanceof ComposioProfileError && error.code === 'COMPOSIO_PROFILE_IN_USE',
  );
  await assert.rejects(
    archiveComposioProfile({ ownerUserId: 'user-a', profileId: defaultA.id }),
    (error: unknown) => error instanceof ComposioProfileError && error.code === 'COMPOSIO_DEFAULT_PROFILE_ARCHIVE_FORBIDDEN',
  );

  const restoredDefaultChange = await changeComposioWorkspaceProfile({
    userId: 'user-a',
    workspaceId: 'ws-team',
    profileId: null,
  });
  assert.equal(restoredDefaultChange.effectiveContext.profileId, defaultA.id);
  assert.equal(restoredDefaultChange.effectiveContext.profileSource, 'default');
  assert.equal(restoredDefaultChange.triggerChanges[0]?.status, 'migrated');
  await archiveComposioProfile({ ownerUserId: 'user-a', profileId: companyA.id });
  assert.deepEqual((await listComposioProfiles('user-a')).map((profile) => profile.id), [defaultA.id]);

  const verifyDatabase = await openDb();
  try {
    const defaults = await verifyDatabase.all(`
      SELECT owner_user_id, COUNT(*) AS count
      FROM composio_connection_profiles
      WHERE is_default = 1 AND status = 'active'
      GROUP BY owner_user_id
    `) as Array<{ owner_user_id: string; count: number }>;
    assert.deepEqual(defaults.map((row) => [row.owner_user_id, Number(row.count)]), [
      ['user-a', 1],
      ['user-b', 1],
    ]);
  } finally {
    await verifyDatabase.close();
    await closeDatabaseConnections();
  }

  console.log('composio-user-workspace-profiles-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
