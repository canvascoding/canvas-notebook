import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { authorizeIntegrationConnection, validateIntegrationConnectionRef, withAuthorizedIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import type { IntegrationConnectionRevisions } from '@/app/lib/integration-tools/connections/contracts';
import { startSharedMcpOAuth } from '@/app/lib/mcp/shared-oauth';
import { cancelSharedMcpDesktopOAuth, finalizeSharedMcpDesktopOAuth, getSharedMcpDesktopOAuthStatus } from '@/app/lib/mcp/shared-desktop-oauth';
import { startSharedComposioDesktopOAuth, cancelSharedComposioDesktopOAuthIntent, finalizeSharedComposioDesktopOAuth,
  getSharedComposioDesktopOAuthStatusByIntent } from '@/app/lib/composio/composio-shared-desktop-oauth';
import { deriveSharedComposioDesktopOAuthState } from '@/app/lib/composio/composio-shared-desktop-oauth-contract';
import { resolveAuthorizedComposioConnectionContext } from '@/app/lib/composio/composio-shared-context';
import { sharedComposioCredentialRevision } from '@/app/lib/composio/composio-shared-backend';
import { readMcpCredentialJson, writeMcpCredentialJson, removeMcpCredentialJson } from '@/app/lib/mcp/credential-storage';
import { MCP_SYSTEM_SCOPE } from '@/app/lib/mcp/scope';
import { resolveMcpStoragePath } from '@/app/lib/mcp/storage';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';
import { MobileScopedError, revalidateMobileScopedContext, type MobileScopedContext } from './scoped-route-v2';
import { mobileSharedOAuthConnectionRefSchema, mobileSharedOAuthFlowIdSchema, mobileSharedOAuthStartSchema,
  normalizeMobileSharedOAuthReturnUrl, type MobileSharedOAuthSource, type MobileSharedOAuthStart, type MobileSharedOAuthSummary } from './shared-connection-oauth-contracts';

const DIRECTORY = 'mobile-shared-oauth-flows-v2', INDEX = 'mobile-shared-oauth-states-v2';
const TTL = 10 * 60_000, RETENTION = 60 * 60_000;
const identifier = z.string().min(1).max(200).refine(value => !/[\s\x00-\x1f\x7f]/u.test(value));
const iso = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const recordSchema = z.object({ version: z.literal(2), connectionId: z.literal('mobile-shared-oauth-v2'), organizationId: z.null(),
  flowId: mobileSharedOAuthFlowIdSchema, source: z.enum(['mcp', 'composio']), connectionRef: mobileSharedOAuthConnectionRefSchema,
  userId: identifier, authSessionId: identifier, workspaceId: identifier, actorOrganizationId: identifier.nullable(),
  revisions: z.object({ metadataRevision: positive, grantsRevision: positive, bindingRevision: positive }).strict(),
  returnUrl: z.string().regex(/^(?:canvasnotebook|canvasnotebook-dev|canvasnotebook-preview):\/\/integration-return$/u),
  providerState: z.string().max(100).nullable(), phase: z.enum(['pending', 'linked', 'no_auth', 'cancelled']),
  nativeCompletionProof: z.object({ authorizationRevision: mobileSharedOAuthFlowIdSchema, profileRevision: positive,
    credentialRevision: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
  createdAt: iso, expiresAt: iso,
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt)
  // Broker lifetime starts after preparation; this bound includes preparation latency.
  && Date.parse(value.expiresAt) <= Date.parse(value.createdAt) + 30 * 60_000
  && (value.providerState === null ? value.source === 'mcp' && value.phase !== 'linked'
    : value.source === 'mcp' ? /^desktop_[A-Za-z0-9_-]{32}$/u.test(value.providerState) : mobileSharedOAuthFlowIdSchema.safeParse(value.providerState).success)
  && (value.phase !== 'no_auth' || value.source === 'composio' && value.nativeCompletionProof !== undefined)
  && (value.nativeCompletionProof === undefined || value.phase === 'no_auth'));
type SharedMobileFlow = z.infer<typeof recordSchema>;
type BrokerSummary = { connectionRef: string; state: string; status: MobileSharedOAuthSummary['status']; expiresAt: string; authorizationUrl?: string; code?: string };
let lastCleanup = 0;
const sharedMobileDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const sharedMobileFlowPath = (flowId: string) => `${DIRECTORY}/${sharedMobileDigest(flowId)}.json`;
const sharedMobileStatePath = (source: MobileSharedOAuthSource, state: string) => `${INDEX}/${source}-${sharedMobileDigest(state)}.json`;

function parseSharedMobileFlow(value: unknown, flowId?: string): SharedMobileFlow {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success || flowId !== undefined && parsed.data.flowId !== flowId) throw new MobileScopedError('MOBILE_OAUTH_FLOW_INVALID', 'The native sign-in binding is invalid.', 409);
  return parsed.data;
}
async function readSharedMobileFlow(flowId: string): Promise<SharedMobileFlow> {
  if (!mobileSharedOAuthFlowIdSchema.safeParse(flowId).success) throw new MobileScopedError('MOBILE_OAUTH_FLOW_NOT_FOUND', 'The native sign-in is unavailable.', 404);
  const record = await readMcpCredentialJson(sharedMobileFlowPath(flowId), MCP_SYSTEM_SCOPE);
  if (!record) throw new MobileScopedError('MOBILE_OAUTH_FLOW_NOT_FOUND', 'The native sign-in is unavailable.', 404);
  return parseSharedMobileFlow(record, flowId);
}
async function saveSharedMobileFlow(value: SharedMobileFlow): Promise<void> {
  const record = parseSharedMobileFlow(value);
  await writeMcpCredentialJson(sharedMobileFlowPath(record.flowId), record, MCP_SYSTEM_SCOPE);
  if (!isDeepStrictEqual(await readSharedMobileFlow(record.flowId), record)) throw new MobileScopedError('MOBILE_OAUTH_SAVE_UNCONFIRMED', 'The native sign-in save is unconfirmed.', 503);
  if (record.providerState) {
    const path = sharedMobileStatePath(record.source, record.providerState);
    await writeMcpCredentialJson(path, record, MCP_SYSTEM_SCOPE);
    if (!isDeepStrictEqual(await readMcpCredentialJson(path, MCP_SYSTEM_SCOPE), record)) throw new MobileScopedError('MOBILE_OAUTH_SAVE_UNCONFIRMED', 'The native sign-in return save is unconfirmed.', 503);
  }
}
function sharedMobileInitiator(record: Pick<SharedMobileFlow, 'userId' | 'workspaceId' | 'authSessionId'>) {
  return { actor: { userId: record.userId, workspaceId: record.workspaceId }, authSessionId: record.authSessionId };
}
async function requireSharedMobileFlow(context: MobileScopedContext, ref: string, flowId: string): Promise<SharedMobileFlow> {
  await revalidateMobileScopedContext(context);
  const record = await readSharedMobileFlow(flowId);
  if (record.userId !== context.userId || record.connectionRef !== validateIntegrationConnectionRef(ref)) throw new MobileScopedError('MOBILE_OAUTH_FLOW_NOT_FOUND', 'The native sign-in is unavailable.', 404);
  if (record.authSessionId !== context.authSessionId || record.workspaceId !== context.workspaceId || record.actorOrganizationId !== context.organizationId) {
    throw new MobileScopedError('MOBILE_OAUTH_SCOPE_CHANGED', 'The original native sign-in context is required.', 403);
  }
  const auth = await authorizeIntegrationConnection(sharedMobileInitiator(record).actor, record.connectionRef, 'manage');
  if (auth.resource.source !== record.source || auth.backend.source !== record.source) throw new MobileScopedError('MOBILE_OAUTH_SOURCE_CHANGED', 'The selected provider changed.', 409);
  if (record.phase === 'no_auth') {
    await withAuthorizedIntegrationConnection(sharedMobileInitiator(record).actor, record.connectionRef, 'manage', undefined, async (current, database) => {
      const provider = await resolveAuthorizedComposioConnectionContext(current, database), proof = record.nativeCompletionProof!;
      if (current.backend.source !== 'composio' || current.backend.accountBinding !== 'no_auth'
        || current.authorizationRevision !== proof.authorizationRevision || provider.sharedBinding?.profileRevision !== proof.profileRevision
        || await sharedComposioCredentialRevision(provider) !== proof.credentialRevision) {
        throw new MobileScopedError('MOBILE_OAUTH_BINDING_CHANGED', 'The confirmed native connection changed.', 409);
      }
    });
  }
  await revalidateMobileScopedContext(context);
  return record;
}
function projectSharedMobileOAuth(record: SharedMobileFlow, summary?: BrokerSummary) {
  if (summary && (summary.connectionRef !== record.connectionRef || summary.state !== record.providerState
    || !iso.safeParse(summary.expiresAt).success || record.phase === 'linked' && summary.expiresAt !== record.expiresAt)) {
    throw new MobileScopedError('MOBILE_OAUTH_FLOW_INVALID', 'The broker sign-in binding changed.', 409);
  }
  const flow: MobileSharedOAuthSummary = { flowId: record.flowId, connectionRef: record.connectionRef, source: record.source,
    workspaceId: record.workspaceId, expiresAt: summary?.expiresAt ?? record.expiresAt,
    status: record.phase === 'no_auth' ? 'completed' : record.phase === 'cancelled' ? 'cancelled' : summary?.status ?? (Date.parse(record.expiresAt) <= Date.now() ? 'expired' : 'starting'),
    ...(record.phase === 'no_auth' ? { noAuth: true as const } : {}),
    ...(summary?.code && /^[A-Za-z0-9_]{1,100}$/u.test(summary.code) ? { errorCode: summary.code }
      : !summary && record.phase === 'pending' ? { errorCode: 'MOBILE_OAUTH_START_UNCONFIRMED' } : {}),
  };
  return { flow, returnUrl: `${record.returnUrl}?flowId=${encodeURIComponent(record.flowId)}`,
    ...(summary?.status === 'waiting' && summary.authorizationUrl ? { authorizationUrl: summary.authorizationUrl } : {}) };
}
async function readSharedMobileBroker(record: SharedMobileFlow): Promise<BrokerSummary | undefined> {
  if (record.phase === 'no_auth' || record.phase === 'cancelled' || !record.providerState) return undefined;
  const initiator = sharedMobileInitiator(record);
  try {
    return record.source === 'mcp' ? await getSharedMcpDesktopOAuthStatus(initiator, record.connectionRef, record.providerState)
      : await getSharedComposioDesktopOAuthStatusByIntent(initiator, record.connectionRef, record.flowId);
  } catch (error) {
    if (record.phase === 'pending' && record.source === 'composio' && (error as { status?: unknown; code?: unknown })?.status === 404
      && (error as { code?: unknown }).code === 'CONNECTION_DESKTOP_OAUTH_STATE_INVALID') return undefined;
    throw error;
  }
}
async function cleanupSharedMobileFlows(): Promise<void> {
  if (Date.now() - lastCleanup < 60_000) return; lastCleanup = Date.now();
  let directory;
  try { directory = await fs.opendir(resolveMcpStoragePath(DIRECTORY, MCP_SYSTEM_SCOPE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let count = 0;
  for await (const entry of directory) {
    if (++count > 200) break;
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const raw = await readMcpCredentialJson(`${DIRECTORY}/${entry.name}`, MCP_SYSTEM_SCOPE), candidate = recordSchema.safeParse(raw);
    if (!candidate.success || Date.parse(candidate.data.expiresAt) + RETENTION > Date.now()) continue;
    await withMcpStorageLock(`mobile-shared-${sharedMobileDigest(candidate.data.flowId)}`, MCP_SYSTEM_SCOPE, async () => {
      const current = await readSharedMobileFlow(candidate.data.flowId);
      if (Date.parse(current.expiresAt) + RETENTION > Date.now()) return;
      if (current.providerState) await removeMcpCredentialJson(sharedMobileStatePath(current.source, current.providerState), MCP_SYSTEM_SCOPE);
      await removeMcpCredentialJson(sharedMobileFlowPath(current.flowId), MCP_SYSTEM_SCOPE);
    });
  }
}

/** A known mobile intent is sealed before any provider-start mutation; retries only inspect it. */
export async function startMobileSharedConnectionOAuth(context: MobileScopedContext, reference: string, value: MobileSharedOAuthStart, origin: string) {
  const input = mobileSharedOAuthStartSchema.parse(value), ref = validateIntegrationConnectionRef(reference);
  let returnUrl: string;
  try { returnUrl = normalizeMobileSharedOAuthReturnUrl(input.returnUrl); }
  catch { throw new MobileScopedError('MOBILE_OAUTH_RETURN_INVALID', 'The native return destination is invalid.'); }
  await revalidateMobileScopedContext(context); await cleanupSharedMobileFlows();
  return withMcpStorageLock(`mobile-shared-${sharedMobileDigest(input.flowId)}`, MCP_SYSTEM_SCOPE, async () => {
    const existing = await readMcpCredentialJson(sharedMobileFlowPath(input.flowId), MCP_SYSTEM_SCOPE);
    const expected: IntegrationConnectionRevisions = { metadataRevision: input.expectedMetadataRevision, grantsRevision: input.expectedGrantsRevision, bindingRevision: input.expectedBindingRevision };
    if (existing) {
      const record = await requireSharedMobileFlow(context, ref, input.flowId);
      if (record.source !== input.source || record.returnUrl !== returnUrl || !isDeepStrictEqual(record.revisions, expected)) throw new MobileScopedError('MOBILE_OAUTH_INTENT_CHANGED', 'Keep the original sign-in intent.', 409);
      const summary = await readSharedMobileBroker(record); await requireSharedMobileFlow(context, ref, input.flowId);
      return projectSharedMobileOAuth(record, summary);
    }
    const initiator = sharedMobileInitiator(context), auth = await authorizeIntegrationConnection(initiator.actor, ref, 'manage');
    if (auth.resource.source !== input.source || auth.backend.source !== input.source) throw new MobileScopedError('MOBILE_OAUTH_SOURCE_CHANGED', 'Select the exact provider.', 409);
    if (!isDeepStrictEqual({ metadataRevision: auth.resource.metadataRevision, grantsRevision: auth.resource.grantsRevision, bindingRevision: auth.resource.bindingRevision }, expected)) {
      throw new MobileScopedError('CONNECTION_REVISION_CONFLICT', 'Reload the current connection revisions.', 409);
    }
    const composioBaseline = input.source === 'composio'
      ? await withAuthorizedIntegrationConnection(initiator.actor, ref, 'manage', expected, async (current, database) => {
        const provider = await resolveAuthorizedComposioConnectionContext(current, database);
        return { profileRevision: provider.sharedBinding!.profileRevision, credentialRevision: await sharedComposioCredentialRevision(provider) };
      }) : undefined;
    const now = Date.now(), record: SharedMobileFlow = { version: 2, connectionId: 'mobile-shared-oauth-v2', organizationId: null,
      flowId: input.flowId, source: input.source, connectionRef: ref, userId: context.userId, authSessionId: context.authSessionId,
      workspaceId: context.workspaceId, actorOrganizationId: context.organizationId, revisions: expected, returnUrl,
      providerState: input.source === 'composio' ? deriveSharedComposioDesktopOAuthState(input.flowId, initiator, ref) : null,
      phase: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL).toISOString() };
    await saveSharedMobileFlow(record); await requireSharedMobileFlow(context, ref, input.flowId);
    try {
      if (input.source === 'mcp') {
        await startSharedMcpOAuth(initiator.actor, ref, expected, origin, { desktop: { authSessionId: initiator.authSessionId },
          onCreated: async created => { record.providerState = created.state; record.expiresAt = created.expiresAt; record.phase = 'linked'; await saveSharedMobileFlow(record); } });
      } else {
        const result = await startSharedComposioDesktopOAuth(initiator, ref, { ...expected, intent: input.flowId });
        if ('noAuth' in result) {
          if (result.connectionRef !== ref) throw new MobileScopedError('MOBILE_OAUTH_FLOW_INVALID', 'The provider result does not match.', 409);
          record.nativeCompletionProof = await withAuthorizedIntegrationConnection(initiator.actor, ref, 'manage', undefined, async (current, database) => {
            const provider = await resolveAuthorizedComposioConnectionContext(current, database), credentialRevision = await sharedComposioCredentialRevision(provider);
            if (current.backend.source !== 'composio' || !isDeepStrictEqual(current.backend, { ...auth.backend, accountBinding: 'no_auth', connectedAccountId: null })
              || !isDeepStrictEqual(current.resource.ownership, auth.resource.ownership)
              || current.resource.metadataRevision !== expected.metadataRevision || current.resource.grantsRevision !== expected.grantsRevision
              || current.resource.bindingRevision !== expected.bindingRevision + 1 || provider.sharedBinding?.profileRevision !== composioBaseline!.profileRevision
              || credentialRevision !== composioBaseline!.credentialRevision) {
              throw new MobileScopedError('MOBILE_OAUTH_BINDING_CHANGED', 'The native completion changed before confirmation.', 409);
            }
            return { authorizationRevision: current.authorizationRevision, profileRevision: provider.sharedBinding!.profileRevision, credentialRevision };
          });
          record.phase = 'no_auth';
        }
        else { if (result.state !== record.providerState || result.connectionRef !== ref) throw new MobileScopedError('MOBILE_OAUTH_FLOW_INVALID', 'The provider result does not match.', 409);
          record.phase = 'linked'; record.expiresAt = result.expiresAt; }
        await saveSharedMobileFlow(record);
      }
      const summary = await readSharedMobileBroker(record); await requireSharedMobileFlow(context, ref, input.flowId);
      return projectSharedMobileOAuth(record, summary);
    } catch (error) {
      // Only the exact created MCP state can be cancelled; no new start or SDK retry is inferred.
      if (record.source === 'mcp' && record.providerState) {
        try {
          await revalidateMobileScopedContext(context);
          const cancelled = await cancelSharedMcpDesktopOAuth(initiator, ref, record.providerState);
          if (cancelled.status === 'cancelled') { record.phase = 'cancelled'; await saveSharedMobileFlow(record); }
        } catch { /* Preserve the sealed pending intent when original authority or cancellation ACK is unavailable. */ }
      }
      throw error;
    }
  });
}
export async function readMobileSharedConnectionOAuth(context: MobileScopedContext, ref: string, flowId: string) {
  const record = await requireSharedMobileFlow(context, ref, flowId), summary = await readSharedMobileBroker(record);
  await requireSharedMobileFlow(context, ref, flowId);
  return projectSharedMobileOAuth(record, summary);
}
export async function decideMobileSharedConnectionOAuth(context: MobileScopedContext, ref: string, flowId: string, action: 'finalize' | 'cancel') {
  if (action !== 'finalize' && action !== 'cancel') throw new MobileScopedError('INVALID_REQUEST', 'Select a sign-in action.');
  mobileSharedOAuthFlowIdSchema.parse(flowId);
  return withMcpStorageLock(`mobile-shared-${sharedMobileDigest(flowId)}`, MCP_SYSTEM_SCOPE, async () => {
    const record = await requireSharedMobileFlow(context, ref, flowId);
    if (record.phase === 'no_auth' || record.phase === 'cancelled') return projectSharedMobileOAuth(record);
    if (record.source === 'mcp' && record.providerState === null && action === 'cancel') {
      // A failed pre-state start has only this sealed mobile intent to cancel.
      // The flow lock excludes an in-flight start; no provider state is inferred.
      record.phase = 'cancelled';
      await saveSharedMobileFlow(record);
      await requireSharedMobileFlow(context, ref, flowId);
      return projectSharedMobileOAuth(record);
    }
    const initiator = sharedMobileInitiator(record);
    const summary = record.source === 'composio'
      ? action === 'cancel' ? await cancelSharedComposioDesktopOAuthIntent(initiator, ref, { ...record.revisions, intent: record.flowId })
        : await finalizeSharedComposioDesktopOAuth(initiator, ref, record.providerState!)
      : record.providerState ? action === 'cancel' ? await cancelSharedMcpDesktopOAuth(initiator, ref, record.providerState)
        : await finalizeSharedMcpDesktopOAuth(initiator, ref, record.providerState) : undefined;
    await requireSharedMobileFlow(context, ref, flowId);
    return projectSharedMobileOAuth(record, summary);
  });
}
/** Called only after the exact provider's anonymous collector has accepted its state. */
export async function mobileSharedOAuthReturn(source: MobileSharedOAuthSource, state: string): Promise<string | null> {
  if (source === 'mcp' ? !/^desktop_[A-Za-z0-9_-]{32}$/u.test(state) : !mobileSharedOAuthFlowIdSchema.safeParse(state).success) return null;
  const indexed = await readMcpCredentialJson(sharedMobileStatePath(source, state), MCP_SYSTEM_SCOPE);
  if (!indexed) return null;
  const record = parseSharedMobileFlow(indexed), current = await readSharedMobileFlow(record.flowId);
  if (!isDeepStrictEqual(record, current) || record.source !== source || record.providerState !== state) throw new MobileScopedError('MOBILE_OAUTH_FLOW_INVALID', 'The native return binding changed.', 409);
  if (Date.parse(record.expiresAt) <= Date.now()) return null;
  return `${normalizeMobileSharedOAuthReturnUrl(record.returnUrl)}?flowId=${encodeURIComponent(record.flowId)}`;
}
