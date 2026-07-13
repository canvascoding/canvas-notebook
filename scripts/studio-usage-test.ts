import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'studio-usage-'));
  process.env.DATA = tempDir;

  const [{ db }, schema, reporting] = await Promise.all([
    import('../app/lib/db'),
    import('../app/lib/db/schema'),
    import('../app/lib/integrations/studio-usage-reporting'),
  ]);
  const { studioGenerations, studioGenerationOutputs, user } = schema;
  const { getStudioUsageDashboard, parseStudioUsageFilters } = reporting;
  const now = new Date('2026-03-16T12:00:00.000Z');
  const adminId = 'studio-admin';
  const alphaId = 'studio-alpha';
  const betaId = 'studio-beta';

  try {
    await db.insert(user).values([
      {
        id: adminId,
        name: 'Studio Admin',
        email: 'admin@example.com',
        emailVerified: true,
        image: null,
        role: 'admin',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: alphaId,
        name: 'Alpha Creator',
        email: 'alpha@example.com',
        emailVerified: true,
        image: null,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: betaId,
        name: 'Beta Creator',
        email: 'beta@example.com',
        emailVerified: true,
        image: null,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(studioGenerations).values([
      {
        id: 'alpha-image',
        userId: alphaId,
        createdByUserId: alphaId,
        mode: 'image',
        aspectRatio: '1:1',
        provider: 'gemini',
        model: 'gemini-image',
        status: 'completed',
        createdAt: new Date('2026-03-10T10:00:00.000Z'),
        updatedAt: now,
      },
      {
        id: 'alpha-video',
        userId: alphaId,
        createdByUserId: alphaId,
        mode: 'video',
        aspectRatio: '16:9',
        provider: 'google',
        model: 'veo-3',
        status: 'completed',
        createdAt: new Date('2026-03-11T10:00:00.000Z'),
        updatedAt: now,
      },
      {
        id: 'alpha-failed-sound',
        userId: alphaId,
        createdByUserId: alphaId,
        mode: 'sound',
        aspectRatio: '1:1',
        provider: 'gemini',
        model: 'lyria',
        status: 'failed',
        createdAt: new Date('2026-03-12T10:00:00.000Z'),
        updatedAt: now,
      },
      {
        id: 'beta-sound',
        userId: betaId,
        createdByUserId: betaId,
        mode: 'sound',
        aspectRatio: '1:1',
        provider: 'gemini',
        model: 'lyria',
        status: 'completed',
        createdAt: new Date('2026-03-11T12:00:00.000Z'),
        updatedAt: now,
      },
    ]);

    await db.insert(studioGenerationOutputs).values([
      {
        id: 'alpha-image-0',
        generationId: 'alpha-image',
        variationIndex: 0,
        type: 'image',
        filePath: 'studio/outputs/alpha-image-0.png',
        createdAt: new Date('2026-03-10T10:02:00.000Z'),
      },
      {
        id: 'alpha-image-1',
        generationId: 'alpha-image',
        variationIndex: 1,
        type: 'image',
        filePath: 'studio/outputs/alpha-image-1.png',
        createdAt: new Date('2026-03-10T10:02:00.000Z'),
      },
      {
        id: 'alpha-video-0',
        generationId: 'alpha-video',
        variationIndex: 0,
        type: 'video',
        filePath: 'studio/outputs/alpha-video-0.mp4',
        createdAt: new Date('2026-03-11T10:03:00.000Z'),
      },
      {
        id: 'beta-sound-0',
        generationId: 'beta-sound',
        variationIndex: 0,
        type: 'sound',
        filePath: 'studio/outputs/beta-sound-0.mp3',
        createdAt: new Date('2026-03-11T12:03:00.000Z'),
      },
    ]);

    const filters = {
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-03-31T23:59:59.999Z'),
    };

    const adminDashboard = await getStudioUsageDashboard(filters, { id: adminId, role: 'admin' });
    assert.deepEqual(adminDashboard.totals, {
      generationCount: 4,
      completedGenerationCount: 3,
      failedGenerationCount: 1,
      outputCount: 4,
      imageCount: 2,
      videoCount: 1,
      soundCount: 1,
    });
    assert.equal(adminDashboard.breakdownBy, 'user');
    assert.deepEqual(
      adminDashboard.timeline.map((row) => [row.day, row.imageCount, row.videoCount, row.soundCount]),
      [
        ['2026-03-10', 2, 0, 0],
        ['2026-03-11', 0, 1, 1],
      ],
    );
    assert.deepEqual(
      adminDashboard.breakdown.map((row) => [row.groupKey, row.outputCount]).sort(),
      [
        [alphaId, 3],
        [betaId, 1],
      ],
    );

    const alphaDashboard = await getStudioUsageDashboard(filters, { id: alphaId, role: 'user' });
    assert.equal(alphaDashboard.totals.generationCount, 3);
    assert.equal(alphaDashboard.totals.outputCount, 3);
    assert.equal(alphaDashboard.totals.imageCount, 2);
    assert.equal(alphaDashboard.totals.videoCount, 1);
    assert.equal(alphaDashboard.totals.soundCount, 0);
    assert.equal(alphaDashboard.totals.failedGenerationCount, 1);
    assert.equal(alphaDashboard.breakdownBy, 'model');

    const adminBetaDashboard = await getStudioUsageDashboard(
      { ...filters, userId: betaId },
      { id: adminId, role: 'admin' },
    );
    assert.equal(adminBetaDashboard.totals.generationCount, 1);
    assert.equal(adminBetaDashboard.totals.soundCount, 1);
    assert.equal(adminBetaDashboard.breakdownBy, 'model');

    const videoDashboard = await getStudioUsageDashboard(
      { ...filters, mediaType: 'video' },
      { id: adminId, role: 'admin' },
    );
    assert.equal(videoDashboard.totals.generationCount, 1);
    assert.equal(videoDashboard.totals.outputCount, 1);
    assert.equal(videoDashboard.totals.videoCount, 1);

    const failedDashboard = await getStudioUsageDashboard(
      { ...filters, status: 'failed' },
      { id: adminId, role: 'admin' },
    );
    assert.equal(failedDashboard.totals.generationCount, 1);
    assert.equal(failedDashboard.totals.failedGenerationCount, 1);
    assert.equal(failedDashboard.totals.outputCount, 0);

    const parsedFilters = parseStudioUsageFilters(new URLSearchParams({
      from: '2026-03-10',
      to: '2026-03-11',
      studioMediaType: 'sound',
      studioStatus: 'completed',
      provider: 'gemini',
    }));
    assert.equal(parsedFilters.from.toISOString(), '2026-03-10T00:00:00.000Z');
    assert.equal(parsedFilters.to.toISOString(), '2026-03-11T23:59:59.999Z');
    assert.equal(parsedFilters.mediaType, 'sound');
    assert.equal(parsedFilters.status, 'completed');
    assert.equal(parsedFilters.provider, 'gemini');

    await assert.rejects(
      getStudioUsageDashboard(
        { ...filters, userId: betaId },
        { id: alphaId, role: 'user' },
      ),
      /FORBIDDEN_USER_FILTER/,
    );

    console.log('[Studio Usage Test] Passed.');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
