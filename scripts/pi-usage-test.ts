import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentMessage } from '@mariozechner/pi-agent-core';

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-'));
  process.env.SQLITE_PATH = path.join(tempDir, 'usage.sqlite');

  const [{ db }, schema, usageEvents, usageReporting, usageFormat] = await Promise.all([
    import('../app/lib/db'),
    import('../app/lib/db/schema'),
    import('../app/lib/pi/usage-events'),
    import('../app/lib/pi/usage-reporting'),
    import('../app/lib/pi/usage-format'),
  ]);

  const {
    user,
    piSessions,
    piUsageEvents,
  } = schema;
  const {
    buildPiUsageFingerprint,
    extractPiUsageEventValues,
    persistPiUsageEvents,
  } = usageEvents;
  const {
    getUsageEvents,
    getUsageSummary,
    parsePage,
    parsePageSize,
    parseUsageFilters,
  } = usageReporting;
  const {
    formatUsageBreakdown,
    formatUsageCompact,
    formatUsageCost,
    hasRenderableUsage,
  } = usageFormat;

  const { sql } = await import('drizzle-orm');

  const userId = 'user-1';
  const adminId = 'admin-1';
  const otherUserId = 'user-2';
  const alphaSessionId = 'sess-alpha';
  const budgetSessionId = 'sess-budget';
  const otherSessionId = 'sess-other';
  const now = new Date('2026-03-16T12:00:00.000Z');

  try {
    await db.insert(user).values([
      {
        id: userId,
        name: 'Canvas User',
        email: 'user@example.com',
        emailVerified: true,
        image: null,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: adminId,
        name: 'Canvas Admin',
        email: 'admin@example.com',
        emailVerified: true,
        image: null,
        role: 'admin',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherUserId,
        name: 'Other User',
        email: 'other@example.com',
        emailVerified: true,
        image: null,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(piSessions).values([
      {
        sessionId: alphaSessionId,
        userId,
        provider: 'openai',
        model: 'gpt-4o',
        title: 'Alpha Session',
        createdAt: now,
        updatedAt: now,
      },
      {
        sessionId: budgetSessionId,
        userId,
        provider: 'ollama',
        model: 'llama3.2',
        title: 'Budget Session',
        createdAt: now,
        updatedAt: now,
      },
      {
        sessionId: otherSessionId,
        userId: otherUserId,
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        title: 'Other Session',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const alphaAssistant = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Alpha answer' }],
      api: 'mock',
      provider: 'openai',
      model: 'gpt-4o',
      usage: {
        input: 120,
        output: 80,
        cacheRead: 10,
        cacheWrite: 0,
        totalTokens: 210,
        cost: {
          input: 0.0012,
          output: 0.004,
          cacheRead: 0.0001,
          cacheWrite: 0,
          total: 0.0053,
        },
      },
      stopReason: 'stop',
      timestamp: new Date('2026-03-10T10:15:00.000Z'),
    } satisfies AgentMessage;

    const zeroCostAssistant = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Local answer' }],
      api: 'mock',
      provider: 'ollama',
      model: 'llama3.2',
      usage: {
        input: 20,
        output: 30,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 50,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: 'stop',
      timestamp: new Date('2026-03-11T08:00:00.000Z'),
    } satisfies AgentMessage;

    const otherUserAssistant = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Other user answer' }],
      api: 'mock',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      usage: {
        input: 200,
        output: 100,
        cacheRead: 0,
        cacheWrite: 40,
        totalTokens: 340,
        cost: {
          input: 0.004,
          output: 0.012,
          cacheRead: 0,
          cacheWrite: 0.0005,
          total: 0.0165,
        },
      },
      stopReason: 'error',
      timestamp: new Date('2026-03-12T09:30:00.000Z'),
      errorMessage: 'Mock failure',
    } satisfies AgentMessage;

    const noUsageAssistant = {
      role: 'assistant',
      content: [{ type: 'text', text: 'No usage' }],
      api: 'mock',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: 'stop',
      timestamp: new Date('2026-03-10T10:20:00.000Z'),
    } satisfies AgentMessage;

    const extractionRows = extractPiUsageEventValues({
      sessionId: alphaSessionId,
      userId,
      sessionTitleSnapshot: 'Alpha Session',
      messages: [
        {
          role: 'user',
          content: 'Question',
          timestamp: new Date('2026-03-10T10:10:00.000Z'),
        } satisfies AgentMessage,
        alphaAssistant,
        noUsageAssistant,
        zeroCostAssistant,
      ],
    });

    assert.equal(extractionRows.length, 2);
    assert.equal(extractionRows[0]?.sessionTitleSnapshot, 'Alpha Session');
    assert.equal(extractionRows[0]?.provider, 'openai');
    assert.equal(extractionRows[0]?.totalTokens, 210);
    assert.equal(extractionRows[1]?.provider, 'ollama');
    assert.equal(extractionRows[1]?.totalCost, 0);

    const fingerprintA = buildPiUsageFingerprint(alphaSessionId, alphaAssistant);
    const fingerprintB = buildPiUsageFingerprint(alphaSessionId, alphaAssistant);
    const fingerprintC = buildPiUsageFingerprint(alphaSessionId, {
      ...alphaAssistant,
      content: [{ type: 'text', text: 'Changed answer' }],
    });

    assert.equal(fingerprintA, fingerprintB);
    assert.notEqual(fingerprintA, fingerprintC);

    await persistPiUsageEvents({
      sessionId: alphaSessionId,
      userId,
      messages: [alphaAssistant],
    });
    await persistPiUsageEvents({
      sessionId: alphaSessionId,
      userId,
      messages: [alphaAssistant],
    });
    await persistPiUsageEvents({
      sessionId: budgetSessionId,
      userId,
      messages: [zeroCostAssistant],
    });
    await persistPiUsageEvents({
      sessionId: otherSessionId,
      userId: otherUserId,
      messages: [otherUserAssistant],
    });

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(piUsageEvents);

    assert.equal(Number(countRow?.count ?? 0), 3);

    const defaultFilters = parseUsageFilters(new URLSearchParams());
    assert.equal(defaultFilters.groupBy, 'day');
    assert.ok(defaultFilters.from <= defaultFilters.to);
    assert.equal(parsePage(new URLSearchParams('page=0')), 1);
    assert.equal(parsePageSize(new URLSearchParams('pageSize=999')), 200);

    const userDaySummary = await getUsageSummary(
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-31T23:59:59.999Z'),
        groupBy: 'day',
      },
      { id: userId, role: 'user' },
    );

    assert.equal(userDaySummary.totals.totalTokens, 260);
    assert.equal(userDaySummary.totals.sessionCount, 2);
    assert.equal(userDaySummary.rows.length, 2);
    assert.deepEqual(
      userDaySummary.rows.map((row) => row.groupKey),
      ['2026-03-10', '2026-03-11'],
    );

    const providerSummary = await getUsageSummary(
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-31T23:59:59.999Z'),
        groupBy: 'provider',
      },
      { id: userId, role: 'user' },
    );
    assert.deepEqual(
      providerSummary.rows.map((row) => row.groupKey).sort(),
      ['ollama', 'openai'],
    );

    const modelSummary = await getUsageSummary(
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-31T23:59:59.999Z'),
        groupBy: 'model',
      },
      { id: userId, role: 'user' },
    );
    assert.deepEqual(
      modelSummary.rows.map((row) => row.groupKey).sort(),
      ['gpt-4o', 'llama3.2'],
    );

    const sessionSummary = await getUsageSummary(
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-31T23:59:59.999Z'),
        groupBy: 'session',
      },
      { id: userId, role: 'user' },
    );
    assert.deepEqual(
      sessionSummary.rows.map((row) => row.label).sort(),
      ['Alpha Session', 'Budget Session'],
    );

    const adminUserSummary = await getUsageSummary(
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-31T23:59:59.999Z'),
        groupBy: 'user',
      },
      { id: adminId, role: 'admin' },
    );
    assert.deepEqual(
      adminUserSummary.rows.map((row) => row.groupKey).sort(),
      [userId, otherUserId],
    );

    await assert.rejects(
      getUsageSummary(
        {
          from: new Date('2026-03-01T00:00:00.000Z'),
          to: new Date('2026-03-31T23:59:59.999Z'),
          groupBy: 'user',
        },
        { id: userId, role: 'user' },
      ),
      /FORBIDDEN_USER_GROUPING/,
    );

    await assert.rejects(
      getUsageSummary(
        {
          from: new Date('2026-03-01T00:00:00.000Z'),
          to: new Date('2026-03-31T23:59:59.999Z'),
          groupBy: 'day',
          userId: otherUserId,
        },
        { id: userId, role: 'user' },
      ),
      /FORBIDDEN_USER_FILTER/,
    );

    const filteredEvents = await getUsageEvents(
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-31T23:59:59.999Z'),
        groupBy: 'day',
        sessionQuery: 'Alpha',
      },
      { id: userId, role: 'user' },
      1,
      50,
    );

    assert.equal(filteredEvents.rows.length, 1);
    assert.equal(filteredEvents.rows[0]?.sessionId, alphaSessionId);
    assert.match(filteredEvents.rows[0]?.assistantTimestamp || '', /^2026-03-10T10:15:00/);

    assert.equal(hasRenderableUsage(alphaAssistant.usage), true);
    assert.equal(hasRenderableUsage(noUsageAssistant.usage), false);
    assert.equal(formatUsageCompact(alphaAssistant.usage), '210 tok · $0.0053');
    assert.equal(formatUsageBreakdown(alphaAssistant.usage), '120 in / 80 out');
    assert.equal(formatUsageCompact(zeroCostAssistant.usage), '50 tok · $0.0000');
    assert.equal(formatUsageCost(0.01234), '$0.0123');

    console.log('[PI Usage Test] Passed.');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
