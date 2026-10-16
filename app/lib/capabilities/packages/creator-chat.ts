import 'server-only';

import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { listChatExtensionOptions } from '@/app/lib/chat/extension-options';
import { parseChatBody, projectChatBodyText } from '@/app/lib/chat/chat-body-contracts';
import type { ExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { CapabilityResourceActor } from '../resources/contracts';
import { listCapabilityPackageCreationScopes, readCapabilityPackageDraftAction } from './actions';
import { CapabilityPackageError } from './contracts';
import { capabilityPackageCreatorChatIntentSchema, type CapabilityPackageCreatorChat, type CapabilityPackageCreatorOptions } from './creator-chat-contracts';

type Actor = CapabilityResourceActor & { sessionId?: string | null };
const names = { plugin: 'plugin-creator', skill: 'skill-creator' } as const;
const references = { plugin: 'canvas-capability:v1:plugin:system:core:plugin-creator',
  skill: 'canvas-capability:v1:skill:system:core:skill-creator' } as const;
function workspace(actor: Actor): string {
  if (!actor.workspaceId || actor.workspaceId !== actor.workspaceId.trim()) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Choose one current workspace.', 403);
  return actor.workspaceId;
}
async function creationPermission(actor: Actor) {
  const resourceActor = { userId: actor.userId, workspaceId: workspace(actor) };
  const choices = await listCapabilityPackageCreationScopes(resourceActor);
  const organization = await readOrganizationPermissionForUser(actor.userId);
  const permission = organization.permission;
  const allowed = organization.configured && Boolean(organization.organizationId) && permission?.status === 'active'
    && ['owner', 'admin'].includes(permission.role) && permission.canSharePluginsAndSkills
    && choices.some(choice => choice.type === 'organization');
  return { allowed, ownership: organization.organizationId ? { type: 'organization' as const, organizationId: organization.organizationId } : null };
}
async function creatorSelection(actor: Actor, kind: 'plugin' | 'skill'): Promise<ExtensionSelection | null> {
  const response = await listChatExtensionOptions({ ...actor, source: 'api' }, { operation: 'search',
    target: { kind: 'draft_turn', agentId: DEFAULT_AGENT_ID, workspaceId: workspace(actor) },
    q: names[kind], types: [kind], stock: 'installed', scope: 'system', source: 'all', limit: 10 });
  if (response.operation !== 'search') return null;
  return response.items.find(row => row.eligibility.action === 'select'
    && (kind === 'plugin' ? row.selection?.kind === 'core_plugin' : row.selection?.kind === 'core_skill')
    && row.selection && 'coreSource' in row.selection && row.selection.coreSource.resourceRef === references[kind])?.selection ?? null;
}

/** Availability is a current server observation, never a grant or permission inferred from UI role labels. */
export async function readCapabilityPackageCreatorOptionsAction(actor: Actor): Promise<CapabilityPackageCreatorOptions> {
  const permission = await creationPermission(actor);
  const creators = [];
  for (const kind of ['plugin', 'skill'] as const) creators.push({ kind, available: permission.allowed && Boolean(await creatorSelection(actor, kind)) });
  const fresh = await creationPermission(actor);
  return { schemaVersion: 1, workspaceId: workspace(actor), canCreate: fresh.allowed, ownership: fresh.ownership,
    creators: creators.map(creator => ({ ...creator, available: fresh.allowed && creator.available })) };
}

/** Prepare the ordinary inline body only. No draft, session, provider call, message or account selection is created. */
export async function prepareCapabilityPackageCreatorChatAction(actor: Actor, value: unknown): Promise<CapabilityPackageCreatorChat> {
  const parsed = capabilityPackageCreatorChatIntentSchema.safeParse(value);
  if (!parsed.success) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'Choose one exact Creator task.');
  const intent = parsed.data, resourceActor = { userId: actor.userId, workspaceId: workspace(actor) };
  const selectedDraft = intent.operation === 'resume' ? await readCapabilityPackageDraftAction(resourceActor, intent.draftRef) : null;
  const kind = selectedDraft?.draft.kind ?? (intent.operation === 'create' ? intent.kind : null);
  if (!kind) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'Choose one Creator task.');
  if (intent.operation === 'create' && !(await creationPermission(actor)).allowed) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Current organization creation permission is required.', 403);
  const selection = await creatorSelection(actor, kind);
  if (!selection) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'This Creator is unavailable in the current chat context.', 403);
  const draft = intent.operation === 'resume' ? (await readCapabilityPackageDraftAction(resourceActor, intent.draftRef)).draft : null;
  if (intent.operation === 'create' && !(await creationPermission(actor)).allowed) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Current organization creation permission is required.', 403);
  const caption = kind === 'plugin' ? 'Plugin Creator' : 'Skill Creator', bundleId = randomUUID();
  const task = draft ? intent.locale === 'en'
    ? `Continue my ${kind} draft “${draft.name}” (${draft.draftRef}). Use this same draft. `
    : `Setze meinen ${kind === 'plugin' ? 'Plugin' : 'Skill'}-Entwurf „${draft.name}“ (${draft.draftRef}) fort. Verwende denselben Entwurf. `
    : intent.locale === 'en' ? `Create a ${kind} for our organization. Purpose: `
      : `Erstelle ${kind === 'plugin' ? 'ein Plugin' : 'einen Skill'} für unsere Organisation. Zweck: `;
  const body = parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId: randomUUID(), bundleId },
    { type: 'text', text: `\n\n${task}` }], bundles: [{ id: bundleId, caption,
      primary: { selection, requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }] });
  return { schemaVersion: 1, workspaceId: workspace(actor), agentId: DEFAULT_AGENT_ID, kind, mode: 'compose',
    body, prompt: projectChatBodyText(body), ...(draft ? { draftRef: draft.draftRef } : {}) };
}
