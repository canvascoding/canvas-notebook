import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

test('recent chat API enforces ownership, workspace, agent access, search and nonempty conversations', async ({ page }) => {
  test.skip(!process.env.DATABASE_URL || process.env.E2E_EXTERNAL_SERVER !== '1', 'Requires the managed PostgreSQL test stack');
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { user } = await login.json();
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const personal = workspaces.find((workspace: { type: string }) => workspace.type === 'personal');
  const shared = workspaces.find((workspace: { type: string; permissions: { canRunAgent: boolean } }) => workspace.type !== 'personal' && workspace.permissions.canRunAgent);
  expect(shared).toBeTruthy();
  const agents = await (await page.request.get(`/api/agents?workspaceId=${shared.id}`)).json();
  const agentId = agents.data.agents[0].agentId;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const ids: number[] = [];
  const prefix = `home-continue-${randomUUID()}`;
  const timestamp = Date.now();
  const seed = async (name: string, workspaceId: string | null, options: { owner?: string; agent?: string; empty?: boolean; archived?: boolean; kind?: string } = {}) => {
    const sessionId = `${prefix}-${name.replace(/[^a-z0-9-]/gi, '-')}`;
    const row = await pool.query(`insert into pi_sessions (session_id, user_id, agent_id, provider, model, title, created_at, updated_at, last_message_at, workspace_id, workspace_type, session_kind, archived_at)
      values ($1,$2,$3,'ollama','qa-fixture',$4,$5,$5,$5,$6,$7,$8,$9) returning id`, [sessionId, options.owner || user.id, options.agent || agentId, `${prefix} ${name}`, Math.floor(timestamp / 1000), workspaceId, workspaceId === shared.id ? shared.type : 'personal', options.kind || 'conversation', options.archived ? Math.floor(timestamp / 1000) : null]);
    const id = row.rows[0].id;
    ids.push(id);
    if (!options.empty) await pool.query('insert into pi_messages (pi_session_db_id, role, content, timestamp, sequence) values ($1,$2,$3,$4,1)', [id, 'user', JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Home continuation fixture' }], timestamp }), timestamp]);
    return sessionId;
  };
  try {
    const visible = await seed('visible 100%', shared.id);
    await seed('empty', shared.id, { empty: true });
    await seed('archived', shared.id, { archived: true });
    await seed('delegation', shared.id, { kind: 'delegation_worker' });
    await seed('forbidden-agent', shared.id, { agent: `${prefix}-inaccessible` });
    await seed('personal', personal.id);
    await seed('legacy-workspace', null);
    const other = await pool.query('select id from "user" where id <> $1 limit 1', [user.id]);
    expect(other.rows.length).toBe(1);
    await seed('other-user', shared.id, { owner: other.rows[0].id });
    const response = await page.request.get(`/api/home/chats?${new URLSearchParams({ workspaceId: shared.id, q: prefix })}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect((await response.json()).data.chats.map((chat: { sessionId: string }) => chat.sessionId)).toEqual([visible]);
    const literal = await page.request.get(`/api/home/chats?${new URLSearchParams({ workspaceId: shared.id, q: '%' })}`);
    expect((await literal.json()).data.chats.some((chat: { sessionId: string }) => chat.sessionId === visible)).toBe(true);
    const personalResponse = await page.request.get(`/api/home/chats?${new URLSearchParams({ workspaceId: personal.id, q: prefix, limit: '1' })}`);
    const data = (await personalResponse.json()).data;
    expect(data.chats).toHaveLength(1);
    expect(data.hasMore).toBe(true);
    expect(data.chats[0].sessionId).not.toBe(visible);
    expect((await page.request.get('/api/home/chats')).status()).toBe(400);
    expect((await page.request.get(`/api/home/chats?workspaceId=${shared.id}&limit=999`)).status()).toBe(400);
    expect([403, 404]).toContain((await page.request.get(`/api/home/chats?workspaceId=${prefix}-missing`)).status());
    await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), shared.id);
    await page.goto('/de');
    await page.getByTestId('home-files').getByRole('link', { name: new RegExp(prefix + ' visible') }).click();
    await expect(page.getByText('Home continuation fixture', { exact: true }).first()).toBeVisible({ timeout: 15000 });
    await page.goto(`/de/notebook?${new URLSearchParams({ workspaceId: shared.id, chat: 'open', history: 'open' })}`);
    await expect(page.getByRole('button', { name: 'Zurück zum Chat', exact: true }).first()).toBeVisible({ timeout: 15000 });
    await page.context().clearCookies();
    expect((await page.request.get(`/api/home/chats?workspaceId=${shared.id}`)).status()).toBe(401);
  } finally {
    if (ids.length) {
      await pool.query('delete from pi_messages where pi_session_db_id = ANY($1::integer[])', [ids]);
      await pool.query('delete from pi_sessions where id = ANY($1::integer[])', [ids]);
    }
    await pool.end();
  }
});
