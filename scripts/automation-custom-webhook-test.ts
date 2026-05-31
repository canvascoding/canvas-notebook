import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-webhook-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;

async function main() {
  const { db } = await import('../app/lib/db');
  const { user, automationWebhookTriggers } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const {
    createCustomWebhookAutomationJob,
    getAutomationJob,
    getAutomationWebhookEventByKeys,
    getAutomationWebhookTriggerWithJob,
    recordAutomationWebhookEvent,
    rotateAutomationWebhookSecret,
    scheduleAutomationJobRun,
    updateAutomationJob,
  } = await import('../app/lib/automations/store');
  const { verifyAutomationWebhookSecret } = await import('../app/lib/automations/webhook-secret');

  const now = new Date();
  const userId = 'user-custom-webhook';
  await db.insert(user).values({
    id: userId,
    name: 'Automation Webhook Tester',
    email: 'automation-webhook@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const created = await createCustomWebhookAutomationJob({
    name: 'Deploy Webhook',
    prompt: 'Summarize the deployment event.',
    workspaceContextPaths: ['deployments'],
    targetOutputPath: 'automation/deployments',
    status: 'active',
  }, userId);

  assert.ok(created.job.customWebhookId);
  assert.ok(created.secret.startsWith('whsec_'));
  assert.equal(created.job.schedule.kind, 'webhook');
  assert.equal(created.job.jobType, 'webhook');
  assert.equal(created.job.customWebhookSecretPreview?.includes('...'), true);

  const [storedTrigger] = await db
    .select()
    .from(automationWebhookTriggers)
    .where(eq(automationWebhookTriggers.id, created.job.customWebhookId!));
  assert.ok(storedTrigger);
  assert.notEqual(storedTrigger.secretHash, created.secret);
  assert.equal(verifyAutomationWebhookSecret(created.secret, storedTrigger.secretHash), true);
  assert.equal(verifyAutomationWebhookSecret('wrong-secret', storedTrigger.secretHash), false);

  const triggerWithJob = await getAutomationWebhookTriggerWithJob(created.job.customWebhookId!);
  assert.equal(triggerWithJob?.job.id, created.job.id);
  assert.equal(triggerWithJob?.trigger.secretPreview, created.job.customWebhookSecretPreview);

  const rotated = await rotateAutomationWebhookSecret(created.job.customWebhookId!, userId);
  assert.ok(rotated);
  assert.notEqual(rotated!.secret, created.secret);
  assert.equal(rotated!.job.customWebhookId, created.job.customWebhookId);

  const run = await scheduleAutomationJobRun(created.job.id, 'webhook', new Date(), {
    metadataJson: {
      webhook: {
        provider: 'custom',
        source: 'custom',
        eventId: 'evt-direct',
        webhookId: created.job.customWebhookId,
        triggerId: created.job.customWebhookId,
        triggerSlug: 'custom_webhook',
        toolkitSlug: 'custom',
        timestamp: new Date().toISOString(),
        data: { ok: true },
      },
    },
  });
  assert.ok(run);
  assert.equal(run!.triggerType, 'webhook');
  assert.equal(run!.metadataJson?.webhook && typeof run!.metadataJson.webhook === 'object', true);

  await updateAutomationJob(created.job.id, { status: 'paused' });
  await recordAutomationWebhookEvent({
    webhookId: created.job.customWebhookId!,
    jobId: created.job.id,
    eventId: 'evt-paused',
    idempotencyKey: 'evt-paused',
    status: 'ignored',
    error: 'paused',
    metadataJson: { eventId: 'evt-paused', payloadKeys: ['status'] },
  });
  const duplicateByEvent = await getAutomationWebhookEventByKeys({
    webhookId: created.job.customWebhookId!,
    eventId: 'evt-paused',
  });
  assert.equal(duplicateByEvent?.status, 'ignored');
  const duplicateByIdempotency = await getAutomationWebhookEventByKeys({
    webhookId: created.job.customWebhookId!,
    idempotencyKey: 'evt-paused',
  });
  assert.equal(duplicateByIdempotency?.error, 'paused');

  const loaded = await getAutomationJob(created.job.id);
  assert.equal(loaded?.customWebhookId, created.job.customWebhookId);

  console.log('automation custom webhook tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
