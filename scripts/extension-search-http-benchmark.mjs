#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import dotenv from 'dotenv';

// Read-only product metadata and Preview. Creates/signs out only its own auth
// session; never creates a chat, sends a prompt or changes capabilities.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const base = new URL(args.get('--base') ?? 'http://localhost:3000');
assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Use the existing local development host.');
const env = dotenv.parse(await fs.readFile(args.get('--env'), 'utf8'));
const workspaceId = args.get('--workspace-id'), agentId = args.get('--agent-id') ?? 'bradley';
assert(workspaceId && env.BOOTSTRAP_ADMIN_EMAIL && env.BOOTSTRAP_ADMIN_PASSWORD);
const iterations = Number(args.get('--iterations') ?? 12);
assert(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 12, 'Keep the bounded run within the metadata API rate budget.');
const output = args.get('--output');
assert(output, 'Choose a private output JSON path.');
let cookies = '';
const reports = [];
async function request(path, body, redirect = 'error') {
  const response = await fetch(new URL(path, base), { method: body ? 'POST' : 'GET', redirect,
    headers: { Origin: base.origin, 'Content-Type': 'application/json', Cookie: cookies, 'x-canvas-workspace-id': workspaceId },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25_000) });
  return response;
}
function ownIconPaths(data) {
  return [...new Set((data.items ?? []).flatMap(row => {
    const icon = (row.item ?? row).icon;
    return icon?.url && icon.url.startsWith('/api/') ? [icon.url] : [];
  }))];
}
async function readImages(urls) {
  // A small bounded queue models browser icon loading without flooding the pool.
  const imageStatuses = [];
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
    while (urls.length) { const url = urls.shift(), image = await request(url, undefined, 'manual'); await image.arrayBuffer(); imageStatuses.push(image.status); }
  }));
  return imageStatuses;
}
async function measure(name, path, body, icons = false) {
  const started = performance.now(), response = await request(path, body);
  const payload = await response.json();
  assert(response.ok && payload.success !== false, `${name}: HTTP ${response.status}, ${payload.code ?? 'request failed'}`);
  const data = payload.data ?? payload;
  const metadataMs = performance.now() - started;
  const imageStatuses = icons ? await readImages(ownIconPaths(data)) : [];
  const report = { name, metadataMs: Math.round(metadataMs), totalMs: Math.round(performance.now() - started),
    status: response.status, serverTiming: response.headers.get('server-timing'),
    coverage: (data.coverage ?? []).map(row => ({ source: row.source, status: row.status, ...(row.error ? { code: row.error.code } : {}) })),
    rows: (data.items ?? []).length, imageStatuses };
  reports.push(report);
  return { report, data };
}
const target = { kind: 'draft_turn', workspaceId, agentId };
const search = { operation: 'search', target, phase: 'local', q: 'skill-creator', types: ['skill'], stock: 'installed', source: 'all', scope: 'system', limit: 30 };
const chatPath = `/api/chat/extension-options?workspaceId=${encodeURIComponent(workspaceId)}`;
const pluginPath = `/api/plugins/search?workspaceId=${encodeURIComponent(workspaceId)}&q=ca&stock=installed&types=plugin,skill&phase=local&limit=30`;
try {
  const login = await fetch(new URL('/api/auth/sign-in/email', base), { method: 'POST', redirect: 'error',
    headers: { Origin: base.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD }), signal: AbortSignal.timeout(20_000) });
  assert(login.ok, `Local bootstrap login returned HTTP ${login.status}`);
  cookies = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  await login.arrayBuffer();
  assert(cookies, 'The normal login did not issue an auth session.');
  const first = await measure('first-core', chatPath, search);
  const selected = first.data.items.find(row => row.selection?.kind === 'core_skill' && row.eligibility.action === 'select');
  assert(selected, 'The exact current Core skill must be selectable.');
  const bundleId = randomUUID();
  const preview = { operation: 'preview', target, body: { version: 1, parts: [{ type: 'extension_reference', occurrenceId: randomUUID(), bundleId }],
    bundles: [{ id: bundleId, caption: 'Skill Creator', primary: { selection: selected.selection, requirement: 'required', toolCap: null }, supporting: [], packageConnections: [] }] },
    intakeSelection: { version: 1, origin: 'turn_reference', selections: [{ selection: selected.selection, requirement: 'required', toolCap: null }], packageConnections: [] } };
  const installed = await measure('first-installed', pluginPath);
  for (let index = 0; index < iterations; index++) {
    await measure('warm-core', chatPath, search);
    await measure('warm-chat-local-all', chatPath, { ...search, q: 'ca', types: ['plugin', 'skill', 'integration', 'mcp'], stock: 'all', scope: 'all' });
    await measure('warm-chat-local-recents', chatPath, { ...search, q: '', types: ['plugin', 'skill', 'integration', 'mcp'], stock: 'all', scope: 'all' });
    const result = await measure('warm-preview', chatPath, preview);
    assert(!result.data.preview.issues.some(row => row.severity === 'error'));
    await measure('warm-installed-no-icons', pluginPath);
  }
  await Promise.all([measure('parallel-core', chatPath, search), measure('parallel-installed', pluginPath),
    measure('parallel-all', `/api/plugins/search?workspaceId=${encodeURIComponent(workspaceId)}&q=ca&phase=all&limit=20`)]);
  for (let index = 0; index < 3; index++) await measure('warm-installed-icons', pluginPath, undefined, true);
  const concurrentImages = ownIconPaths(installed.data);
  await Promise.all([readImages([...concurrentImages]), measure('parallel-core-under-icons', chatPath, search),
    measure('parallel-local-under-icons', chatPath, { ...search, q: 'ca', scope: 'all', types: ['plugin', 'skill', 'integration', 'mcp'] }),
    measure('parallel-installed-under-icons', pluginPath)]);
  const summaries = [...new Set(reports.map(row => row.name))].map(name => {
    const rows = reports.filter(row => row.name === name), sorted = rows.map(row => row.metadataMs).sort((a, b) => a - b);
    return { name, samples: rows.length, medianMs: sorted[Math.ceil(sorted.length / 2) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
      maxTotalMs: Math.max(...rows.map(row => row.totalMs)) };
  });
  await fs.writeFile(output, JSON.stringify({ timestamp: new Date().toISOString(), iterations, concurrentImageRequests: concurrentImages.length, summaries, reports }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output, summaries }, null, 2));
} finally { if (cookies) await request('/api/auth/sign-out', {}).catch(() => undefined); }
