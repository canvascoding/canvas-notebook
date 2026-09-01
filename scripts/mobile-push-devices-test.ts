import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

const testRoot = mkdtempSync(path.join(tmpdir(), 'canvas-mobile-push-'));
process.env.DATA = testRoot;
process.env.BETTER_AUTH_SECRET = 'test-mobile-push-secret-that-is-long-enough';
process.env.BASE_URL = 'https://canvas.example.test';

async function main() {
  try {
  const {
    agentResponsePushSuppressionReason,
    createAgentResponseReadyMessages,
    createInboxWidgetRefreshMessages,
    createMobilePushMessages,
    getMobilePushDeviceStatus,
    parseMobilePushRegistration,
    pollMobilePushReceipts,
    registerMobilePushDevice,
    sendAgentResponseReadyPush,
    sendAutomationRunStatusPush,
    sendMobileAttentionPush,
    unregisterMobilePushDevice,
  } = await import('../app/lib/mobile/push-devices');
  const {
    createAgentResponseNotificationPreview,
    createAutomationRunNotificationPreview,
    createStudioPushPreviewUrl,
    issueStudioPushPreviewTicket,
    markdownToNotificationText,
    STUDIO_PUSH_PREVIEW_TTL_SECONDS,
    verifyStudioPushPreviewTicket,
  } = await import('../app/lib/mobile/push-preview');
  const { closeDatabaseConnections, openDb } = await import('../app/lib/db');
  const { setUserPreferredLocale } = await import('../app/lib/user-preferences');
  const database = await openDb();
  const now = Date.now();
  const authNow = Math.floor(now / 1_000);
  await database.run(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['push-user', 'Push User', 'push@example.test', 1, now, now],
  );
  await database.run(
    `INSERT INTO canvas_organization_settings (
       organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    ['push-organization', 'push-user', 'single_user', 0, now, now],
  );
  await database.run(
    `INSERT INTO canvas_workspaces (
       id, organization_id, type, owner_user_id, root_relative_path, display_name,
       status, is_default, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['workspace-1', 'push-organization', 'personal', 'push-user', 'workspaces/personal/push-user/files', 'Push Workspace', 'active', 1, now, now],
  );
  await database.run(
    `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['auth-session', authNow + 60, 'session-token', authNow, authNow, 'push-user'],
  );
  const responseAt = now + 1_000;
  await database.run(
    `INSERT INTO pi_sessions (
       session_id, user_id, provider, model, title, created_at, updated_at,
       last_message_at, last_viewed_at, workspace_id, workspace_type
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ['session-1', 'push-user', 'openai', 'test-model', '**Push** session', now, now, responseAt, 'workspace-1', 'personal'],
  );
  const insertedSession = await database.get(
    'SELECT id FROM pi_sessions WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  ) as { id: number };
  await database.run(
    `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
     VALUES (?, 'assistant', ?, ?, 1)`,
    [
      insertedSession.id,
      JSON.stringify({
        role: 'assistant',
        content: [{
          type: 'text',
          text: '# Done\n\nSee the **finished** [report](https://private.example.test/report) and `code`.',
        }],
        timestamp: responseAt,
      }),
      responseAt,
    ],
  );
  const studioPreviewPath = 'studio/outputs/push-preview.png';
  mkdirSync(path.join(testRoot, 'studio', 'outputs'), { recursive: true });
  const studioPreviewBytes = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 24, g: 92, b: 148, alpha: 1 },
    },
  }).png().toBuffer();
  writeFileSync(
    path.join(testRoot, studioPreviewPath),
    studioPreviewBytes,
  );
  await database.run(
    `INSERT INTO studio_generations (
       id, user_id, workspace_id, mode, aspect_ratio, provider, model, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'image', '1:1', 'test', 'test', 'completed', ?, ?)`,
    ['studio-generation-1', 'push-user', 'workspace-1', now, now],
  );
  await database.run(
    `INSERT INTO studio_generation_outputs (
       id, generation_id, workspace_id, variation_index, type, file_path, file_name,
       file_size, mime_type, is_favorite, created_at
     ) VALUES (?, ?, ?, 0, 'image', ?, 'push-preview.png', ?, 'image/png', 0, ?)`,
    [
      'studio-output-1',
      'studio-generation-1',
      'workspace-1',
      studioPreviewPath,
      readFileSync(path.join(testRoot, studioPreviewPath)).byteLength,
      now,
    ],
  );
  await database.close();
  await setUserPreferredLocale('push-user', 'en');

  const unreadState = {
    lastMessageAt: responseAt,
    lastViewedAt: null,
    lastAssistantMessageId: 1,
    lastAssistantMessageContent: JSON.stringify({ role: 'assistant', content: 'Done' }),
    sessionTitle: 'Push session',
  };
  assert.equal(agentResponsePushSuppressionReason(unreadState, unreadState), null);
  assert.equal(agentResponsePushSuppressionReason(unreadState, { ...unreadState, lastViewedAt: responseAt }), 'read');
  assert.equal(agentResponsePushSuppressionReason(unreadState, { ...unreadState, lastAssistantMessageId: 2 }), 'superseded');

  const registration = parseMobilePushRegistration({
    installationId: 'installation-1',
    expoPushToken: 'ExpoPushToken[abc_DEF-123]',
    platform: 'ios',
    appVariant: 'preview',
    preferences: {
      agentResponseReady: true,
      todoAttention: true,
      studioCompleted: false,
      failureAttention: true,
      automationRunStatus: true,
      previews: true,
    },
  });
  const registered = await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration,
  });
  assert.equal(registered.registered, true);
  assert.equal(registered.enabled, true);
  assert.equal(registered.preferences.previews, true);
  assert.deepEqual(registered.preferences, {
    agentResponseReady: true,
    todoAttention: true,
    studioCompleted: false,
    failureAttention: true,
    automationRunStatus: true,
    previews: true,
  });
  const legacyRegistration = parseMobilePushRegistration({
    installationId: 'legacy-installation',
    expoPushToken: 'ExpoPushToken[legacy-token]',
    platform: 'android',
    appVariant: 'production',
    preferences: { agentResponseReady: true },
  });
  assert.equal(legacyRegistration.preferences.automationRunStatus, false);
  assert.equal(legacyRegistration.preferences.previews, false);

  assert.equal(
    markdownToNotificationText(
      '# Heading\n\n- **First** item\n- [Second item](https://private.example.test)\n\n`inline`',
    ),
    'Heading First item Second item inline',
  );
  const notificationPreview = createAgentResponseNotificationPreview({
    sessionTitle: '**Push** session',
    serializedMessage: JSON.stringify({
      role: 'assistant',
      content: [{
        type: 'text',
        text: '# Done\n\nSee the **finished** [report](https://private.example.test/report) and `code`.',
      }],
    }),
  });
  assert.deepEqual(notificationPreview, {
    title: 'Push session',
    body: 'Done See the finished report and code.',
  });

  const messages = createAgentResponseReadyMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  });
  const message = messages[0];
  assert.ok(message);
  assert.deepEqual(message.data, {
    type: 'agent.response_ready',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  });
  assert.equal(message.body?.includes('workspace-1'), false);
  assert.equal(message.body?.includes('session-1'), false);
  const previewMessages = createAgentResponseReadyMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    notification: notificationPreview,
    badge: 1,
  });
  const previewMessage = previewMessages[0];
  assert.ok(previewMessage);
  assert.equal(previewMessage.title, 'Push session');
  assert.equal(previewMessage.body, 'Done See the finished report and code.');
  assert.equal(previewMessage.badge, 1);
  assert.equal(previewMessage._contentAvailable, undefined);
  assert.equal(JSON.stringify(previewMessages).includes('private.example.test'), false);
  const widgetRefreshMessages = createInboxWidgetRefreshMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    responseCount: 1,
  });
  assert.deepEqual(widgetRefreshMessages, [{
    to: registration.expoPushToken,
    data: {
      type: 'inbox.widget_refresh',
      instanceId: 'cni_0123456789abcdef01234567',
      widgetRefresh: true,
      responseCount: 1,
    },
    _contentAvailable: true,
  }]);
  assert.deepEqual(createAutomationRunNotificationPreview({
    jobName: '**Daily** [brief](https://private.example.test)',
    status: 'success',
  }), {
    title: 'Daily brief',
    body: 'Scheduled automation completed successfully.',
  });
  assert.deepEqual(createAutomationRunNotificationPreview({
    jobName: 'Daily brief',
    status: 'failed',
  }), {
    title: 'Daily brief',
    body: 'Scheduled automation failed. Open the run for details.',
  });
  assert.deepEqual(createAgentResponseNotificationPreview({
    sessionTitle: null,
    serializedMessage: '',
    locale: 'de',
  }), {
    title: 'Canvas Chat',
    body: 'Dein Agent hat eine Antwort fertiggestellt.',
  });
  assert.deepEqual(createAutomationRunNotificationPreview({
    jobName: '',
    status: 'failed',
    locale: 'de',
  }), {
    title: 'Geplante Automation',
    body: 'Geplante Automation fehlgeschlagen. Öffne den Lauf für Details.',
  });
  const automationStatusMessages = createMobilePushMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    badge: 1,
    target: {
      type: 'automation.completed',
      workspaceId: 'workspace-1',
      runId: 'run-1',
      status: 'success',
    },
  });
  assert.deepEqual(automationStatusMessages[0].data, {
    type: 'automation.completed',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    runId: 'run-1',
    status: 'success',
  });
  assert.equal(automationStatusMessages[0].body, 'A scheduled automation completed successfully.');
  const germanTodoMessages = createMobilePushMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    locale: 'de',
    target: {
      type: 'todo.attention',
      workspaceId: 'workspace-1',
      todoId: 'todo-1',
    },
  });
  assert.equal(germanTodoMessages[0].body, 'Ein Canvas-To-do benötigt deine Aufmerksamkeit.');

  const studioPreviewUrl = createStudioPushPreviewUrl({
    outputId: 'studio-output-1',
    now,
  });
  assert.ok(studioPreviewUrl);
  const parsedStudioPreviewUrl = new URL(studioPreviewUrl);
  assert.equal(parsedStudioPreviewUrl.origin, 'https://canvas.example.test');
  assert.match(parsedStudioPreviewUrl.pathname, /^\/api\/mobile\/v1\/push-previews\/studio\//u);
  const studioPreviewToken = decodeURIComponent(parsedStudioPreviewUrl.pathname.split('/').pop() || '');
  assert.equal(verifyStudioPushPreviewTicket(studioPreviewToken, now + 1_000).outputId, 'studio-output-1');
  assert.throws(
    () => verifyStudioPushPreviewTicket(studioPreviewToken, now + STUDIO_PUSH_PREVIEW_TTL_SECONDS * 1_000),
    /expired/u,
  );
  const issuedStudioPreview = issueStudioPushPreviewTicket('studio-output-2', now);
  assert.equal(issuedStudioPreview.claims.expiresAt - now, STUDIO_PUSH_PREVIEW_TTL_SECONDS * 1_000);

  const studioImageMessages = createMobilePushMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    target: {
      type: 'studio.completed',
      workspaceId: 'workspace-1',
      generationId: 'generation-1',
      outputId: 'studio-output-1',
    },
    notification: {
      title: 'Studio image ready',
      body: 'Your Studio result is ready.',
      imageUrl: studioPreviewUrl,
    },
  });
  assert.deepEqual(studioImageMessages[0].richContent, { image: studioPreviewUrl });
  assert.deepEqual(studioImageMessages[0].data, {
    type: 'studio.completed',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    generationId: 'generation-1',
    outputId: 'studio-output-1',
  });
  assert.equal(studioImageMessages[0].mutableContent, true);
  assert.equal(studioImageMessages[0].ttl, STUDIO_PUSH_PREVIEW_TTL_SECONDS);
  const { db: drizzleDatabase } = await import('../app/lib/db');
  const { studioGenerationOutputs } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const storedStudioPreview = await drizzleDatabase.select()
    .from(studioGenerationOutputs)
    .where(eq(studioGenerationOutputs.id, 'studio-output-1'))
    .limit(1);
  assert.equal(storedStudioPreview[0]?.filePath, studioPreviewPath);
  const { resolveValidatedStudioPath } = await import('../app/lib/integrations/studio-paths');
  assert.equal(resolveValidatedStudioPath(studioPreviewPath), path.join(testRoot, studioPreviewPath));
  const { GET: getStudioPushPreview } = await import(
    '../app/api/mobile/v1/push-previews/studio/[ticket]/route'
  );
  const studioPreviewResponse = await getStudioPushPreview(
    new Request(studioPreviewUrl),
    { params: Promise.resolve({ ticket: studioPreviewToken }) },
  );
  assert.equal(studioPreviewResponse.status, 200);
  assert.equal(studioPreviewResponse.headers.get('content-type'), 'image/png');
  assert.equal(studioPreviewResponse.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.ok((await studioPreviewResponse.arrayBuffer()).byteLength > 0);
  const invalidStudioPreviewResponse = await getStudioPushPreview(
    new Request('https://canvas.example.test/api/mobile/v1/push-previews/studio/invalid'),
    { params: Promise.resolve({ ticket: 'invalid' }) },
  );
  assert.equal(invalidStudioPreviewResponse.status, 404);

  const categoryMessages = createMobilePushMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    target: {
      type: 'attention.failure',
      workspaceId: 'workspace-secret',
      entityKind: 'automation',
      entityId: 'run-secret',
    },
  });
  const categoryMessage = categoryMessages[0];
  assert.ok(categoryMessage);
  assert.deepEqual(categoryMessage.data, {
    type: 'attention.failure',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-secret',
    entityKind: 'automation',
    entityId: 'run-secret',
  });
  assert.equal(categoryMessage.body?.includes('workspace-secret'), false);
  assert.equal(categoryMessage.body?.includes('run-secret'), false);

  const sentPayloads: unknown[] = [];
  const delivery = await sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    delayMs: 0,
    fetcher: async (_url, init) => {
      sentPayloads.push(JSON.parse(String(init?.body)));
      return Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] });
    },
  });
  assert.deepEqual(delivery, { attempted: 1, accepted: 1 });
  assert.deepEqual(sentPayloads, [[{
    ...previewMessages[0],
    badge: 2,
  }], createInboxWidgetRefreshMessages({
    tokens: [registration.expoPushToken],
    instanceId: 'cni_0123456789abcdef01234567',
    responseCount: 2,
  })]);

  let duplicatePushAttempts = 0;
  const duplicateFetcher = async () => {
    duplicatePushAttempts += 1;
    if (duplicatePushAttempts === 2) {
      return Response.json({ data: [{ status: 'ok', id: 'widget-refresh-ticket' }] });
    }
    return Response.json({
      data: [{ status: 'error', details: { error: 'MessageTooBig' } }],
    });
  };
  const duplicateDeliveries = await Promise.all([
    sendAgentResponseReadyPush({
      userId: 'push-user',
      instanceId: 'cni_0123456789abcdef01234567',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      delayMs: 30,
      fetcher: duplicateFetcher,
    }),
    sendAgentResponseReadyPush({
      userId: 'push-user',
      instanceId: 'cni_0123456789abcdef01234567',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      delayMs: 30,
      fetcher: duplicateFetcher,
    }),
  ]);
  assert.equal(duplicatePushAttempts, 2);
  assert.deepEqual(duplicateDeliveries, [
    { attempted: 1, accepted: 0 },
    { attempted: 1, accepted: 0 },
  ]);

  const readDatabase = await openDb();
  await readDatabase.run(
    'UPDATE pi_sessions SET last_viewed_at = last_message_at WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  );
  await readDatabase.close();
  const readSuppressed = await sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    delayMs: 0,
    fetcher: async () => {
      throw new Error('A read agent response must not contact Expo.');
    },
  });
  assert.deepEqual(readSuppressed, { attempted: 0, accepted: 0 });

  const raceDatabase = await openDb();
  await raceDatabase.run(
    'UPDATE pi_sessions SET last_viewed_at = NULL WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  );
  await raceDatabase.close();
  const readDuringDelayPromise = sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    delayMs: 30,
    fetcher: async () => {
      throw new Error('A response read during the grace period must not contact Expo.');
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const readDuringDelayDatabase = await openDb();
  await readDuringDelayDatabase.run(
    'UPDATE pi_sessions SET last_viewed_at = last_message_at WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  );
  await readDuringDelayDatabase.close();
  assert.deepEqual(await readDuringDelayPromise, { attempted: 0, accepted: 0 });

  const beforeSupersededDatabase = await openDb();
  await beforeSupersededDatabase.run(
    'UPDATE pi_sessions SET last_viewed_at = NULL WHERE user_id = ? AND session_id = ?',
    ['push-user', 'session-1'],
  );
  await beforeSupersededDatabase.close();
  const supersededPromise = sendAgentResponseReadyPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    delayMs: 30,
    fetcher: async () => {
      throw new Error('A superseded agent response must not contact Expo.');
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const supersedingDatabase = await openDb();
  await supersedingDatabase.run(
    `INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
     VALUES (?, 'assistant', ?, ?, 2)`,
    [insertedSession.id, JSON.stringify({ role: 'assistant', content: 'Newer', timestamp: responseAt + 1_000 }), responseAt + 1_000],
  );
  await supersedingDatabase.run(
    'UPDATE pi_sessions SET last_message_at = ? WHERE user_id = ? AND session_id = ?',
    [responseAt + 1_000, 'push-user', 'session-1'],
  );
  await supersedingDatabase.close();
  assert.deepEqual(await supersededPromise, { attempted: 0, accepted: 0 });

  const afterTicketDatabase = await openDb();
  const ticketDelivery = await afterTicketDatabase.get(
    `SELECT category, entity_id, expo_ticket_id, status
     FROM mobile_push_deliveries
     WHERE expo_ticket_id = ?`,
    ['ticket-1'],
  ) as { category: string; entity_id: string; expo_ticket_id: string; status: string } | undefined;
  await afterTicketDatabase.close();
  assert.deepEqual(ticketDelivery, {
    category: 'agent.response_ready',
    entity_id: 'session-1',
    expo_ticket_id: 'ticket-1',
    status: 'ticket_accepted',
  });

  let receiptPayload: unknown = null;
  const receiptResult = await pollMobilePushReceipts({
    userId: 'push-user',
    now: now + 16 * 60_000,
    fetcher: async (_url, init) => {
      receiptPayload = JSON.parse(String(init?.body));
      return Response.json({ data: { 'ticket-1': { status: 'ok' } } });
    },
  });
  assert.deepEqual(receiptPayload, { ids: ['ticket-1'] });
  assert.deepEqual(receiptResult, { checked: 1, delivered: 1, failed: 0, pending: 0 });
  assert.ok((await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  })).lastDeliveryAt);

  const mutedStudioPayloads: unknown[] = [];
  const mutedStudio = await sendMobileAttentionPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    target: {
      type: 'studio.completed',
      workspaceId: 'workspace-1',
      generationId: 'generation-1',
    },
    fetcher: async (_url, init) => {
      mutedStudioPayloads.push(JSON.parse(String(init?.body)));
      return Response.json({ data: [{ status: 'ok', id: 'muted-widget-refresh-ticket' }] });
    },
  });
  assert.deepEqual(mutedStudio, { attempted: 0, accepted: 0 });
  assert.deepEqual(mutedStudioPayloads, [[{
    to: registration.expoPushToken,
    data: {
      type: 'inbox.widget_refresh',
      instanceId: 'cni_0123456789abcdef01234567',
      widgetRefresh: true,
      responseCount: 2,
    },
    _contentAvailable: true,
  }]]);

  const automationStatusPayloads: unknown[] = [];
  const automationStatusDelivery = await sendAutomationRunStatusPush({
    userId: 'push-user',
    workspaceId: 'workspace-1',
    runId: 'run-scheduled-1',
    jobName: '**Daily** brief',
    status: 'success',
    instanceId: 'cni_0123456789abcdef01234567',
    now,
    fetcher: async (_url, init) => {
      automationStatusPayloads.push(JSON.parse(String(init?.body)));
      if (automationStatusPayloads.length === 2) {
        return Response.json({ data: [{ status: 'ok', id: 'automation-widget-refresh-ticket' }] });
      }
      return Response.json({
        data: [{ status: 'error', details: { error: 'MessageTooBig' } }],
      });
    },
  });
  assert.deepEqual(automationStatusDelivery, { attempted: 1, accepted: 0 });
  assert.deepEqual(automationStatusPayloads, [[{
      ...automationStatusMessages[0],
      title: 'Daily brief',
      body: 'Scheduled automation completed successfully.',
      badge: 2,
      data: {
        ...automationStatusMessages[0].data,
        runId: 'run-scheduled-1',
      },
    }], [{
      to: registration.expoPushToken,
      data: {
        type: 'inbox.widget_refresh',
        instanceId: 'cni_0123456789abcdef01234567',
        widgetRefresh: true,
        responseCount: 2,
      },
      _contentAvailable: true,
    }]]);

  let pushAttempts = 0;
  await sendMobileAttentionPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    target: { type: 'todo.attention', workspaceId: 'workspace-1', todoId: 'todo-1' },
    fetcher: async () => {
      pushAttempts += 1;
      if (pushAttempts === 1) return new Response(null, { status: 503 });
      if (pushAttempts === 3) return Response.json({ data: [{ status: 'ok', id: 'disabled-widget-refresh-ticket' }] });
      return Response.json({
        data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
      });
    },
  });
  assert.equal(pushAttempts, 3);
  const disabled = await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.lastErrorCode, 'DeviceNotRegistered');

  const automaticReregistration = await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration,
  });
  assert.equal(automaticReregistration.enabled, false);
  assert.equal(automaticReregistration.lastErrorCode, 'DeviceNotRegistered');
  const explicitlyReactivated = await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration: { ...registration, reactivate: true },
  });
  assert.equal(explicitlyReactivated.enabled, true);
  assert.equal(explicitlyReactivated.lastErrorCode, null);
  await sendMobileAttentionPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    now,
    target: {
      type: 'attention.failure',
      workspaceId: 'workspace-1',
      entityKind: 'automation',
      entityId: 'run-1',
    },
    fetcher: async () => Response.json({ data: [{ status: 'ok', id: 'ticket-2' }] }),
  });
  const failedReceipt = await pollMobilePushReceipts({
    userId: 'push-user',
    now: now + 32 * 60_000,
    fetcher: async () => Response.json({
      data: {
        'ticket-2': { status: 'error', details: { error: 'DeviceNotRegistered' } },
      },
    }),
  });
  assert.deepEqual(failedReceipt, { checked: 1, delivered: 0, failed: 1, pending: 0 });
  const disabledByReceipt = await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  });
  assert.equal(disabledByReceipt.enabled, false);
  assert.equal(disabledByReceipt.lastErrorCode, 'DeviceNotRegistered');

  await registerMobilePushDevice({
    userId: 'push-user',
    authSessionId: 'auth-session',
    registration: { ...registration, reactivate: true },
  });
  await sendMobileAttentionPush({
    userId: 'push-user',
    instanceId: 'cni_0123456789abcdef01234567',
    now,
    target: { type: 'todo.attention', workspaceId: 'workspace-1', todoId: 'todo-2' },
    fetcher: async () => Response.json({ data: [{ status: 'ok', id: 'ticket-3' }] }),
  });
  const badDeviceReceipt = await pollMobilePushReceipts({
    userId: 'push-user',
    now: now + 48 * 60_000,
    fetcher: async () => Response.json({
      data: {
        'ticket-3': {
          status: 'error',
          details: {
            error: 'DeveloperError',
            apns: { reason: 'BadDeviceToken', statusCode: 400 },
          },
        },
      },
    }),
  });
  assert.deepEqual(badDeviceReceipt, { checked: 1, delivered: 0, failed: 1, pending: 0 });
  const disabledByBadDeviceToken = await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  });
  assert.equal(disabledByBadDeviceToken.enabled, false);
  assert.equal(disabledByBadDeviceToken.lastErrorCode, 'BadDeviceToken');

  const defaultPreferences = parseMobilePushRegistration({
    installationId: 'installation-2',
    expoPushToken: 'ExpoPushToken[defaults-123]',
    platform: 'android',
    appVariant: 'production',
  }).preferences;
  assert.deepEqual(defaultPreferences, {
    agentResponseReady: true,
    todoAttention: true,
    studioCompleted: true,
    failureAttention: true,
    automationRunStatus: false,
    previews: false,
  });

  await unregisterMobilePushDevice({ userId: 'push-user', installationId: 'installation-1' });
  assert.equal((await getMobilePushDeviceStatus({
    userId: 'push-user',
    installationId: 'installation-1',
  })).registered, false);

  assert.throws(() => parseMobilePushRegistration({
    installationId: 'installation-2',
    expoPushToken: 'https://attacker.test/token',
    platform: 'ios',
    appVariant: 'production',
  }), /expoPushToken is invalid/u);

    const bridgeSource = readFileSync(
      path.join(process.cwd(), 'server/chat-event-bridge.ts'),
      'utf8',
    );
    assert.equal(
      bridgeSource.match(/void sendAgentResponseReadyPush\(\{/gu)?.length,
      1,
      'each saved assistant response must schedule exactly one mobile push decision',
    );
    const studioGenerationSource = readFileSync(
      path.join(process.cwd(), 'app/lib/integrations/studio-generation-service.ts'),
      'utf8',
    );
    assert.match(studioGenerationSource, /previewOutputId: outputs\.find\(\(output\) => output\.mimeType\.startsWith\('image\/'\)\)\?\.id/u);
    const studioPreviewRouteSource = readFileSync(
      path.join(process.cwd(), 'app/api/mobile/v1/push-previews/studio/[ticket]/route.ts'),
      'utf8',
    );
    assert.match(studioPreviewRouteSource, /verifyStudioPushPreviewTicket/u);
    assert.match(studioPreviewRouteSource, /output\.type !== 'image'/u);
    assert.match(studioPreviewRouteSource, /'Cache-Control': 'private, no-store, max-age=0'/u);

    await closeDatabaseConnections();
    console.log('mobile-push-devices-test: ok');
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

void main();
