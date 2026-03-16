import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'canvas-pi-usage-'));
process.env.SQLITE_PATH = path.join(tempDir, 'sqlite.db');

async function run() {
  const [{ db }, schema, usageEvents, usageReporting, usageFormat] = await Promise.all([
    import('../app/lib/db'),
    import('../app/lib/db/schema'),
    import('../app/lib/pi/usage-events'),
    import('../app/lib/pi/usage-reporting'),
    import('../app/lib/pi/usage-format'),
  ]);

  try {
    await db.insert(schema.user).values([
      {
        id: 'user-main',
        name: 'Main User',
        email: 'main@example.com',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        role: 'user',
      },
      {
        id: 'user-admin',
        name: 'Admin User',
        email: 'admin@example.com',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        role: 'admin',
      },
    ]);

    await db.insert(schema.piSessions).values([
      {
        sessionId: 'sess-alpha',
        userId: 'user-main',
        provider: 'openai',
        model: 'gpt-4o',
        title: 'Alpha Session',
        createdAt: new Date('2026-03-15T10:00:00.000Z'),
        updatedAt: new Date('2026-03-15T10:00:00.000Z'),
      },
      {
        sessionId: 'sess-beta',
        userId: 'user-main',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        title: 'Beta Session',
        createdAt: new Date('2026-03-16T10:00:00.000Z'),
        updatedAt: new Date('2026-03-16T10:00:00.000Z'),
      },
    ]);

    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'First answer' }],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-4o',
        usage: {
          input: 120,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 160,
          cost: {
            input: 0.0012,
            output: 0.0008,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.002,
          },
        },
        stopReason: 'stop',
        timestamp: new Date('2026-03-15T12:00:00.000Z').getTime(),
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Second answer' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        usage: {
          input: 80,
          output: 20,
          cacheRead: 10,
          cacheWrite: 0,
          totalTokens: 110,
          cost: {
            input: 0.0015,
            output: 0.001,
            cacheRead: 0.0001,
            cacheWrite: 0,
            total: 0.0026,
          },
        },
        stopReason: 'toolUse',
        timestamp: new Date('2026-03-16T12:00:00.000Z').getTime(),
      },
    ] as const;

    const extracted = usageEvents.extractPiUsageEventValues({
      sessionId: 'sess-alpha',
      userId: 'user-main',
      sessionTitleSnapshot: 'Alpha Session',
      messages: [messages[0]],
    });
    assert.equal(extracted.length, 1, 'expected one extracted usage row');
    assert.equal(extracted[0].totalTokens, 160);
    assert.equal(extracted[0].sessionTitleSnapshot, 'Alpha Session');

    const fingerprintA = usageEvents.buildPiUsageFingerprint('sess-alpha', messages[0]);
    const fingerprintB = usageEvents.buildPiUsageFingerprint('sess-alpha', messages[0]);
    assert.equal(fingerprintA, fingerprintB, 'fingerprint must be stable');

    await usageEvents.persistPiUsageEvents({
      sessionId: 'sess-alpha',
      userId: 'user-main',
      messages: [messages[0]],
    });
    await usageEvents.persistPiUsageEvents({
      sessionId: 'sess-alpha',
      userId: 'user-main',
      messages: [messages[0]],
    });
    await usageEvents.persistPiUsageEvents({
      sessionId: 'sess-beta',
      userId: 'user-main',
      messages: [messages[1]],
    });

    const storedEvents = await db.select().from(schema.piUsageEvents);
    assert.equal(storedEvents.length, 2, 'duplicate usage events should be deduplicated');

    for (const groupBy of ['day', 'provider', 'model', 'user', 'session'] as const) {
      const summary = await usageReporting.getUsageSummary(
        {
          from: new Date('2026-03-01T00:00:00.000Z'),
          to: new Date('2026-03-31T23:59:59.999Z'),
          groupBy,
        },
        { id: 'user-admin', role: 'admin' },
      );

      assert.equal(summary.totals.totalTokens, 270, `summary totals should match for ${groupBy}`);
      assert.ok(summary.rows.length > 0, `summary rows expected for ${groupBy}`);
    }

    const scopedSummary = await usageReporting.getUsageSummary(
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-31T23:59:59.999Z'),
        groupBy: 'day',
      },
      { id: 'user-main', role: 'user' },
    );
    assert.equal(scopedSummary.totals.eventCount, 2, 'non-admin should see own events');

    await assert.rejects(
      () =>
        usageReporting.getUsageSummary(
          {
            from: new Date('2026-03-01T00:00:00.000Z'),
            to: new Date('2026-03-31T23:59:59.999Z'),
            groupBy: 'user',
          },
          { id: 'user-main', role: 'user' },
        ),
      /FORBIDDEN_USER_GROUPING/,
    );

    const events = await usageReporting.getUsageEvents(
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-31T23:59:59.999Z'),
        groupBy: 'day',
        sessionQuery: 'Beta',
      },
      { id: 'user-admin', role: 'admin' },
      1,
      20,
    );
    assert.equal(events.rows.length, 1, 'sessionQuery should filter usage events');
    assert.equal(events.rows[0].sessionTitleSnapshot, 'Beta Session');

    const parsedFilters = usageReporting.parseUsageFilters(
      new URLSearchParams({
        from: '2026-03-01',
        to: '2026-03-16',
        provider: 'openai',
        groupBy: 'provider',
      }),
    );
    assert.equal(parsedFilters.provider, 'openai');
    assert.equal(parsedFilters.groupBy, 'provider');

    assert.equal(usageFormat.formatUsageCompact(messages[0].usage), '160 tok · $0.0020');
    assert.equal(usageFormat.formatUsageBreakdown(messages[0].usage), '120 in / 40 out');

    console.log('[PI Usage Test] All usage tests passed.');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('[PI Usage Test] FAILED:', error);
  process.exit(1);
});
