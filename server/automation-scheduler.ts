import { promises as fs } from 'node:fs';

import {
  advanceAutomationJobSchedule,
  listDueAutomationJobs,
  listExecutableAutomationRuns,
  scheduleAutomationJobRun,
} from '@/app/lib/automations/store';
import { resolveSkillsTokenPath } from '@/app/lib/runtime-data-paths';

const POLL_INTERVAL_MS = 15_000;

let started = false;
let activeTick: Promise<void> | null = null;

async function queueDueScheduledJobs() {
  const dueJobs = await listDueAutomationJobs(new Date());

  for (const job of dueJobs) {
    const anchor = job.nextRunAt ? new Date(job.nextRunAt) : new Date();
    try {
      await scheduleAutomationJobRun(job.id, 'scheduled', new Date());
      await advanceAutomationJobSchedule(job.id, anchor);
    } catch (error) {
      console.warn(`[Automationen] Failed to queue scheduled run for ${job.id}:`, error instanceof Error ? error.message : error);
    }
  }
}

async function executeReadyRuns() {
  const runs = await listExecutableAutomationRuns(new Date());
  const port = process.env.PORT || '3000';
  const baseUrl = process.env.BASE_URL?.trim() || `http://127.0.0.1:${port}`;
  let internalToken = process.env.CANVAS_SKILLS_TOKEN || '';

  if (!internalToken) {
    try {
      internalToken = (await fs.readFile(resolveSkillsTokenPath(), 'utf8')).trim();
    } catch {
      internalToken = '';
    }
  }

  for (const run of runs) {
    try {
      const response = await fetch(`${baseUrl}/api/automations/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-canvas-internal-token': internalToken,
        },
        body: JSON.stringify({ runId: run.id }),
      });

      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`Internal execution request failed (${response.status}): ${payload}`);
      }
    } catch (error) {
      console.error(`[Automationen] Failed to execute run ${run.id}:`, error);
    }
  }
}

async function tick() {
  if (activeTick) {
    return activeTick;
  }

  activeTick = (async () => {
    await queueDueScheduledJobs();
    await executeReadyRuns();
  })()
    .catch((error) => {
      console.error('[Automationen] Scheduler tick failed:', error);
    })
    .finally(() => {
      activeTick = null;
    });

  return activeTick;
}

export function startAutomationScheduler() {
  if (started) {
    return;
  }

  started = true;
  void tick();
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS).unref();
}
