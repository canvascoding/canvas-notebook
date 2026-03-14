import {
  advanceAutomationJobSchedule,
  listDueAutomationJobs,
  listExecutableAutomationRuns,
  scheduleAutomationJobRun,
} from '@/app/lib/automations/store';
import { executeAutomationRun } from '@/app/lib/automations/runner';

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

  for (const run of runs) {
    try {
      await executeAutomationRun(run.id);
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
