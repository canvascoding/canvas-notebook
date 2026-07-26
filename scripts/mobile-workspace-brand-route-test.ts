import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const environmentKeys = [
  'CANVAS_DATABASE_PROVIDER',
  'CANVAS_DEPLOYMENT_MODE',
  'CANVAS_INSTANCE_ID',
  'CANVAS_INSTANCE_NAME',
  'CANVAS_TEAM_FEATURES_ENABLED',
  'DATA',
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

type RouteSession = {
  user: {
    id: string;
    email: string;
    name: string;
    image: null;
    role: string;
  };
  session: { id: string };
};

type JsonPayload = Record<string, unknown>;

function request(
  url: string,
  workspaceId: string,
  init: { body?: BodyInit | null; headers?: HeadersInit; method?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set('x-canvas-workspace-id', workspaceId);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new NextRequest(url, { ...init, headers });
}

async function json(response: Response): Promise<JsonPayload> {
  return await response.json() as JsonPayload;
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-brand-'));
  const dataRoot = path.join(temporaryRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'self-hosted';
  process.env.CANVAS_INSTANCE_ID = 'mobile-brand-private-instance';
  process.env.CANVAS_INSTANCE_NAME = 'Mobile Brand Canvas';
  process.env.CANVAS_TEAM_FEATURES_ENABLED = 'false';
  await fs.mkdir(dataRoot, { recursive: true });

  try {
    const { runMigrations } = await import('../app/lib/db/migrate');
    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    try {
      const now = Date.now();
      runMigrations(sqlite);
      sqlite.prepare(`
        INSERT INTO user (
          id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
        ) VALUES (?, ?, ?, 1, NULL, ?, NULL, NULL, NULL, ?, ?)
      `).run('mobile-brand-user', 'Mobile Brand User', 'brand@example.test', 'admin', now, now);
    } finally {
      sqlite.close();
    }

    const { auth } = await import('../app/lib/auth');
    let currentSession: RouteSession | null = {
      user: {
        id: 'mobile-brand-user',
        email: 'brand@example.test',
        name: 'Mobile Brand User',
        image: null,
        role: 'admin',
      },
      session: { id: 'mobile-brand-session' },
    };
    assert.equal(Reflect.set(auth.api, 'getSession', async () => currentSession), true);

    const bootstrapRoute = await import('../app/api/mobile/v1/bootstrap/route');
    const bootstrapResponse = await bootstrapRoute.GET(
      new Request('http://localhost/api/mobile/v1/bootstrap'),
    );
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await json(bootstrapResponse);
    const workspace = bootstrap.workspace as { activeWorkspaceId?: string };
    assert.equal(typeof workspace.activeWorkspaceId, 'string');
    const workspaceId = workspace.activeWorkspaceId as string;

    const brandRoute = await import('../app/api/mobile/v1/workspaces/[workspaceId]/brand/route');
    const logoRoute = await import('../app/api/mobile/v1/workspaces/[workspaceId]/brand/logo/route');
    assert.equal(typeof logoRoute.GET, 'function');
    assert.equal(typeof logoRoute.POST, 'function');
    assert.equal(typeof logoRoute.DELETE, 'function');
    const routeContext = { params: Promise.resolve({ workspaceId }) };
    const endpoint = `http://localhost/api/mobile/v1/workspaces/${encodeURIComponent(workspaceId)}/brand`;

    const initialResponse = await brandRoute.GET(request(endpoint, workspaceId), routeContext);
    assert.equal(initialResponse.status, 200);
    assert.equal(initialResponse.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(initialResponse.headers.get('vary'), 'Cookie, X-Canvas-Workspace-Id');
    const initial = await json(initialResponse);
    assert.equal(initial.success, true);
    assert.equal(initial.source, 'default');
    assert.equal(initial.configured, false);
    assert.equal(initial.canManage, true);

    const initialProfile = initial.profile as JsonPayload;
    const initialAppearance = initialProfile.appearance as JsonPayload;
    const initialColors = initialProfile.colors as JsonPayload;
    const updatedProfile = {
      ...initialProfile,
      enabled: true,
      brandName: 'Mobile Brand',
      appearance: {
        ...initialAppearance,
        enabled: true,
        radiusPx: 9,
      },
      colors: {
        ...initialColors,
        accent: '#b24a2b',
      },
    };
    const updateResponse = await brandRoute.PATCH(
      request(endpoint, workspaceId, {
        body: JSON.stringify({ profile: updatedProfile }),
        method: 'PATCH',
      }),
      routeContext,
    );
    assert.equal(updateResponse.status, 200);
    const updated = await json(updateResponse);
    assert.equal(updated.source, 'workspace');
    assert.equal(updated.configured, true);
    assert.equal((updated.profile as JsonPayload).brandName, 'Mobile Brand');
    assert.equal(
      ((updated.profile as JsonPayload).appearance as JsonPayload).radiusPx,
      9,
    );

    const mismatchResponse = await brandRoute.GET(
      request(endpoint, 'another-workspace'),
      routeContext,
    );
    assert.equal(mismatchResponse.status, 409);
    assert.equal((await json(mismatchResponse)).code, 'WORKSPACE_CONTEXT_MISMATCH');

    const invalidResponse = await brandRoute.PATCH(
      request(endpoint, workspaceId, {
        body: JSON.stringify({
          profile: {
            ...updatedProfile,
            colors: { ...initialColors, accent: 'not-a-color' },
          },
        }),
        method: 'PATCH',
      }),
      routeContext,
    );
    assert.equal(invalidResponse.status, 400);
    assert.equal((await json(invalidResponse)).code, 'INVALID_BRAND_PROFILE');

    currentSession = null;
    const unauthorizedResponse = await brandRoute.GET(
      request(endpoint, workspaceId),
      routeContext,
    );
    assert.equal(unauthorizedResponse.status, 401);

    currentSession = {
      user: {
        id: 'mobile-brand-user',
        email: 'brand@example.test',
        name: 'Mobile Brand User',
        image: null,
        role: 'admin',
      },
      session: { id: 'mobile-brand-session' },
    };
    const resetResponse = await brandRoute.DELETE(
      request(endpoint, workspaceId, { method: 'DELETE' }),
      routeContext,
    );
    assert.equal(resetResponse.status, 200);
    const reset = await json(resetResponse);
    assert.equal(reset.source, 'default');
    assert.equal(reset.configured, false);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().then(() => console.log('mobile-workspace-brand-route-test: ok'));
