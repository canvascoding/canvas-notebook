import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readMcpCredentialJson, removeMcpCredentialJson, writeMcpCredentialJson } from '@/app/lib/mcp/credential-storage';
import { cancelMcpDesktopOAuth, finalizeMcpDesktopOAuth, getMcpDesktopOAuthStatus, isMcpDesktopOAuthState, type McpDesktopOAuthSummary } from '@/app/lib/mcp/desktop-oauth';
import { startMcpOAuth } from '@/app/lib/mcp/oauth';
import { MCP_SYSTEM_SCOPE } from '@/app/lib/mcp/scope';
import { resolveMcpStoragePath } from '@/app/lib/mcp/storage';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';
import { MOBILE_MCP_CONNECTION_ID, MobileMcpError, mobileMcpConnectionRevision, requireMobileMcpConnection, revalidateMobileMcpContext, type MobileMcpContext } from './mcp-connections';

const DIRECTORY = 'mobile-oauth-flows';
const STATE_DIRECTORY = 'mobile-oauth-states';
const RETENTION_MS = 60 * 60_000;
export const MOBILE_MCP_FLOW_ID = /^[A-Za-z0-9_-]{43}$/u;
type MobileFlow = { version: 1; flowId: string; desktopState: string; userId: string; authSessionId: string;
  workspaceId: string; connectionId: string; connectionRevision: string; organizationId: null; returnUrl: string; createdAt: string; expiresAt: string };
let lastCleanup = 0;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const flowPath = (flowId: string) => `${DIRECTORY}/${digest(flowId)}.json`;
const statePath = (state: string) => `${STATE_DIRECTORY}/${digest(state)}.json`;

/** This route is dedicated to native OAuth; arbitrary external destinations are never accepted. */
export function normalizeMobileMcpReturnUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) throw new MobileMcpError('INVALID_RETURN_URL', 'The app return URL is invalid.', 400);
  let url: URL;
  try { url = new URL(value); } catch { throw new MobileMcpError('INVALID_RETURN_URL', 'The app return URL is invalid.', 400); }
  if (!['canvasnotebook:', 'canvasnotebook-dev:', 'canvasnotebook-preview:'].includes(url.protocol)
    || url.username || url.password || url.port || url.search || url.hash
    || `${url.hostname}${url.pathname}`.replace(/^\/+|\/+$/gu, '') !== 'mcp-return') {
    throw new MobileMcpError('INVALID_RETURN_URL', 'The app return URL is not allowed.', 400);
  }
  return `${url.protocol}//mcp-return`;
}
function validFlow(value: MobileFlow | null, expectedFlowId?: string): value is MobileFlow {
  return Boolean(value && value.version === 1 && MOBILE_MCP_FLOW_ID.test(value.flowId)
    && Object.keys(value).sort().join(',') === 'authSessionId,connectionId,connectionRevision,createdAt,desktopState,expiresAt,flowId,organizationId,returnUrl,userId,version,workspaceId'
    && (!expectedFlowId || value.flowId === expectedFlowId) && isMcpDesktopOAuthState(value.desktopState)
    && [value.userId, value.authSessionId, value.workspaceId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\s\u0000-\u001f\u007f]/u.test(id))
    && value.organizationId === null && MOBILE_MCP_CONNECTION_ID.test(value.connectionId)
    && typeof value.connectionRevision === 'string' && /^[a-f0-9]{64}$/u.test(value.connectionRevision)
    && typeof value.returnUrl === 'string' && /^(?:canvasnotebook|canvasnotebook-dev|canvasnotebook-preview):\/\/mcp-return$/u.test(value.returnUrl)
    && typeof value.expiresAt === 'string' && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.expiresAt)) && Number.isFinite(Date.parse(value.createdAt))
    && new Date(value.expiresAt).toISOString() === value.expiresAt && new Date(value.createdAt).toISOString() === value.createdAt
    && Date.parse(value.expiresAt) > Date.parse(value.createdAt));
}
async function readFlow(flowId: string): Promise<MobileFlow> {
  if (!MOBILE_MCP_FLOW_ID.test(flowId)) throw new MobileMcpError('MCP_FLOW_NOT_FOUND', 'The sign-in is unavailable.', 404);
  const record = await readMcpCredentialJson<MobileFlow>(flowPath(flowId), MCP_SYSTEM_SCOPE);
  if (!validFlow(record, flowId)) throw new MobileMcpError('MCP_FLOW_NOT_FOUND', 'The sign-in is unavailable.', 404);
  return record;
}
async function cleanupFlows() {
  if (Date.now() - lastCleanup < 60_000) return;
  lastCleanup = Date.now();
  let directory;
  try { directory = await fs.opendir(resolveMcpStoragePath(DIRECTORY, MCP_SYSTEM_SCOPE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let count = 0;
  for await (const entry of directory) {
    if (++count > 1000) break;
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const record = await readMcpCredentialJson<MobileFlow>(`${DIRECTORY}/${entry.name}`, MCP_SYSTEM_SCOPE).catch(() => null);
    if (!validFlow(record) || Date.parse(record.expiresAt) + RETENTION_MS > Date.now()) continue;
    await withMcpStorageLock(`mobile-flow-${digest(record.flowId)}`, MCP_SYSTEM_SCOPE, async () => {
      const current = await readFlow(record.flowId);
      if (Date.parse(current.expiresAt) + RETENTION_MS > Date.now()) return;
      await removeMcpCredentialJson(statePath(current.desktopState), MCP_SYSTEM_SCOPE);
      await removeMcpCredentialJson(flowPath(current.flowId), MCP_SYSTEM_SCOPE);
    });
  }
}
function projectFlow(record: MobileFlow, status: McpDesktopOAuthSummary) {
  if (status.connectionId !== record.connectionId || status.expiresAt !== record.expiresAt) throw new MobileMcpError('MCP_FLOW_INVALID', 'The sign-in binding changed.', 409);
  return { workspaceId: record.workspaceId, flow: { flowId: record.flowId, connectionId: record.connectionId,
    workspaceId: record.workspaceId, status: status.status, expiresAt: status.expiresAt,
    ...(status.code ? { errorCode: /^[A-Za-z0-9_]{1,100}$/u.test(status.code) ? status.code : 'MCP_OAUTH_FAILED' } : {}) } };
}
export async function startMobileMcpOAuth(context: MobileMcpContext, connectionId: string, input: { revision: unknown; returnUrl: unknown }, origin: string) {
  const returnUrl = normalizeMobileMcpReturnUrl(input.returnUrl);
  const selected = await requireMobileMcpConnection(context, connectionId);
  if (input.revision !== mobileMcpConnectionRevision(selected.connection)) throw new MobileMcpError('MCP_CONNECTION_CHANGED', 'The connection changed. Reload its current state.', 409);
  await cleanupFlows();
  const started = await startMcpOAuth(connectionId, origin, { userId: context.userId }, { desktop: true });
  const flowId = randomBytes(32).toString('base64url');
  const record: MobileFlow = { version: 1, flowId, desktopState: started.state, userId: context.userId,
    authSessionId: context.authSessionId, workspaceId: context.workspaceId, connectionId, connectionRevision: input.revision as string, organizationId: null,
    returnUrl, createdAt: new Date().toISOString(), expiresAt: started.expiresAt };
  try {
    const current = await requireMobileMcpConnection(context, connectionId);
    if (mobileMcpConnectionRevision(current.connection) !== record.connectionRevision) throw new MobileMcpError('MCP_CONNECTION_CHANGED', 'The connection changed. Reload its current state.', 409);
    // Publish both locators before the browser can receive an authorization URL.
    await writeMcpCredentialJson(flowPath(flowId), record, MCP_SYSTEM_SCOPE);
    await writeMcpCredentialJson(statePath(started.state), record, MCP_SYSTEM_SCOPE);
    const stored = await readFlow(flowId), indexed = await readMcpCredentialJson<MobileFlow>(statePath(started.state), MCP_SYSTEM_SCOPE);
    if (JSON.stringify(stored) !== JSON.stringify(record) || JSON.stringify(indexed) !== JSON.stringify(record)) throw new MobileMcpError('MCP_FLOW_INVALID', 'The sign-in could not be saved.', 503);
    await revalidateMobileMcpContext(context);
  } catch (error) {
    await cancelMcpDesktopOAuth(started.state, context.userId).catch(() => undefined);
    await removeMcpCredentialJson(flowPath(flowId), MCP_SYSTEM_SCOPE).catch(() => undefined);
    await removeMcpCredentialJson(statePath(started.state), MCP_SYSTEM_SCOPE).catch(() => undefined);
    throw error;
  }
  return { ...projectFlow(record, { status: 'waiting', expiresAt: started.expiresAt, serverName: selected.serverName, connectionId }),
    authorizationUrl: started.authorizationUrl, returnUrl: `${returnUrl}?flowId=${encodeURIComponent(flowId)}` };
}
async function scopedFlow(context: MobileMcpContext, flowId: string) {
  await revalidateMobileMcpContext(context);
  const record = await readFlow(flowId);
  if (record.userId !== context.userId) throw new MobileMcpError('MCP_FLOW_NOT_FOUND', 'The sign-in is unavailable.', 404);
  if (record.authSessionId !== context.authSessionId || record.workspaceId !== context.workspaceId) {
    throw new MobileMcpError('MCP_FLOW_SCOPE_CHANGED', 'Return to the original account and workspace to finish sign-in.', 403);
  }
  const selected = await requireMobileMcpConnection(context, record.connectionId);
  if (mobileMcpConnectionRevision(selected.connection) !== record.connectionRevision) throw new MobileMcpError('MCP_CONNECTION_CHANGED', 'The connection changed. Reload its current state.', 409);
  return record;
}
/** Pure status reads do not exchange tokens or dispatch tools. */
export async function readMobileMcpOAuth(context: MobileMcpContext, flowId: string) {
  const record = await scopedFlow(context, flowId);
  const status = await getMcpDesktopOAuthStatus(record.desktopState, context.userId);
  const current = await scopedFlow(context, flowId);
  if (JSON.stringify(current) !== JSON.stringify(record)) throw new MobileMcpError('MCP_FLOW_INVALID', 'The sign-in binding changed.', 409);
  return projectFlow(record, status);
}
export async function decideMobileMcpOAuth(context: MobileMcpContext, flowId: string, action: unknown) {
  if (action !== 'finalize' && action !== 'cancel') throw new MobileMcpError('INVALID_REQUEST', 'Choose a sign-in action.', 400);
  if (!MOBILE_MCP_FLOW_ID.test(flowId)) throw new MobileMcpError('MCP_FLOW_NOT_FOUND', 'The sign-in is unavailable.', 404);
  return withMcpStorageLock(`mobile-flow-${digest(flowId)}`, MCP_SYSTEM_SCOPE, async () => {
    const record = await scopedFlow(context, flowId);
    const before = await getMcpDesktopOAuthStatus(record.desktopState, context.userId);
    await scopedFlow(context, flowId);
    const status = action === 'cancel' ? await cancelMcpDesktopOAuth(record.desktopState, context.userId)
      : before.status === 'callback_received' ? await finalizeMcpDesktopOAuth(record.desktopState, context.userId,
        { assertAuthorization: async () => { await scopedFlow(context, flowId); } }) : before;
    await scopedFlow(context, flowId);
    if (status.status === 'completed') {
      const { invalidateMobileMcpAppTickets } = await import('@/app/lib/mcp/mobile-app-tickets');
      invalidateMobileMcpAppTickets({ userId: context.userId, connectionId: record.connectionId });
    }
    return projectFlow(record, status);
  });
}
/** Called only after the existing public callback has safely consumed its exact state. */
export async function mobileMcpOAuthReturn(state: string): Promise<string | null> {
  if (!isMcpDesktopOAuthState(state)) return null;
  const indexed = await readMcpCredentialJson<MobileFlow>(statePath(state), MCP_SYSTEM_SCOPE);
  if (!validFlow(indexed) || indexed.desktopState !== state || Date.parse(indexed.expiresAt) <= Date.now()) return null;
  const record = await readFlow(indexed.flowId);
  if (JSON.stringify(record) !== JSON.stringify(indexed)) throw new MobileMcpError('MCP_FLOW_INVALID', 'The sign-in return binding changed.', 409);
  const returnUrl = normalizeMobileMcpReturnUrl(record.returnUrl);
  return `${returnUrl}?flowId=${encodeURIComponent(record.flowId)}`;
}
