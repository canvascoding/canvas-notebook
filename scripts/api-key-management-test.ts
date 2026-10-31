import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function main() {
  const native = process.argv.includes('--native');
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native, ...(native ? { nativePoolMax: 10 as const } : {}) });
  try {
    const management = await import('../app/lib/api-keys/management');
    const secrets = await import('../app/lib/api-keys/secret');
    const integrationsRoute = await import('../app/api/api-access/integrations/route');
    const integrationRoute = await import('../app/api/api-access/integrations/[integrationId]/route');
    const credentialRoute = await import('../app/api/api-access/integrations/[integrationId]/credentials/route');
    const headers = () => fixture.headers('owner');
    const input = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), name: 'Notebook script',
      workspaceIds: ['personal-owner'], expiresAt: Date.now() + 3_600_000, ...extra });
    const context = (integrationId: string) => ({ params: Promise.resolve({ integrationId }) });
    const request = (method: string, body?: unknown, extraHeaders: Record<string, string> = {}, url = '/api/api-access/integrations') => {
      const actualHeaders = headers(); actualHeaders.set('origin', 'http://localhost:3001');
      for (const [name, value] of Object.entries(extraHeaders)) actualHeaders.set(name, value);
      return new NextRequest(`http://localhost:3001${url}`, { method, headers: actualHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const expectCode = (code: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === code);

    // The normal runtime migration must discover both tables and actual indexes.
    const indexes = await fixture.sql.all("SELECT indexname,indexdef FROM pg_indexes WHERE tablename IN ('canvas_api_integrations','canvas_api_keys')") as { indexname: string; indexdef: string }[];
    assert(indexes.some(row => row.indexname === 'idx_canvas_api_keys_one_current' && /WHERE \(revoked_at IS NULL\)/u.test(row.indexdef)));
    const keysForeignKeys = await fixture.sql.all(`SELECT c.confrelid::regclass::text AS target FROM pg_constraint c
      WHERE c.conrelid='canvas_api_keys'::regclass AND c.contype='f'`) as { target: string }[];
    assert(keysForeignKeys.some(row => row.target.endsWith('canvas_api_integrations')));
    assert(!keysForeignKeys.some(row => row.target.endsWith('session')), 'Logout must not cascade-delete programmatic credentials.');

    for (let index = 0; index < 20; index += 1) {
      const issued = secrets.issueApiKeySecret(), parsed = secrets.parseApiKey(issued.key);
      assert(parsed && parsed.id === issued.id);
      assert.equal(Buffer.from(parsed.secret, 'base64url').byteLength, 32);
      assert(secrets.verifyApiKeySecret(parsed.secret, issued.secretHash));
      assert(!secrets.verifyApiKeySecret(`${parsed.secret}x`, issued.secretHash));
      assert(!secrets.verifyApiKeySecret(parsed.secret, 'invalid'));
      assert.equal(secrets.parseApiKey(`${issued.key},${issued.key}`), null);
      assert.equal(secrets.parseApiKey(` ${issued.key}`), null);
    }

    const issueInput = input();
    const response = await integrationsRoute.POST(request('POST', issueInput));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const issued = (await response.json()).data as Awaited<ReturnType<typeof management.createApiIntegration>>;
    assert.deepEqual(issued.integration.actions, ['read']);
    assert.equal(issued.integration.revision, 1);
    const parsed = secrets.parseApiKey(issued.key); assert(parsed);
    const persisted = await fixture.sql.get('SELECT * FROM canvas_api_keys WHERE id=$1', [issued.credential.id]) as Record<string, unknown>;
    assert.equal(persisted.secret_hash, secrets.hashApiKeySecret(parsed.secret));
    assert(!JSON.stringify(persisted).includes(parsed.secret), 'Persisted records must never contain a recoverable key.');

    const listed = await integrationsRoute.GET(request('GET'));
    assert.equal(listed.status, 200);
    const listedBody = await listed.text();
    assert(!listedBody.includes(parsed.secret)); assert(!listedBody.includes(String(persisted.secret_hash)));
    assert(!listedBody.includes('secretHash')); assert(!listedBody.includes('secret_hash'));
    await assert.rejects(management.createApiIntegration(headers(), issueInput), expectCode('API_KEY_ALREADY_ISSUED'));
    const duplicate = await integrationsRoute.POST(request('POST', issueInput));
    assert.equal(duplicate.status, 409); assert(!(await duplicate.text()).includes(parsed.secret));

    await assert.rejects(management.createApiIntegration(new Headers(), input()), expectCode('UNAUTHORIZED'));
    const keyOnly = new Headers({ 'X-Canvas-API-Key': issued.key });
    await assert.rejects(management.listApiIntegrations(keyOnly), expectCode('API_KEY_MANAGEMENT_SESSION_REQUIRED'));
    const mixed = headers(); mixed.set('X-Canvas-API-Key', issued.key);
    await assert.rejects(management.createApiIntegration(mixed, input()), expectCode('API_KEY_MANAGEMENT_SESSION_REQUIRED'));
    assert.equal((await integrationsRoute.POST(request('POST', input(), { origin: 'https://foreign.example.test' }))).status, 403);
    assert.equal((await integrationsRoute.POST(request('POST', input(), { 'sec-fetch-site': 'cross-site' }))).status, 403);
    assert.equal((await integrationsRoute.POST(request('POST', input({ unexpected: true })))).status, 400);
    assert.equal((await integrationsRoute.POST(request('POST', input({ name: 'x'.repeat(17_000) })))).status, 413);
    await assert.rejects(management.createApiIntegration(headers(), input({ workspaceIds: ['personal-alice'] })), expectCode('API_KEY_GRANT_DENIED'));
    await assert.rejects(management.createApiIntegration(headers(), input({ expiresAt: Date.now() - 1 })), expectCode('API_KEY_EXPIRY_INVALID'));
    assert.deepEqual((await management.listApiIntegrations(fixture.headers('alice'))).integrations, []);
    await assert.rejects(management.listApiIntegrationCredentials(fixture.headers('alice'), issued.integration.id), expectCode('API_INTEGRATION_NOT_FOUND'));

    // Concurrent delivery of one issuance request commits exactly one secret.
    const raceInput = input({ name: 'Concurrent delivery' });
    const creates = await Promise.allSettled([management.createApiIntegration(headers(), raceInput), management.createApiIntegration(headers(), raceInput)]);
    assert.equal(creates.filter(value => value.status === 'fulfilled').length, 1);
    assert(creates.some(value => value.status === 'rejected' && expectCode('API_KEY_ALREADY_ISSUED')(value.reason)));
    const count = await fixture.sql.get('SELECT count(*)::integer AS count FROM canvas_api_integrations WHERE creation_request_id=$1', [raceInput.requestId]) as { count: number };
    assert.equal(count.count, 1);

    // Two stale editors may not overwrite grants or rotate each other's result.
    const changes = await Promise.allSettled(['First name', 'Second name'].map(name => management.updateApiIntegration(headers(), issued.integration.id,
      { expectedRevision: 1, name, workspaceIds: ['personal-owner'], actions: ['read', 'edit'] })));
    assert.equal(changes.filter(value => value.status === 'fulfilled').length, 1);
    assert(changes.some(value => value.status === 'rejected' && expectCode('API_INTEGRATION_CHANGED')(value.reason)));
    const rotatedRequest = { requestId: randomUUID(), expectedRevision: 2, expiresAt: Date.now() + 3_600_000 };
    const rotations = await Promise.allSettled([management.rotateApiKey(headers(), issued.integration.id, rotatedRequest),
      management.rotateApiKey(headers(), issued.integration.id, { ...rotatedRequest, requestId: randomUUID() })]);
    assert.equal(rotations.filter(value => value.status === 'fulfilled').length, 1);
    const rotated = rotations.find(value => value.status === 'fulfilled'); assert(rotated?.status === 'fulfilled');
    assert.equal(rotated.value.integration.id, issued.integration.id);
    assert.equal(rotated.value.integration.revision, 3);
    assert.notEqual(rotated.value.credential.id, issued.credential.id);
    const old = await fixture.sql.get('SELECT revoked_at FROM canvas_api_keys WHERE id=$1', [issued.credential.id]) as { revoked_at: number | null };
    assert(old.revoked_at != null);
    const active = await fixture.sql.get('SELECT count(*)::integer AS count FROM canvas_api_keys WHERE integration_id=$1 AND revoked_at IS NULL', [issued.integration.id]) as { count: number };
    assert.equal(active.count, 1);

    // Lose the actual COMMIT reply, then inspect and revoke the unknown key.
    const lostInput = input({ name: 'Lost create response' }); let loseReply = true;
    fixture.setAfterQuery(async query => { if (query === 'COMMIT' && loseReply) { loseReply = false; throw new Error('Lost commit acknowledgement'); } });
    await assert.rejects(management.createApiIntegration(headers(), lostInput), expectCode('API_KEY_OUTCOME_UNKNOWN'));
    fixture.setAfterQuery(undefined);
    const lost = (await management.listApiIntegrations(headers())).integrations.find(row => row.creationRequestId === lostInput.requestId);
    assert(lost?.latestCredential);
    await assert.rejects(management.createApiIntegration(headers(), lostInput), expectCode('API_KEY_ALREADY_ISSUED'));
    const revoke = await credentialRoute.DELETE(request('DELETE', { expectedRevision: lost.revision, credentialId: lost.latestCredential.id }), context(lost.id));
    assert.equal(revoke.status, 200);
    assert((await management.listApiIntegrationCredentials(headers(), lost.id)).credentials.every(row => row.revokedAt != null));

    const lostRotationRequest = { requestId: randomUUID(), expectedRevision: 3, expiresAt: Date.now() + 3_600_000 }; loseReply = true;
    fixture.setAfterQuery(async query => { if (query === 'COMMIT' && loseReply) { loseReply = false; throw new Error('Lost rotation acknowledgement'); } });
    await assert.rejects(management.rotateApiKey(headers(), issued.integration.id, lostRotationRequest), expectCode('API_KEY_OUTCOME_UNKNOWN'));
    fixture.setAfterQuery(undefined);
    await assert.rejects(management.rotateApiKey(headers(), issued.integration.id, lostRotationRequest), expectCode('API_KEY_ALREADY_ISSUED'));
    const history = await management.listApiIntegrationCredentials(headers(), issued.integration.id);
    assert.equal(history.credentials.length, 3);
    assert.equal(history.integration.revision, 4);
    assert.equal(history.credentials.filter(row => row.revokedAt == null).length, 1);
    assert(history.credentials.some(row => row.issuanceRequestId === lostRotationRequest.requestId));

    // A real database rejection during rotation rolls back the old-key revoke.
    const rejectedRequestId = randomUUID();
    await fixture.sql.run(`ALTER TABLE canvas_api_keys ADD CONSTRAINT api_key_test_rejected_issue
      CHECK (issuance_request_id <> '${rejectedRequestId}') NOT VALID`);
    try {
      const rejected = await credentialRoute.POST(request('POST', { requestId: rejectedRequestId, expectedRevision: 4,
        expiresAt: Date.now() + 3_600_000 }), context(issued.integration.id));
      assert.equal(rejected.status, 503);
      const unchanged = await management.listApiIntegrationCredentials(headers(), issued.integration.id);
      assert.equal(unchanged.integration.revision, 4);
      assert.equal(unchanged.credentials.filter(row => row.revokedAt == null).length, 1);
      assert.equal(unchanged.credentials.find(row => row.revokedAt == null)!.id,
        history.credentials.find(row => row.revokedAt == null)!.id);
    } finally { await fixture.sql.run('ALTER TABLE canvas_api_keys DROP CONSTRAINT api_key_test_rejected_issue'); }

    await management.createApiIntegration(fixture.headers('manager'), input({ name: 'Read-only team', workspaceIds: ['store-team'] }));
    await assert.rejects(management.createApiIntegration(fixture.headers('manager'), input({ workspaceIds: ['store-team'], actions: ['edit'] })),
      expectCode('API_KEY_GRANT_DENIED'));
    await assert.rejects(management.createApiIntegration(fixture.headers('manager'), input({ workspaceIds: ['store-team'], actions: ['recover'] })),
      expectCode('API_KEY_GRANT_DENIED'));

    if (native) {
      // The independent ACL writer must wait for the current issuance phase;
      // the next phase observes the committed revocation, without a grant cache.
      let release!: () => void, reached!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const checked = new Promise<void>(resolve => { reached = resolve; });
      fixture.setAfterRead(async query => { if (query.includes("encode(sha256(convert_to(s.token")) { reached(); await held; } });
      const issuing = management.createApiIntegration(fixture.headers('manager'), input({ name: 'Fenced issuance', workspaceIds: ['store-team'] }));
      const observer = await fixture.openObserverConnection();
      let revoking: Promise<unknown> | undefined;
      try {
        await checked;
        const backend = await observer.get('SELECT pg_backend_pid() AS pid') as { pid: number };
        revoking = Promise.resolve(observer.run("UPDATE canvas_workspace_members SET can_read=0,can_manage=0 WHERE workspace_id='store-team' AND user_id='manager'"));
        let waiting = false;
        for (let attempt = 0; attempt < 40 && !waiting; attempt += 1) {
          const state = await fixture.sql.get('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [backend.pid]) as { wait_event_type: string | null };
          waiting = state.wait_event_type === 'Lock';
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(waiting, 'The ACL writer must be blocked by the real issuance transaction.');
        release(); await issuing; await revoking;
      } finally {
        release(); fixture.setAfterRead(undefined);
        await Promise.allSettled([issuing, ...(revoking ? [revoking] : [])]); await observer.close();
      }
      await assert.rejects(management.createApiIntegration(fixture.headers('manager'), input({ workspaceIds: ['store-team'] })),
        expectCode('API_KEY_GRANT_DENIED'));

      const { createPublicRateLimitStore } = await import('../app/lib/security/public-rate-limit-store');
      const workers = [createPublicRateLimitStore(fixture.openObserverConnection), createPublicRateLimitStore(fixture.openObserverConnection)];
      const budgetKey = `api-key-test-worker:${randomUUID()}`;
      const decisions = await Promise.all(workers.map(consume => consume([{ key: budgetKey, limit: 1, windowMs: 60_000 }])));
      assert.equal(decisions.filter(decision => decision.ok).length, 1, 'Independent workers share the same atomic PostgreSQL budget.');
    }

    await management.createApiIntegration(fixture.headers('bob'), input({ name: 'Bob client', workspaceIds: ['personal-bob'] }));
    await fixture.sql.run("UPDATE \"user\" SET banned=1 WHERE id='bob'");
    await assert.rejects(management.listApiIntegrations(fixture.headers('bob')), expectCode('UNAUTHORIZED'));
    await fixture.sql.run("UPDATE \"user\" SET banned=0 WHERE id='bob'");
    await fixture.sql.run("UPDATE team_memberships SET status='removed' WHERE user_id='alice'");
    await assert.rejects(management.listApiIntegrations(fixture.headers('alice')), expectCode('UNAUTHORIZED'));

    // Pagination is stable and never crosses owners; listing uses one bounded
    // integration/latest-key query rather than a query for each listed row.
    let listingReads = 0;
    fixture.setBeforeRead(async query => { if (query.includes('row_to_json(credential)')) listingReads += 1; });
    const firstPage = await management.listApiIntegrations(headers(), { limit: 1 });
    assert.equal(listingReads, 1); fixture.setBeforeRead(undefined);
    assert(firstPage.nextCursor);
    const secondPage = await management.listApiIntegrations(headers(), { limit: 1, afterId: firstPage.nextCursor });
    assert.notEqual(firstPage.integrations[0].id, secondPage.integrations[0].id);
    const credentialPage = await management.listApiIntegrationCredentials(headers(), issued.integration.id, { limit: 1 });
    assert(credentialPage.nextCursor);
    const nextCredential = await management.listApiIntegrationCredentials(headers(), issued.integration.id, { limit: 1, afterId: credentialPage.nextCursor });
    assert.notEqual(credentialPage.credentials[0].id, nextCredential.credentials[0].id);

    // An imported foreign-instance row remains invisible and unmanageable.
    const foreignId = randomUUID();
    await fixture.sql.run(`INSERT INTO canvas_api_integrations(id,owner_user_id,instance_id,name,workspace_ids_json,actions_json,creation_request_id,revision,created_at,updated_at)
      VALUES($1,'owner','foreign-instance','Foreign','["personal-owner"]','["read"]',$2,1,1,1)`, [foreignId, randomUUID()]);
    assert(!(await management.listApiIntegrations(headers())).integrations.some(row => row.id === foreignId));
    await assert.rejects(management.updateApiIntegration(headers(), foreignId, { expectedRevision: 1, name: 'Changed', workspaceIds: ['personal-owner'], actions: ['read'] }), expectCode('API_INTEGRATION_NOT_FOUND'));

    const bucket = `api-key-management:user:${createHash('sha256').update('owner').digest('hex')}`;
    await fixture.sql.run('UPDATE security_public_rate_limits SET count=120,reset_at=$2 WHERE bucket_key=$1', [bucket, Date.now() + 60_000]);
    const limited = await integrationsRoute.GET(request('GET'));
    assert.equal(limited.status, 429); assert(Number(limited.headers.get('retry-after')) >= 1);
    await fixture.sql.run('UPDATE security_public_rate_limits SET count=0 WHERE bucket_key=$1', [bucket]);

    const invalidPath = await integrationRoute.PATCH(request('PATCH', {}), context('invalid'));
    assert.equal(invalidPath.status, 400);
    await fixture.sql.run("DELETE FROM session WHERE id='session-owner'");
    await assert.rejects(management.listApiIntegrations(headers()), expectCode('UNAUTHORIZED'));
    const surviving = await fixture.sql.get('SELECT count(*)::integer AS count FROM canvas_api_keys') as { count: number };
    assert(surviving.count >= 5, 'Session logout preserves issued credentials and their history.');
    console.log(`API-key management ${native ? 'PostgreSQL' : 'PGlite'} passed: real sessions, additive schema, hash-only storage, strict input/CSRF, owner/instance isolation, issuance/rotation races, lost COMMIT replies, revocation, pagination, shared limits and logout retention.`);
  } finally {
    fixture.setAfterQuery(undefined); fixture.setBeforeRead(undefined);
    await fixture.close();
  }
}

main().catch(error => {
  // Never print response objects, SQL parameters, or issued secrets on failure.
  console.error('API-key management test failed:', error instanceof Error ? error.message : 'Unknown failure');
  process.exitCode = 1;
});
