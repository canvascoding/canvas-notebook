import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

const { Pool } = pg;
const capability = 'inbox.file_changes.v1';
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3100';
const databaseUrl = process.env.DATABASE_URL;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'Notification smoke is local-only');
assert.ok(databaseUrl && email && password, 'Managed database and bootstrap credentials are required');

function cookies(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

function withCapability(endpoint) {
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}capability=${capability}`;
}

async function jsonRequest(endpoint, options = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, options);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function assertOk(result, label) {
  assert.equal(result.response.status, 200, `${label} failed with ${result.response.status}`);
  assert.equal(result.payload?.success, true, `${label} did not return success`);
  return result.payload;
}

function operationItems(items, operationId) {
  return (items || []).filter((item) => (
    item?.type === 'file.change_review_required'
    && item?.target?.kind === 'file_change'
    && item.target.operationId === operationId
  ));
}

async function login() {
  const result = await jsonRequest('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200, 'Managed-stack login failed');
  const cookie = cookies(result.response);
  assert.ok(cookie, 'Managed-stack login returned no cookie');
  return cookie;
}

async function resolveScope(cookie) {
  const [workspaceResult, preferencesResult, bootstrapResult] = await Promise.all([
    jsonRequest('/api/workspaces', { headers: { cookie, Origin: baseUrl } }),
    jsonRequest('/api/mobile/v1/inbox/preferences', { headers: { cookie, Origin: baseUrl } }),
    jsonRequest('/api/mobile/v1/bootstrap', { headers: { cookie, Origin: baseUrl } }),
  ]);
  const workspaces = assertOk(workspaceResult, 'workspace listing').workspaces;
  const preferences = assertOk(preferencesResult, 'Inbox preferences').data;
  assert.equal(bootstrapResult.response.status, 200, 'mobile bootstrap request failed');
  const bootstrap = bootstrapResult.payload;
  assert.ok(
    bootstrap.mobileApi?.capabilities?.includes(capability),
    'Mobile bootstrap must advertise the file-change capability',
  );
  const included = new Set(
    preferences.sources.filter((source) => source.included).map((source) => source.id),
  );
  const workspace = workspaces.find((candidate) => (
    included.has(candidate.id)
    && candidate.permissions?.canRead
    && candidate.permissions?.canWrite
    && candidate.status !== 'archived'
  ));
  assert.ok(workspace?.id, 'An included writable workspace is required');
  return workspace;
}

async function snapshotState(pool, userId) {
  const [readStates, sessions] = await Promise.all([
    pool.query('SELECT * FROM mobile_inbox_read_states WHERE user_id = $1', [userId]),
    pool.query(`
      SELECT id, last_viewed_at, updated_at
      FROM pi_sessions
      WHERE user_id = $1
    `, [userId]),
  ]);
  return { readStates: readStates.rows, sessions: sessions.rows };
}

async function restoreState(pool, userId, snapshot) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM mobile_inbox_read_states WHERE user_id = $1', [userId]);
    for (const row of snapshot.readStates) {
      await client.query(`
        INSERT INTO mobile_inbox_read_states (
          user_id, workspace_id, item_key, read_at, dismissed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [row.user_id, row.workspace_id, row.item_key, row.read_at, row.dismissed_at,
        row.created_at, row.updated_at]);
    }
    for (const row of snapshot.sessions) {
      await client.query(`
        UPDATE pi_sessions SET last_viewed_at = $2, updated_at = $3 WHERE id = $1
      `, [row.id, row.last_viewed_at, row.updated_at]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedOperation(pool, workspace, operationId, lineageId, documentId, path) {
  const actor = await pool.query('SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1', [email]);
  assert.ok(actor.rows[0]?.id, 'Bootstrap actor was not found');
  const scope = await pool.query(`
    SELECT id, organization_id, type FROM canvas_workspaces WHERE id = $1 LIMIT 1
  `, [workspace.id]);
  assert.ok(scope.rows[0]?.id, 'Selected workspace was not found');
  const { organization_id: organizationId, type: workspaceType } = scope.rows[0];
  const timestamp = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO file_collaboration_lineages (
        id, organization_id, workspace_id, workspace_type, path, status, created_at, archived_at
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6, NULL)
    `, [lineageId, organizationId, workspace.id, workspaceType, path, timestamp]);
    await client.query(`
      INSERT INTO collaboration_documents (
        id, organization_id, workspace_id, workspace_type, path, lineage_id,
        provider, state_version, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'yjs', 1, 'active', $7, $7)
    `, [documentId, organizationId, workspace.id, workspaceType, path, lineageId, timestamp]);
    await client.query(`
      INSERT INTO collaboration_agent_operations (
        operation_id, document_id, workspace_id, organization_id,
        initiated_by_user_id, actor_id, idempotency_key, payload_hash,
        operation_type, requested_mode, status, base_state_vector, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'fvrc-800-smoke', $6, $7,
        'apply', 'review', 'needs_review', $8, $9, $9)
    `, [operationId, documentId, workspace.id, organizationId, actor.rows[0].id,
      `${operationId}-key`, 'a'.repeat(64), Buffer.alloc(0), timestamp]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return actor.rows[0].id;
}

async function cleanupFixture(pool, { userId, workspaceId, operationId, documentId, lineageId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM mobile_inbox_read_states WHERE user_id = $1 AND workspace_id = $2 AND item_key = $3',
      [userId, workspaceId, `file-change:${operationId}`],
    );
    await client.query('DELETE FROM collaboration_agent_operations WHERE operation_id = $1', [operationId]);
    await client.query('DELETE FROM collaboration_documents WHERE id = $1', [documentId]);
    await client.query('DELETE FROM file_collaboration_lineages WHERE id = $1', [lineageId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const suffix = randomUUID();
  const fixture = {
    operationId: `fvrc-800-operation-${suffix}`,
    lineageId: `fvrc-800-lineage-${suffix}`,
    documentId: `fvrc-800-document-${suffix}`,
    path: `fvrc-800-private-${suffix}.md`,
  };
  let snapshot;
  let userId;
  let workspace;
  try {
    const cookie = await login();
    workspace = await resolveScope(cookie);
    const headers = {
      cookie,
      Origin: baseUrl,
      'Content-Type': 'application/json',
      'x-canvas-workspace-id': workspace.id,
    };
    const singleEndpoint = (filter, optedIn = false) => {
      const endpoint = `/api/mobile/v1/inbox?filter=${filter}&limit=100`;
      return optedIn ? withCapability(endpoint) : endpoint;
    };
    const aggregateEndpoint = (filter, optedIn = false) => {
      const endpoint = `/api/mobile/v1/inbox/aggregate?filter=${filter}&limit=100`;
      return optedIn ? withCapability(endpoint) : endpoint;
    };
    const get = (endpoint) => jsonRequest(endpoint, { headers });
    const patch = (endpoint, body) => jsonRequest(endpoint, {
      method: 'PATCH', headers, body: JSON.stringify(body),
    });

    const actor = await pool.query('SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1', [email]);
    userId = actor.rows[0]?.id;
    assert.ok(userId, 'Bootstrap actor was not found');
    snapshot = await snapshotState(pool, userId);

    const [beforeSingleDefault, beforeSingleOptIn, beforeAggregateOptIn, beforeBadgeDefault,
      beforeBadgeOptIn, beforeSummary] = await Promise.all([
      get(singleEndpoint('notifications')),
      get(singleEndpoint('notifications', true)),
      get(aggregateEndpoint('notifications', true)),
      get('/api/mobile/v1/inbox/badge'),
      get(withCapability('/api/mobile/v1/inbox/badge')),
      get('/api/notifications/summary'),
    ]);
    const baseline = {
      singleDefault: assertOk(beforeSingleDefault, 'legacy single Inbox'),
      singleOptIn: assertOk(beforeSingleOptIn, 'opt-in single Inbox'),
      aggregateOptIn: assertOk(beforeAggregateOptIn, 'opt-in aggregate Inbox'),
      badgeDefault: assertOk(beforeBadgeDefault, 'legacy badge'),
      badgeOptIn: assertOk(beforeBadgeOptIn, 'opt-in badge'),
      summary: assertOk(beforeSummary, 'desktop summary').data,
    };

    await seedOperation(pool, workspace, fixture.operationId, fixture.lineageId, fixture.documentId, fixture.path);
    const itemId = `file-change:${fixture.operationId}`;

    const defaultSingle = assertOk(await get(singleEndpoint('notifications')), 'legacy single Inbox after seed');
    const defaultAggregate = assertOk(await get(aggregateEndpoint('notifications')), 'legacy aggregate Inbox after seed');
    assert.equal(operationItems(defaultSingle.items, fixture.operationId).length, 0);
    assert.equal(operationItems(defaultAggregate.items, fixture.operationId).length, 0);
    assert.doesNotMatch(JSON.stringify(defaultSingle), /file\.change_review_required|"kind":"file_change"/u);
    assert.doesNotMatch(JSON.stringify(defaultAggregate), /file\.change_review_required|"kind":"file_change"/u);
    assert.equal(defaultSingle.categories.notifications.badge, baseline.singleDefault.categories.notifications.badge);

    for (const filter of ['notifications', 'all', 'unread']) {
      const single = assertOk(await get(singleEndpoint(filter, true)), `opt-in single ${filter}`);
      const aggregate = assertOk(await get(aggregateEndpoint(filter, true)), `opt-in aggregate ${filter}`);
      assert.equal(operationItems(single.items, fixture.operationId).length, 1);
      assert.equal(operationItems(aggregate.items, fixture.operationId).length, 1);
    }
    const singleAutomation = assertOk(await get(singleEndpoint('automation', true)), 'opt-in single automation');
    const aggregateAutomation = assertOk(await get(aggregateEndpoint('automation', true)), 'opt-in aggregate automation');
    assert.equal(operationItems(singleAutomation.items, fixture.operationId).length, 0);
    assert.equal(operationItems(aggregateAutomation.items, fixture.operationId).length, 0);

    const notificationFeed = assertOk(
      await get(singleEndpoint('notifications', true)),
      'opt-in notification feed',
    );
    const notificationItem = operationItems(notificationFeed.items, fixture.operationId)[0];
    assert.equal(notificationItem.unread, true);
    assert.deepEqual(Object.keys(notificationItem.target).sort(), ['kind', 'lineageId', 'operationId', 'workspaceId']);
    assert.doesNotMatch(JSON.stringify(notificationItem), new RegExp(fixture.path.replaceAll('.', '\\.'), 'u'));
    assert.equal(
      notificationFeed.categories.notifications.badge,
      baseline.singleOptIn.categories.notifications.badge + 1,
    );

    const aggregateFeed = assertOk(
      await get(aggregateEndpoint('notifications', true)),
      'opt-in aggregate notification feed',
    );
    assert.equal(aggregateFeed.counts.unread, baseline.aggregateOptIn.counts.unread + 1);
    const badgeDefault = assertOk(await get('/api/mobile/v1/inbox/badge'), 'legacy badge after seed');
    const badgeOptIn = assertOk(await get(withCapability('/api/mobile/v1/inbox/badge')), 'opt-in badge after seed');
    assert.equal(badgeDefault.count, baseline.badgeDefault.count);
    assert.equal(badgeOptIn.count, baseline.badgeOptIn.count + 1);
    assert.equal(badgeOptIn.count, badgeOptIn.categories.notifications.badge);

    const summary = assertOk(await get('/api/notifications/summary'), 'desktop summary after seed').data;
    assert.equal(operationItems(summary.sections.notifications, fixture.operationId).length, 1);
    assert.equal(operationItems(summary.items, fixture.operationId).length, 1);
    assert.equal(summary.unreadCount, baseline.summary.unreadCount + 1);
    assert.equal(summary.counts.unread, baseline.summary.counts.unread + 1);

    const legacyItemPatch = await patch(singleEndpoint('notifications'), {
      action: 'mark_item_read', itemId,
    });
    assert.equal(legacyItemPatch.response.status, 404, 'Legacy single PATCH must not expose file items');
    assert.equal(
      operationItems(assertOk(await get(singleEndpoint('unread', true)), 'unread after legacy PATCH').items, fixture.operationId).length,
      1,
    );

    assertOk(await patch(singleEndpoint('notifications', true), {
      action: 'mark_item_read', itemId,
    }), 'opt-in single mark-read');
    assert.equal(
      operationItems(assertOk(await get(singleEndpoint('unread', true)), 'unread after mark-read').items, fixture.operationId).length,
      0,
    );
    assertOk(await patch(singleEndpoint('notifications', true), {
      action: 'set_item_read_state', itemId, read: false,
    }), 'opt-in single mark-unread');

    assertOk(await patch('/api/mobile/v1/inbox/aggregate', {
      action: 'mark_category_read', category: 'notifications',
    }), 'legacy aggregate mark-category-read');
    assert.equal(
      operationItems(assertOk(await get(singleEndpoint('unread', true)), 'unread after legacy aggregate PATCH').items, fixture.operationId).length,
      1,
    );
    assertOk(await patch(withCapability('/api/mobile/v1/inbox/aggregate'), {
      action: 'mark_category_read', category: 'notifications',
    }), 'opt-in aggregate mark-category-read');
    assert.equal(
      operationItems(assertOk(await get(singleEndpoint('unread', true)), 'unread after aggregate PATCH').items, fixture.operationId).length,
      0,
    );

    assertOk(await patch(singleEndpoint('notifications', true), {
      action: 'set_item_read_state', itemId, read: false,
    }), 'mark-unread before desktop PATCH');
    assertOk(await patch('/api/notifications/summary', {
      action: 'mark_item_read', itemId, workspaceId: workspace.id,
    }), 'desktop summary mark-read');
    assert.equal(
      operationItems(assertOk(await get(singleEndpoint('unread', true)), 'unread after desktop PATCH').items, fixture.operationId).length,
      0,
    );

    assertOk(await patch(singleEndpoint('notifications', true), {
      action: 'set_item_read_state', itemId, read: false,
    }), 'mark-unread before dismiss');
    assertOk(await patch(singleEndpoint('notifications', true), {
      action: 'dismiss_item', itemId,
    }), 'opt-in single dismiss');
    assert.equal(
      operationItems(assertOk(await get(singleEndpoint('notifications', true)), 'feed after dismiss').items, fixture.operationId).length,
      0,
    );
    await pool.query(
      'UPDATE collaboration_agent_operations SET updated_at = $2 WHERE operation_id = $1',
      [fixture.operationId, Date.now() + 5_000],
    );
    const reactivated = operationItems(
      assertOk(await get(singleEndpoint('unread', true)), 'feed after actionable update').items,
      fixture.operationId,
    );
    assert.equal(reactivated.length, 1);
    assert.equal(reactivated[0].unread, true);

    console.log(JSON.stringify({
      component: 'file_change_review_notifications',
      version: 1,
      outcome: 'success',
      contracts: {
        desktopSummary: true,
        mobileSingle: true,
        mobileAggregate: true,
        mobileBadge: true,
        capabilityIsolation: true,
        patchRoutes: true,
        stateRestoration: true,
      },
    }));
  } finally {
    if (userId && workspace) {
      await cleanupFixture(pool, {
        userId,
        workspaceId: workspace.id,
        operationId: fixture.operationId,
        documentId: fixture.documentId,
        lineageId: fixture.lineageId,
      }).catch(() => undefined);
      if (snapshot) await restoreState(pool, userId, snapshot);
    }
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`file-change-review-notification-api-smoke: failed: ${message}`);
  process.exitCode = 1;
});
