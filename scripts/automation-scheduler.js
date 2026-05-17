#!/usr/bin/env node
/**
 * Standalone Automation Scheduler
 *
 * This script runs as a separate process and polls for due automation jobs.
 * It makes HTTP requests to the Next.js API to execute jobs.
 *
 * Usage: node scripts/automation-scheduler.js
 */

const POLL_INTERVAL_MS = 15_000;
const POLL_MAX_INTERVAL_MS = 120_000;
const POLL_BACKOFF_FACTOR = 2;
const IDLE_TICKS_BEFORE_BACKOFF = 3;
const STARTUP_HEALTH_TIMEOUT_MS = 60_000;

let started = false;
let activeTick = null;
let currentInterval = POLL_INTERVAL_MS;
let consecutiveIdleTicks = 0;
let timer = null;

function getBaseUrl() {
  // Scheduler runs inside the container, so it should connect to localhost:3000
  // (the internal port where Next.js runs, not the external mapped port)
  const port = process.env.PORT || '3000';
  return `http://127.0.0.1:${port}`;
}

async function getInternalToken() {
  return (process.env.CANVAS_INTERNAL_API_KEY && process.env.CANVAS_INTERNAL_API_KEY.trim()) || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBaseUrlReady() {
  const baseUrl = getBaseUrl();
  const startedAt = Date.now();

  while (Date.now() - startedAt < STARTUP_HEALTH_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep waiting until Next.js is reachable.
    }

    await sleep(1000);
  }

  throw new Error(`Health endpoint did not become ready within ${STARTUP_HEALTH_TIMEOUT_MS}ms`);
}

async function queueDueScheduledJobs() {
  const baseUrl = getBaseUrl();
  const token = await getInternalToken();
  if (!token) {
    console.warn('[Scheduler] CANVAS_INTERNAL_API_KEY is missing. Skipping queue-due tick.');
    return [];
  }

  try {
    const response = await fetch(`${baseUrl}/api/automations/scheduler/queue-due`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-canvas-internal-token': token,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      console.warn(`[Scheduler] Failed to queue due jobs: ${response.status} - ${error}`);
      return [];
    }
    const result = await response.json();
    if (result.queued && result.queued.length > 0) {
      console.log(`[Scheduler] Queued ${result.queued.length} due job(s)`);
    }
    return result.queued || [];
  } catch (error) {
    console.warn('[Scheduler] Error queuing due jobs:', error instanceof Error ? error.message : error);
    return [];
  }
}

async function executeReadyRuns() {
  const baseUrl = getBaseUrl();
  const token = await getInternalToken();
  if (!token) {
    console.warn('[Scheduler] CANVAS_INTERNAL_API_KEY is missing. Skipping execute-ready tick.');
    return [];
  }

  try {
    const response = await fetch(`${baseUrl}/api/automations/scheduler/execute-ready`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-canvas-internal-token': token,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      console.warn(`[Scheduler] Failed to execute ready runs: ${response.status} - ${error}`);
      return [];
    }
    const result = await response.json();
    if (result.executed && result.executed.length > 0) {
      console.log(`[Scheduler] Executed ${result.executed.length} ready run(s)`);
    }
    return result.executed || [];
  } catch (error) {
    console.warn('[Scheduler] Error executing ready runs:', error instanceof Error ? error.message : error);
    return [];
  }
}

async function tick() {
  if (activeTick) {
    return activeTick;
  }

  activeTick = (async () => {
    const queuedResult = await queueDueScheduledJobs();
    const executedResult = await executeReadyRuns();
    const hadWork = (queuedResult && queuedResult.length > 0) || (executedResult && executedResult.length > 0);

    if (hadWork) {
      consecutiveIdleTicks = 0;
    } else {
      consecutiveIdleTicks++;
    }

    scheduleNextTick();
  })()
    .catch((error) => {
      console.error('[Scheduler] Tick failed:', error);
      consecutiveIdleTicks++;
      scheduleNextTick();
    })
    .finally(() => {
      activeTick = null;
    });

  return activeTick;
}

function scheduleNextTick() {
  if (timer) {
    clearTimeout(timer);
  }

  if (consecutiveIdleTicks >= IDLE_TICKS_BEFORE_BACKOFF) {
    const nextInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_MAX_INTERVAL_MS);
    if (nextInterval !== currentInterval) {
      console.log(`[Scheduler] No work for ${consecutiveIdleTicks} ticks, backing off to ${nextInterval}ms`);
      currentInterval = nextInterval;
    }
  } else {
    currentInterval = POLL_INTERVAL_MS;
  }

  timer = setTimeout(() => {
    void tick();
  }, currentInterval);
}

async function start() {
  if (started) {
    return;
  }

  console.log('[Scheduler] Starting automation scheduler...');
  console.log(`[Scheduler] Base URL: ${getBaseUrl()}`);
  console.log(`[Scheduler] Poll interval: ${POLL_INTERVAL_MS}ms (backoff up to ${POLL_MAX_INTERVAL_MS}ms)`);

  await waitForBaseUrlReady();

  started = true;

  // Run first tick immediately, it will schedule subsequent ticks
  await tick();

  console.log('[Scheduler] Scheduler started successfully');
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Scheduler] Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Scheduler] Received SIGINT, shutting down...');
  process.exit(0);
});

// Start the scheduler
start().catch((error) => {
  console.error('[Scheduler] Startup failed:', error);
  process.exit(1);
});
