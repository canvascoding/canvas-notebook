/** Actual Settings UI and public PKCE/MCP acceptance on the existing licensed QA clone. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { chromium, expect, type BrowserContext } from '@playwright/test';
import { authorizeIngestE2EMcp, requireIngestE2EFailure, requireIngestE2ESuccess,
  type IngestE2EToolResult } from './mcp-file-ingest-e2e-helpers';

const sceneTools = ['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene'] as const;
const labels = ['Create Excalidraw diagrams', 'Read Excalidraw scenes', 'Edit Excalidraw elements'];
type Settings = { desiredEnabled: boolean; runtimeEnabled: boolean; protocolVersion: string;
  activationManagedByEnvironment: boolean; capabilitiesManagedByEnvironment: boolean;
  capabilities: Array<{ id: string; enabled: boolean; available: boolean }> };
type Scene = { documentId: string; workspaceId: string; path: string; lifecycleGeneration: number;
  sceneSequence: number; elements: Array<Record<string, unknown> & { id: string; version: number; versionNonce: number }>;
  canonicalHash: string; checkpoint: { status: string }; documentUrl: string };
type Json = Record<string, unknown>;
let phase = 'private fixture verification';
const sensitive = Object.entries(process.env).filter(([key, value]) => value && /PASSWORD|SECRET|TOKEN|EMAIL|DATABASE_URL/u.test(key))
  .map(([, value]) => value!);
function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of sensitive) message = message.replaceAll(value, '[redacted]');
  return message.replace(/Bearer\s+[^\s"']+/giu, 'Bearer [redacted]')
    .replace(/([?&](?:code|state|client_id|code_challenge|code_verifier|access_token|refresh_token)=)[^\s&#"'<>]+/giu, '$1[redacted]')
    .replace(/(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+/gu, '[redacted]').slice(0, 1800);
}
async function json<T>(response: { ok(): boolean; status(): number; json(): Promise<unknown> }, label: string): Promise<T> {
  assert.ok(response.ok(), `${label}: HTTP ${response.status()}`);
  return response.json() as Promise<T>;
}
function selected(status: Settings): string[] { return status.capabilities.filter(item => item.enabled).map(item => item.id).sort(); }
function rectangle(id: string, x = 120) {
  return { id, type: 'rectangle', x, y: 100, width: 120, height: 80, angle: 0, strokeColor: '#1e1e1e',
    backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1,
    opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 17, version: 1,
    versionNonce: 29, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'development');
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const metadataPath = process.argv[2];
  assert.ok(metadataPath && path.isAbsolute(metadataPath), 'The private existing-clone metadata receipt is required.');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
    purpose: string; source: string; productionRestoreProof: boolean; appRoot: string; dataRoot: string;
    databaseName: string; cloneOid: string; origin: string;
  };
  assert.equal(metadata.purpose, 'isolated-local-Excalidraw-QA-fixture');
  assert.equal(metadata.source, 'existing-managed-stack');
  assert.equal(metadata.productionRestoreProof, false);
  assert.equal(await fs.realpath(metadata.appRoot), await fs.realpath(process.cwd()));
  assert.equal(await fs.realpath(metadata.dataRoot), await fs.realpath(process.env.DATA!));
  assert.equal(path.dirname(metadataPath), path.dirname(metadata.dataRoot));
  assert.equal((await fs.stat(path.dirname(metadataPath))).mode & 0o777, 0o700);
  assert.equal(metadata.origin, process.env.BASE_URL);
  assert.equal(metadata.origin, process.env.BETTER_AUTH_BASE_URL);
  const origin = new URL(metadata.origin);
  assert.equal(origin.origin, 'http://127.0.0.1:4135');
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  assert.equal(databaseUrl.hostname, '127.0.0.1');
  assert.equal(databaseUrl.port, '55433');
  assert.match(databaseUrl.pathname, /^\/canvas_excalidraw_e2e_[a-f0-9]{16}$/u);
  assert.equal(databaseUrl.pathname.slice(1), metadata.databaseName);
  const database = new Client({ connectionString: databaseUrl.href, connectionTimeoutMillis: 3000 });
  await database.connect();
  try {
    const receipt = await database.query('SELECT current_database() AS name,oid::text AS oid FROM pg_database WHERE datname=current_database()');
    assert.equal(receipt.rows[0].name, metadata.databaseName);
    assert.equal(receipt.rows[0].oid, metadata.cloneOid);
  } finally { await database.end(); }
  const fixtureDirectory = path.dirname(metadataPath);
  const leasePath = path.join(fixtureDirectory, 'excalidraw-mcp-qa.lock');
  const lease = await fs.open(leasePath, 'wx', 0o600);
  await lease.writeFile(JSON.stringify({ pid: process.pid, purpose: 'actual Excalidraw MCP OAuth and Settings QA' }));
  await lease.sync();
  const suffix = randomUUID();
  const sessionReceiptPath = path.join(fixtureDirectory, `excalidraw-mcp-owned-sessions-${suffix}.json`);
  const sessionReceipts: Array<{ id: string; userId: string }> = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let owner: BrowserContext | undefined;
  let secondary: BrowserContext | undefined;
  let initial: { enabled: boolean; tools: string[] } | undefined;
  let settingsRestored = true;
  let workspaceId: string | undefined;
  let drawing: Scene | undefined;
  let secondaryId: string | undefined;
  let memberRevoked = false;
  const connections = new Map<string, BrowserContext>();
  const ownedSessions: BrowserContext[] = [];
  const passed: string[] = [];
  let failure: unknown;
  const cleanupErrors: string[] = [];
  async function step(name: string, action: () => Promise<void>) {
    phase = name;
    console.info(`[excalidraw-mcp-e2e] ${name}`);
    await action();
    passed.push(name);
  }
  async function status() {
    return (await json<{ data: Settings }>(await owner!.request.get('/api/integrations/mcp-server'), 'Read MCP settings')).data;
  }
  async function membership(canRead = true, canWrite = true) {
    await json(await owner!.request.post(`/api/workspaces/${workspaceId}/members`, {
      data: { userId: secondaryId, role: 'member', canRead, canWrite, canManage: false },
    }), 'Update only the owned test workspace member');
    memberRevoked = !canRead || !canWrite;
  }
  async function grant(context: BrowserContext, connectionId: string, ids: string[]) {
    await json(await context.request.put('/api/integrations/mcp-server/connections/workspaces', {
      data: { connectionId, workspaceIds: ids },
    }), 'Select only the owned MCP connection workspaces');
  }
  async function workspaceEnabled(enabled: boolean) {
    await json(await owner!.request.put('/api/integrations/mcp-server/workspaces', {
      data: { workspaceId, enabled },
    }), 'Toggle only the owned workspace MCP setting');
  }
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.CANVAS_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.CANVAS_PLAYWRIGHT_EXECUTABLE } : {}) });
    async function login(email: string | undefined, password: string | undefined, admin: boolean) {
      assert.ok(email && password, 'Private managed fixture credentials are required.');
      const context = await browser!.newContext({ baseURL: metadata.origin, viewport: { width: 1440, height: 1000 } });
      try {
        await json(await context.request.post('/api/auth/sign-in/email', {
          headers: { Origin: metadata.origin }, data: { email, password }, timeout: 90_000,
        }), 'Create a fresh owned HTTP session');
        ownedSessions.push(context);
        const session = await json<{ user: { id: string; role: string }; session: { id: string } }>(
          await context.request.get('/api/auth/get-session'), 'Verify the fresh HTTP session');
        assert.ok(session.session.id && session.user.id);
        sessionReceipts.push({ id: session.session.id, userId: session.user.id });
        // Recovery ownership receipts contain IDs only; authentication material
        // stays in the fresh browser contexts and is never written to disk.
        await fs.writeFile(sessionReceiptPath, JSON.stringify({ purpose: 'API-created Excalidraw MCP QA sessions',
          metadataPath, runId: suffix, sessions: sessionReceipts }), { mode: 0o600 });
        if (admin) assert.equal(session.user.role, 'admin');
        return { context, userId: session.user.id };
      } catch (error) { if (!ownedSessions.includes(context)) await context.close(); throw error; }
    }
    await step('fresh real sessions and original default-disabled scene capabilities', async () => {
      const admin = await login(process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_PASSWORD, true);
      owner = admin.context;
      const member = await login(process.env.TEST_SECONDARY_EMAIL, process.env.TEST_SECONDARY_PASSWORD, false);
      secondary = member.context;
      secondaryId = member.userId;
      assert.notEqual(admin.userId, secondaryId);
      const current = await status();
      assert.equal(current.activationManagedByEnvironment, false, 'The owned Settings QA fixture must permit Settings activation.');
      assert.equal(current.capabilitiesManagedByEnvironment, false);
      initial = { enabled: current.desiredEnabled, tools: selected(current) };
      assert.equal(sceneTools.some(tool => initial!.tools.includes(tool)), false,
        'The original QA settings must not have implicitly enabled any new scene capability.');
      const review = await json<{ data: { documentReviewEnabled: boolean } }>(
        await owner.request.get('/api/document-review/availability'), 'Read review availability');
      assert.equal(review.data.documentReviewEnabled, false, 'This acceptance must retain the default-off Review Center.');
      const created = await json<{ workspace: { id: string } }>(await owner.request.post('/api/workspaces', {
        data: { type: 'team', name: `MCP OAuth scene QA ${suffix}` },
      }), 'Create an owned team workspace through the API');
      workspaceId = created.workspace.id;
      assert.ok(workspaceId);
      await membership();
      await workspaceEnabled(true);
    });
    const page = await owner!.newPage();
    const activation = page.getByRole('switch', { name: 'Canvas MCP server', exact: true });
    const switches = labels.map(name => page.getByRole('switch', { name, exact: true }));
    async function saveUi() {
      const receipt = page.waitForResponse(response => response.request().method() === 'PATCH'
        && new URL(response.url()).pathname === '/api/integrations/mcp-server');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await json(await receipt, 'Save actual MCP Settings UI');
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    }
    await step('actual Settings UI explicitly selects all three Excalidraw tools', async () => {
      await page.goto('/en/settings?tab=mcp', { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await expect(activation).toBeEnabled({ timeout: 60_000 });
      if ((await activation.getAttribute('aria-checked')) !== 'true') await activation.click();
      for (const control of switches) await expect(control).toHaveAttribute('aria-checked', 'false');
      for (const control of switches) await control.click();
      settingsRestored = false;
      await saveUi();
      const saved = await status();
      assert.equal(sceneTools.every(tool => selected(saved).includes(tool)), true);
    });
    const protocolVersion = (await status()).protocolVersion;
    const authorize = (context: BrowserContext, scopes: string[], name: string) =>
      authorizeIngestE2EMcp(context, metadata.origin, workspaceId!, protocolVersion, {
        scopes, clientNamePrefix: `Excalidraw ${name} QA ${suffix}`,
        onConnection: id => { connections.set(id, context); },
      });
    let writable!: Awaited<ReturnType<typeof authorize>>;
    let readOnly!: Awaited<ReturnType<typeof authorize>>;
    let memberClient!: Awaited<ReturnType<typeof authorize>>;
    await step('three public OAuth clients complete browser consent and PKCE exchange', async () => {
      writable = await authorize(owner!, ['openid', 'offline_access', 'knowledge:read', 'knowledge:write'], 'write');
      readOnly = await authorize(owner!, ['openid', 'offline_access', 'knowledge:read'], 'readonly');
      memberClient = await authorize(secondary!, ['openid', 'offline_access', 'knowledge:read', 'knowledge:write'], 'member');
      const listing = await writable.rpc('tools/list') as { tools: Array<{ name: string; securitySchemes: unknown }> };
      for (const tool of sceneTools) assert.ok(listing.tools.some(item => item.name === tool));
    });
    const getInput = () => ({ workspaceId: workspaceId!, documentId: drawing!.documentId });
    const get = async () => requireIngestE2ESuccess(await writable.call('get_excalidraw_scene', getInput()), 'Read actual MCP scene') as unknown as Scene;
    const editInput = (scene: Scene, actions: Json[]) => ({ workspaceId: workspaceId!, documentId: scene.documentId,
      lifecycleGeneration: scene.lifecycleGeneration, observedSceneSequence: scene.sceneSequence,
      actions, idempotencyKey: randomUUID() });
    const denied = (result: IngestE2EToolResult, code?: string) => { requireIngestE2EFailure(result, code); };
    await step('actual MCP Create Get Edit persistence, idempotency and conflict status', async () => {
      const input = { workspaceId: workspaceId!, path: 'oauth.excalidraw', idempotencyKey: randomUUID() };
      drawing = requireIngestE2ESuccess(await writable.call('create_excalidraw_scene', input), 'MCP Create') as unknown as Scene;
      assert.equal(drawing.checkpoint.status, 'saved');
      assert.equal(requireIngestE2ESuccess(await writable.call('create_excalidraw_scene', input), 'Idempotent Create').documentId, drawing.documentId);
      const initialScene = await get();
      const inserted = requireIngestE2ESuccess(await writable.call('edit_excalidraw_scene', editInput(initialScene,
        [{ type: 'create', element: rectangle('oauth-left') }, { type: 'create', element: rectangle('oauth-right', 330) }])), 'MCP Edit');
      assert.equal(inserted.status, 'applied');
      assert.equal((inserted.checkpoint as { status: string }).status, 'saved');
      assert.ok(typeof inserted.documentUrl === 'string' && inserted.documentUrl.includes(encodeURIComponent(workspaceId!)));
      const observed = await get();
      assert.equal(observed.elements.length, 2);
      const target = observed.elements[0];
      const update = { type: 'update', elementId: target.id, expectedVersion: target.version,
        expectedVersionNonce: target.versionNonce, element: { ...target, x: 175 } };
      const request = editInput(observed, [update]);
      const changed = requireIngestE2ESuccess(await writable.call('edit_excalidraw_scene', request), 'Update observed target');
      assert.equal(changed.status, 'applied');
      assert.equal(requireIngestE2ESuccess(await writable.call('edit_excalidraw_scene', request), 'Idempotent Edit').operationId, changed.operationId);
      const current = await get();
      const review = requireIngestE2ESuccess(await writable.call('edit_excalidraw_scene', editInput(observed,
        [{ ...update, element: { ...target, x: 999 } }])), 'Persist actual target conflict');
      assert.equal(review.status, 'needs_review');
      assert.equal(review.reviewRequired, true);
      assert.equal(review.reviewAvailable, false);
      assert.equal(review.reviewHint, null);
      assert.equal((await get()).canonicalHash, current.canonicalHash);
      await json(await owner!.request.post(`/api/files/excalidraw-collaboration/operations/${review.operationId}/cancel`, {
        headers: { 'x-canvas-workspace-id': workspaceId! }, data: { idempotencyKey: randomUUID() },
      }), 'Cancel only the owned conflicting proposal while reviews remain disabled');
      denied(await writable.call('create_excalidraw_scene', { ...input, path: 'different.excalidraw' }), 'EXCALIDRAW_IDEMPOTENCY_CONFLICT');
    });
    await step('real read-only OAuth scope permits Get and denies Create Edit', async () => {
      assert.equal(requireIngestE2ESuccess(await readOnly.call('get_excalidraw_scene', getInput()), 'Read-only OAuth Get').documentId, drawing!.documentId);
      const create = await readOnly.call('create_excalidraw_scene', {
        workspaceId: workspaceId!, path: 'readonly-denied.excalidraw', idempotencyKey: randomUUID(),
      });
      denied(create);
      assert.match(JSON.stringify(create._meta), /insufficient_scope/);
      const edit = await readOnly.call('edit_excalidraw_scene', editInput(await get(), [{ type: 'create', element: rectangle('readonly-denied') }]));
      denied(edit);
      assert.match(JSON.stringify(edit._meta), /insufficient_scope/);
    });
    await step('Settings tool disable and server reactivation require the explicit saved selection', async () => {
      await switches[1].click();
      await saveUi();
      denied(await writable.call('get_excalidraw_scene', getInput()));
      assert.equal((await writable.rpc('tools/list') as { tools: Array<{ name: string }> }).tools.some(item => item.name === sceneTools[1]), false);
      await activation.click();
      await saveUi();
      const inactive = await writable.call('get_excalidraw_scene', getInput());
      denied(inactive);
      assert.equal(inactive.structuredContent?.http_status, 404);
      await activation.click();
      await saveUi();
      await expect(switches[1]).toHaveAttribute('aria-checked', 'false');
      denied(await writable.call('get_excalidraw_scene', getInput()));
      await switches[1].click();
      await saveUi();
      assert.equal((await get()).documentId, drawing!.documentId);
    });
    await step('client workspace grant and workspace disable revocation are enforced live', async () => {
      await grant(owner!, writable.connectionId!, []);
      denied(await writable.call('get_excalidraw_scene', getInput()), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
      await grant(owner!, writable.connectionId!, [workspaceId!]);
      assert.equal((await get()).documentId, drawing!.documentId);
      await workspaceEnabled(false);
      denied(await writable.call('get_excalidraw_scene', getInput()), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
      await workspaceEnabled(true);
      denied(await writable.call('get_excalidraw_scene', getInput()), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
      await grant(owner!, writable.connectionId!, [workspaceId!]);
      await grant(owner!, readOnly.connectionId!, [workspaceId!]);
      await grant(secondary!, memberClient.connectionId!, [workspaceId!]);
      assert.equal((await get()).documentId, drawing!.documentId);
    });
    await step('actual secondary workspace ACL revoke and restore affect the existing OAuth client', async () => {
      requireIngestE2ESuccess(await memberClient.call('get_excalidraw_scene', getInput()), 'Secondary client initial Get');
      await membership(false, false);
      denied(await memberClient.call('get_excalidraw_scene', getInput()), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
      await membership();
      requireIngestE2ESuccess(await memberClient.call('get_excalidraw_scene', getInput()), 'Restored secondary client Get');
    });
    await step('actual connection revocation denies its previously working MCP token', async () => {
      await writable.revoke();
      connections.delete(writable.connectionId!);
      const result = await writable.call('get_excalidraw_scene', getInput());
      denied(result);
      assert.equal(result.structuredContent?.http_status, 401);
      assert.match(String(result.structuredContent?.authentication_challenge), /invalid_token/);
      denied(await writable.call('create_excalidraw_scene', {
        workspaceId: workspaceId!, path: 'revoked-denied.excalidraw', idempotencyKey: randomUUID(),
      }));
      const current = requireIngestE2ESuccess(await readOnly.call('get_excalidraw_scene', getInput()), 'Still active read-only client') as unknown as Scene;
      assert.equal(current.elements.some(item => ['readonly-denied', 'revoked-denied'].includes(item.id)), false);
      for (const deniedPath of ['readonly-denied.excalidraw', 'revoked-denied.excalidraw', 'different.excalidraw']) {
        const missing = await owner!.request.get('/api/files/exists', {
          headers: { 'x-canvas-workspace-id': workspaceId! }, params: { path: deniedPath },
        });
        const body = await json<{ data?: { exists?: boolean }; exists?: boolean }>(missing, 'Check denied publication stayed absent');
        assert.equal(body.data?.exists ?? body.exists, false);
      }
      const review = await json<{ data: { documentReviewEnabled: boolean } }>(
        await owner!.request.get('/api/document-review/availability'), 'Verify reviews stayed disabled');
      assert.equal(review.data.documentReviewEnabled, false);
    });
  } catch (error) { failure = error; }
  finally {
    phase = failure ? phase : 'restore settings and clean only owned API resources';
    const clean = async (label: string, work: () => Promise<void>) => {
      try { await work(); } catch (error) { cleanupErrors.push(`${label}: ${safeError(error)}`); }
    };
    if (memberRevoked && workspaceId && owner) await clean('Restore owned member ACL', () => membership());
    for (const [connectionId, context] of connections) await clean('Revoke own OAuth consent', async () => {
      const response = await context.request.delete('/api/integrations/mcp-server/connections', { data: { connectionId } });
      assert.ok(response.ok() || response.status() === 404, `Own OAuth cleanup: HTTP ${response.status()}`);
    });
    if (owner && initial && !settingsRestored) await clean('Restore original MCP settings', async () => {
      await json(await owner!.request.patch('/api/integrations/mcp-server', { data: initial }), 'Restore original MCP settings');
      // Activation expands established capabilities; a second save while active
      // preserves even an intentionally narrower original capability set.
      await json(await owner!.request.patch('/api/integrations/mcp-server', { data: initial }), 'Restore exact original MCP selection');
      const restored = await status();
      assert.equal(restored.desiredEnabled, initial!.enabled);
      assert.deepEqual(selected(restored), initial!.tools);
      settingsRestored = true;
    });
    if (owner && workspaceId) {
      if (drawing) await clean('Delete only the created diagram', async () => {
        await json(await owner!.request.delete('/api/files/delete', {
          headers: { 'x-canvas-workspace-id': workspaceId! }, data: { path: drawing!.path },
        }), 'Delete owned test diagram');
      });
      await clean('Disable own MCP workspace', () => workspaceEnabled(false));
      await clean('Delete only the created workspace', async () => {
        await json(await owner!.request.delete(`/api/workspaces/${workspaceId}`), 'Delete owned test workspace');
      });
    }
    for (const context of ownedSessions) await clean('Sign out only fresh owned session', async () => {
      await json(await context.request.post('/api/auth/sign-out', { headers: { Origin: metadata.origin }, data: {} }), 'Sign out owned session');
    });
    for (const context of ownedSessions) await clean('Close owned browser context', () => context.close());
    await clean('Close owned browser', async () => { await browser?.close(); });
    await clean('Release only the own settings lease', async () => {
      if (!settingsRestored) throw new Error('The exclusive lease is retained because original settings could not be verified.');
      const held = await lease.stat();
      const current = await fs.lstat(leasePath);
      assert.equal(current.dev, held.dev);
      assert.equal(current.ino, held.ino);
      await fs.unlink(leasePath);
    });
    await lease.close();
    if (cleanupErrors.length === 0) await fs.rm(sessionReceiptPath, { force: true });
  }
  if (cleanupErrors.length) throw new Error(`Owned QA cleanup failed: ${cleanupErrors.join('; ')}`);
  if (failure) throw failure;
  console.info(JSON.stringify({ success: true, actualLicensedClone: true, publicAuthorizationCodePkce: true,
    actualMcpTransport: true, defaultReviewOff: true, settingsUiOptIn: true, checks: passed,
    originalSettingsRestored: settingsRestored, ownOAuthConnectionsRevoked: true, ownSessionsSignedOut: true,
    noDatabaseWritesByHarness: true, noExtraServerOrContainer: true, traceRecorded: false }));
}

void main().catch(error => {
  console.error(`[excalidraw-mcp-e2e] Failed during ${phase}: ${safeError(error)}`);
  process.exitCode = 1;
});
