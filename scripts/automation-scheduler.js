#!/usr/bin/env node
/**
 * Standalone Automation Scheduler
 *
 * This script runs as a separate process and polls for due automation jobs.
 * It makes HTTP requests to the Next.js API to execute jobs.
 *
 * Usage: node scripts/automation-scheduler.js
 */

const crypto = require('crypto');

const POLL_INTERVAL_MS = 15_000;
const DEFAULT_AUTH_SECRET = 'canvas-notebook-local-dev-secret-change-me';

let started = false;
let activeTick = null;

function getBaseUrl() {
  // Scheduler runs inside the container, so it should connect to localhost:3000
  // (the internal port where Next.js runs, not the external mapped port)
  const port = process.env.PORT || '3000';
  return `http://127.0.0.1:${port}`;
}

async function getInternalToken() {
  const baseSecret =
    (process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_SECRET.trim()) ||
    (process.env.AUTH_SECRET && process.env.AUTH_SECRET.trim()) ||
    (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()) ||
    DEFAULT_AUTH_SECRET;

  return crypto.createHash('sha256').update(`canvas-internal:${baseSecret}`).digest('hex');
}

async function queueDueScheduledJobs() {
  const baseUrl = getBaseUrl();
  const token = await getInternalToken();

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
    } else {
      const result = await response.json();
      if (result.queued && result.queued.length > 0) {
        console.log(`[Scheduler] Queued ${result.queued.length} due job(s)`);
      }
    }
  } catch (error) {
    console.warn('[Scheduler] Error queuing due jobs:', error.message);
  }
}

async function executeReadyRuns() {
  const baseUrl = getBaseUrl();
  const token = await getInternalToken();

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
    } else {
      const result = await response.json();
      if (result.executed && result.executed.length > 0) {
        console.log(`[Scheduler] Executed ${result.executed.length} ready run(s)`);
      }
    }
  } catch (error) {
    console.warn('[Scheduler] Error executing ready runs:', error.message);
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
      console.error('[Scheduler] Tick failed:', error);
    })
    .finally(() => {
      activeTick = null;
    });

  return activeTick;
}

function start() {
  if (started) {
    return;
  }

  console.log('[Scheduler] Starting automation scheduler...');
  console.log(`[Scheduler] Base URL: ${getBaseUrl()}`);
  console.log(`[Scheduler] Poll interval: ${POLL_INTERVAL_MS}ms`);

  started = true;

  // Run first tick immediately
  tick();

  // Then schedule regular ticks
  setInterval(() => {
    tick();
  }, POLL_INTERVAL_MS);

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
start();
