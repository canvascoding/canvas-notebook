import { isCoreExtensionSelection } from '@/app/lib/capabilities/extensions/core-source-contracts';
import 'server-only';
import { createHash } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { chatExtensionSelectionSchema, extensionSelectionIdentity, EXTENSION_SELECTION_LIMITS } from '@/app/lib/capabilities/extensions/contracts';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { parseChatBody, type ChatReferenceBundleV1 } from './chat-body-contracts';
import { revalidateChatExtensionOptionsContext, type ChatExtensionOptionsContext } from './extension-options-context';
import type { ChatExtensionRecentItem, ChatExtensionOptionsRequest, ChatExtensionSearchRequest } from './extension-options-contracts';
import { chatCorePluginSelectionEligibility, chatPackageSelectionEligibility } from './extension-options-eligibility';
import { presentChatExtensionIcon } from './extension-options-presentation';
import { validateChatConnectionMetadata } from './extension-options-validation';

import { inspectCapabilityResource } from '@/app/lib/capabilities/resources/actions';
import { authorizeChatExtensionSharedOption } from './extension-options-context';
import type { CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import type { ExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
type Filters = Pick<ChatExtensionSearchRequest, 'types' | 'stock' | 'source' | 'scope' | 'audience' | 'teamId'>;
async function matchesFilters(context: ChatExtensionOptionsContext, selection: ExtensionSelection, filters?: Filters): Promise<boolean> {
  if (!filters) return true;
  const type = selection.kind === 'composio' ? 'integration' : selection.kind==='core_plugin'?'plugin':selection.kind==='core_skill'?'skill':selection.kind;
  const source = selection.kind === 'mcp' ? 'mcp' : selection.kind === 'composio' ? 'composio' : 'local';
  if (!filters.types.includes(type) || filters.stock === 'available' || filters.source !== 'all' && filters.source !== source) return false;
  if (filters.scope === 'all') return true;
  const owner: CapabilityResourceOwnerScope = isCoreExtensionSelection(selection)?{type:'system'}:selection.kind === 'plugin' || selection.kind === 'skill'
    ? (await inspectCapabilityResource({ userId: context.actor.userId, workspaceId: context.actor.workspaceId }, selection.package.resourceRef)).metadata.ownership
    : selection.target.kind === 'shared' ? (await authorizeChatExtensionSharedOption(context, selection.target.connectionRef)).resource.ownership
    : { type: 'user', ownerUserId: context.actor.userId, organizationId: context.organizationId };
  if (filters.scope === 'user') { const own = owner.type === 'user' && owner.ownerUserId === context.actor.userId;
    return filters.audience === 'own' ? own : filters.audience === 'shared' ? !own && owner.type !== 'system' : own || owner.type !== 'system'; }
  if (filters.scope === 'team') return owner.type === 'team' && owner.workspaceId === filters.teamId;
  return owner.type === filters.scope;
}
type RecentRequest = Extract<ChatExtensionOptionsRequest, { operation: 'recents' }>;
/** Admission is the recorder: retries, settlement and rejected sends never create a new last-used event. */
export async function readChatExtensionRecents(context: ChatExtensionOptionsContext, request: Pick<RecentRequest, 'limit' | 'cursor'>,
  signal: AbortSignal, filters?: Filters) {
  await revalidateChatExtensionOptionsContext(context);
  const binding = createHash('sha256').update(JSON.stringify([context.contextKey, request.limit, filters ?? null])).digest('base64url');
  let previousIdentities: string[] = [];
  let position: { at: number; session: string; client: string; bundle: number } | null = null;
  if (request.cursor) try {
    const value = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
    if (Object.keys(value).sort().join(',') !== 'binding,position,seen,v' || value.v !== 1 || value.binding !== binding
      || !Number.isSafeInteger(value.position?.at) || value.position.at < 0
      || typeof value.position.session !== 'string' || typeof value.position.client !== 'string'
      || !Number.isSafeInteger(value.position.bundle) || value.position.bundle < 0 || value.position.bundle > Number.MAX_SAFE_INTEGER
      || !Array.isArray(value.seen) || value.seen.length > 128 || value.seen.some((key: unknown) => typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key))) throw new Error('cursor');
    position = value.position; previousIdentities = value.seen;
  } catch { throw new AgentWorkflowError('CHAT_EXTENSION_CURSOR_CHANGED', 'The current recent selection context changed.', 409); }
  const database = await openDb();
  type Row = { created_at: number; session_id: string; client_message_id: string; actor: string; workspace: string; agent: string;
    actual_agent: string; stored_session: string; public_selection: unknown; body: unknown };
  let rows: Row[];
  try {
    rows = await database.all(`SELECT r.created_at,s.session_id,r.client_message_id,
      r.private_payload::jsonb #>> '{identity,userId}' AS actor,
      r.private_payload::jsonb #>> '{identity,workspaceId}' AS workspace,
      r.private_payload::jsonb #>> '{identity,sessionId}' AS stored_session,
      r.private_payload::jsonb #>> '{identity,agentId}' AS agent,s.agent_id AS actual_agent,
      r.private_payload::jsonb #> '{extensionSelection,publicSelection}' AS public_selection,
      CASE WHEN jsonb_exists(r.private_payload::jsonb, 'body') THEN jsonb_build_object('version',1,
        'parts',(SELECT COALESCE(jsonb_agg(p),'[]'::jsonb) FROM jsonb_array_elements(r.private_payload::jsonb #> '{body,parts}') p WHERE p->>'type'='extension_reference'),
        'bundles',r.private_payload::jsonb #> '{body,bundles}') ELSE NULL END AS body
      FROM pi_message_delivery_receipts r JOIN pi_sessions s ON s.id=r.pi_session_db_id
      WHERE s.user_id=$1 AND s.workspace_id=$2 AND r.state='accepted' AND r.payload_version=1
        AND r.private_payload IS NOT NULL ${position ? 'AND (r.created_at,s.session_id,r.client_message_id)<=($3,$4,$5)' : ''}
      ORDER BY r.created_at DESC,s.session_id DESC,r.client_message_id DESC LIMIT 21`,
    [context.actor.userId, context.actor.workspaceId, ...(position ? [position.at, position.session, position.client] : [])]) as Row[];
  } finally { await database.close(); }
  const items: ChatExtensionRecentItem[] = [], seen = new Set<string>(previousIdentities);
  let examined = 0, resultBytes = 0, boundedStop = false, stoppedAt: { at: number; session: string; client: string; bundle: number } | null = null;
  outer: for (const row of rows.slice(0, 20)) {
    signal.throwIfAborted(); examined++;
    stoppedAt = { at: Number(row.created_at), session: row.session_id, client: row.client_message_id, bundle: Number.MAX_SAFE_INTEGER };
    if (row.actor !== context.actor.userId || row.workspace !== context.actor.workspaceId || row.agent !== row.actual_agent || row.stored_session !== row.session_id || !Number.isSafeInteger(Number(row.created_at))) continue;
    let bundles: ChatReferenceBundleV1[];
    try {
      if (row.body) bundles = parseChatBody(typeof row.body === 'string' ? JSON.parse(row.body) : row.body).bundles;
      else {
        const selection = chatExtensionSelectionSchema.parse(typeof row.public_selection === 'string' ? JSON.parse(row.public_selection) : row.public_selection);
        bundles = selection.selections.map((entry, index) => {
          const primary = entry.selection;
          const mappings = primary.kind === 'plugin' || primary.kind === 'skill' ? (selection.packageConnections ?? []).filter(mapping =>
            JSON.stringify(mapping.package) === JSON.stringify(primary.package)) : [];
          return { id: `recent-${index}`, caption: primary.kind === 'core_plugin'?'Plugin Creator':primary.kind === 'core_skill'?primary.coreSource.resourceRef.split(':').at(-1)!:primary.kind === 'composio' ? primary.toolkit : primary.kind === 'mcp' ? 'MCP' : primary.kind === 'plugin' ? 'Plugin' : 'Skill',
            primary: entry, supporting: selection.selections.filter(other => other.selection.kind === 'mcp' || other.selection.kind === 'composio')
              .filter(other => mappings.some(mapping => JSON.stringify(mapping.connectionSelection) === JSON.stringify(other.selection)))
              .map(other => ({ ...other, selection: other.selection as import('@/app/lib/capabilities/extensions/contracts').StandaloneExtensionSelection })), packageConnections: mappings };
        });
      }
    } catch { continue; }
    let bundleIndex = 0;
    for (const bundle of bundles) {
      bundleIndex++;
      if (position && Number(row.created_at) === position.at && row.session_id === position.session && row.client_message_id === position.client && bundleIndex <= position.bundle) continue;
      const selection = bundle.primary.selection, identity = createHash('sha256').update(extensionSelectionIdentity(selection)).digest('hex');
      stoppedAt = { at: Number(row.created_at), session: row.session_id, client: row.client_message_id, bundle: bundleIndex };
      if (seen.has(identity)) continue;
      try {
        const eligibility = isCoreExtensionSelection(selection)?await chatCorePluginSelectionEligibility(context,selection):selection.kind === 'plugin' || selection.kind === 'skill' ? await chatPackageSelectionEligibility(context, selection)
          : { action: 'select' as const };
        for (const entry of [bundle.primary, ...bundle.supporting]) {
          if (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill'||isCoreExtensionSelection(entry.selection)) continue;
          const mappings = bundle.packageConnections.filter(mapping => JSON.stringify(mapping.connectionSelection) === JSON.stringify(entry.selection));
          if (mappings.length) for (const mapping of mappings) await validateChatConnectionMetadata(context, entry, signal, mapping, false);
          else await validateChatConnectionMetadata(context, entry, signal, undefined, false);
        }
        if (eligibility.action === 'unavailable' || !await matchesFilters(context, selection, filters)) continue;
        const publicIcon = await presentChatExtensionIcon(context, selection, signal).catch(() => undefined);
        const accountConfirmation = [bundle.primary, ...bundle.supporting].some(entry => entry.selection.kind === 'composio'
          && entry.selection.target.kind === 'personal' && entry.selection.target.accountBinding === 'account');
        const item: ChatExtensionRecentItem = { bodyBundle: bundle, lastAcceptedAt: Number(row.created_at),
          eligibility: accountConfirmation ? { action: 'choose_connection', reason: { code: 'CHAT_EXTENSION_ACCOUNT_CONFIRMATION_REQUIRED',
            message: 'Confirm the same exact personal account again before sending.' } } : eligibility, ...(publicIcon ? { publicIcon } : {}) };
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (bytes > EXTENSION_SELECTION_LIMITS.bytes) continue;
        if (resultBytes + bytes > EXTENSION_SELECTION_LIMITS.bytes) { stoppedAt.bundle--; boundedStop = true; break outer; }
        resultBytes += bytes; seen.add(identity); items.push(item);
      } catch { /* A revoked/unavailable exact source is not a usable recent reference. */ }
      if (items.length >= request.limit || seen.size >= 128) break outer;
    }
    stoppedAt = { at: Number(row.created_at), session: row.session_id, client: row.client_message_id, bundle: bundles.length };
  }
  await revalidateChatExtensionOptionsContext(context);
  // Optional logo IO is complete: recheck all exact sources before returning metadata.
  for (let index = items.length - 1; index >= 0; index--) try {
    const item = items[index]!, primary = item.bodyBundle.primary.selection;
    if(isCoreExtensionSelection(primary)&&(await chatCorePluginSelectionEligibility(context,primary)).action!=='select')throw new Error('changed');
    if ((primary.kind === 'plugin' || primary.kind === 'skill') && (await chatPackageSelectionEligibility(context, primary)).action !== 'select') throw new Error('changed');
    for (const entry of [item.bodyBundle.primary, ...item.bodyBundle.supporting]) if (entry.selection.kind === 'mcp' || entry.selection.kind === 'composio') {
      const mappings = item.bodyBundle.packageConnections.filter(mapping => JSON.stringify(mapping.connectionSelection) === JSON.stringify(entry.selection));
      if (mappings.length) for (const mapping of mappings) await validateChatConnectionMetadata(context, entry, signal, mapping, false);
      else await validateChatConnectionMetadata(context, entry, signal, undefined, false);
    }
  } catch { items.splice(index, 1); }
  await revalidateChatExtensionOptionsContext(context);
  const hasNextPage = Boolean(seen.size < 128 && stoppedAt && (boundedStop || items.length >= request.limit || resultBytes >= EXTENSION_SELECTION_LIMITS.bytes || examined < rows.length || rows.length > 20));
  return { items, pagination: { nextCursor: hasNextPage ? Buffer.from(JSON.stringify({ v: 1, binding,
    position: stoppedAt, seen: [...seen] })).toString('base64url') : null,
    hasNextPage, loadedItems: items.length } };
}
