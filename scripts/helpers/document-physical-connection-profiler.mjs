/** Opt-in, read-only physical connection diagnostics for the isolated baseline
 * runner. Preload before the real-source dispatch bundle with NODE_OPTIONS.
 * Counts ready registered runtime clients, including idle pool and dedicated
 * clients; in-flight connection attempts are separate. No SQL is added and no
 * callback, argument, promise, result or error is replaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
if (process.argv[1]?.endsWith('/dispatch.mjs') && output && path.isAbsolute(output)) {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const { Client, Pool } = require('pg');
  const key = Symbol.for('canvas.document-operation-metrics.v1');
  const originalConnect = Client.prototype.connect, originalQuery = Client.prototype.query;
  const originalPoolConnect = Pool.prototype.connect;
  const observedClients = new WeakSet(), observedPools = new WeakSet(), pooled = new WeakSet();
  const connected = new Set(), connecting = new Set(), hookedActivities = new WeakSet();
  const records = new Map();
  let observationFailures = 0, lateWindows = 0;
  const safely = operation => { try { operation(); } catch { observationFailures++; } };
  const counts = () => {
    const measured = globalThis[key]?.measuredClients;
    let pool = 0, dedicated = 0, pending = 0;
    for (const client of connected) if (measured?.has(client)) {
      if (pooled.has(client)) pool++; else dedicated++;
    }
    for (const client of connecting) if (measured?.has(client)) pending++;
    return { ready: pool + dedicated, pooled: pool, dedicated, connecting: pending };
  };
  const update = (record, value) => {
    record.observations++;
    record.peakReady = Math.max(record.peakReady, value.ready);
    record.peakPooled = Math.max(record.peakPooled, value.pooled);
    record.peakDedicated = Math.max(record.peakDedicated, value.dedicated);
    record.peakConnecting = Math.max(record.peakConnecting, value.connecting);
  };
  const refresh = () => {
    const value = counts();
    for (const record of records.values()) if (!record.closed) update(record, value);
  };
  const opened = (state, late = false) => {
    if (records.has(state)) return;
    const start = counts();
    const record = { index: records.size, operation: state.operation, actor: state.actor,
      observedFromStart: !late, start, peakReady: 0, peakPooled: 0, peakDedicated: 0,
      peakConnecting: 0, observations: 0, closed: false };
    records.set(state, record); update(record, start);
    if (late) lateWindows++;
  };
  const hookRuntime = () => {
    const runtime = globalThis[key];
    if (!runtime || hookedActivities.has(runtime.activities)) return;
    const activities = runtime.activities, add = activities.add, remove = activities.delete;
    Object.defineProperties(activities, {
      add: { configurable: true, writable: true, value: function(...args) {
        const result = Reflect.apply(add, this, args);
        safely(() => opened(args[0])); return result;
      } },
      delete: { configurable: true, writable: true, value: function(...args) {
        safely(() => {
          const record = records.get(args[0]);
          if (record) { const end = counts(); update(record, end); record.end = end; record.closed = true; }
        });
        return Reflect.apply(remove, this, args);
      } },
    });
    hookedActivities.add(activities);
    for (const state of activities) opened(state, true);
  };
  Client.prototype.connect = function(...args) {
    safely(() => {
      hookRuntime();
      if (!observedClients.has(this)) {
        observedClients.add(this); connecting.add(this);
        this.once('connect', () => safely(() => {
          connecting.delete(this); connected.add(this); refresh();
        }));
        this.once('end', () => safely(() => {
          // A caller may register a previously connected dedicated client and
          // close it without a query. Observe enrollment before removing it.
          refresh(); connecting.delete(this); connected.delete(this); refresh();
        }));
      }
      refresh();
    });
    return Reflect.apply(originalConnect, this, args);
  };
  Pool.prototype.connect = function(...args) {
    safely(() => {
      hookRuntime();
      if (!observedPools.has(this)) {
        observedPools.add(this);
        this.on('connect', client => safely(() => { pooled.add(client); refresh(); }));
        this.on('acquire', () => safely(refresh));
      }
    });
    return Reflect.apply(originalPoolConnect, this, args);
  };
  Client.prototype.query = function(...args) {
    // Captures later metrics enrollment without intercepting replies or
    // retaining query text/parameters. The original return value is untouched.
    safely(() => { hookRuntime(); refresh(); });
    return Reflect.apply(originalQuery, this, args);
  };
  process.once('exit', () => {
    safely(refresh);
    const windows = [...records.values()];
    const end = counts();
    const complete = observationFailures === 0 && lateWindows === 0 && windows.length > 0
      && windows.every(record => record.closed) && end.ready === 0 && end.connecting === 0;
    fs.writeFileSync(output + '.connections.json', JSON.stringify({ version: 1,
      scope: 'ready registered runtime PostgreSQL clients observed from connect/end events; idle pooled clients included; in-flight attempts separate',
      noDiagnosticQueries: true, callbacksAndReturnValuesForwarded: true,
      observationFailures, lateWindows, complete, windows, end }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (!complete && !process.exitCode) process.exitCode = 1;
  });
}
