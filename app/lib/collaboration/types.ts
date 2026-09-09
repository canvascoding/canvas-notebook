import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';

export const COLLABORATION_SCHEMA_VERSION = 1;
export const RICH_MARKDOWN_SCHEMA_VERSION = 3;
export const RICH_BLOCK_TREE_FORMAT_VERSION = 1;
export const COLLABORATION_CLIENT_CAPABILITIES = {
  richTextSchemaVersion: RICH_MARKDOWN_SCHEMA_VERSION,
  blockTreeFormatVersion: RICH_BLOCK_TREE_FORMAT_VERSION,
} as const;
export const COLLABORATION_TICKET_TTL_MS = 90_000;

export type CollaborationProvider = 'yjs' | 'excalidraw';
export type RichTextCollaborationRepresentation = 'tiptap_xml' | 'tiptap_blocks';
export type TextCollaborationRepresentation = 'plain_text' | RichTextCollaborationRepresentation;
export function isRichTextCollaborationRepresentation(value: unknown): value is RichTextCollaborationRepresentation {
  return value === 'tiptap_xml' || value === 'tiptap_blocks';
}

export function supportsBlockTreeCollaboration(value: { richTextSchemaVersion?: unknown; blockTreeFormatVersion?: unknown }): boolean {
  return value.richTextSchemaVersion === RICH_MARKDOWN_SCHEMA_VERSION
    && value.blockTreeFormatVersion === RICH_BLOCK_TREE_FORMAT_VERSION;
}
export type CollaborationRepresentation = TextCollaborationRepresentation | 'excalidraw_scene';
/**
 * `auto` is accepted only while establishing a text-collaboration session.
 * The server resolves it to the durable representation before issuing a
 * ticket, so a client never guesses the Yjs top-level type from a file
 * checkpoint.
 */
export type CollaborationSessionRepresentation = CollaborationRepresentation | 'auto';
export type CollaborationPermission = 'read' | 'write';
export type CollaborationActorType = 'user' | 'agent';
export type CollaborationActivity = 'viewing' | 'editing' | 'agent_editing';
export type CollaborationConnectionStatus =
  | 'disabled'
  | 'connecting'
  | 'live'
  | 'persisting'
  | 'saved'
  | 'offline'
  | 'reconnecting'
  | 'read_only'
  | 'degraded';

export type TextCollaborationConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'read_only'
  | 'denied';

export type TextCollaborationDurabilityState =
  | 'local_pending'
  | 'server_received'
  | 'persisted_yjs'
  | 'checkpoint_pending'
  | 'checkpointed_file'
  | 'degraded';

export interface CollaborationTicketClaims {
  /** File guests use a separate, file-scoped cookie and never an app account. */
  guestInvitationId?: string;
  guestPolicyRevision?: number;
  schemaVersion: number;
  issuedAt: number;
  expiresAt: number;
  userId: string;
  sessionId: string;
  workspaceId: string;
  organizationId: string | null;
  documentId: string;
  path: string;
  provider: CollaborationProvider;
  representation: CollaborationRepresentation;
  permission: CollaborationPermission;
  lifecycleGeneration: number;
}

export interface CollaborationSessionResponse {
  guestAccess?: { invitationId: string; workspaceId: string };
  success: true;
  documentId: string;
  documentName: string;
  provider: CollaborationProvider;
  representation: CollaborationRepresentation;
  lifecycleGeneration: number;
  schemaVersion: number;
  richTextSchemaVersion: number;
  blockTreeFormatVersion?: number;
  permission: CollaborationPermission;
  documentSequence?: number;
  checkpointSequence?: number;
  stateVector?: string;
  stateProof?: string | null;
  token: string;
  expiresAt: string;
  websocketUrl: string;
  user: {
    id: string;
    name: string;
    color: string;
    colorLight: string;
  };
}

export interface FilePresenceEntry {
  workspaceId: string;
  documentId: string;
  path: string;
  userId: string;
  sessionId: string;
  actorType: CollaborationActorType;
  initiatedByUserId: string | null;
  displayName: string;
  profile?: ResolvedUserProfile | null;
  color: string;
  colorLight: string;
  activity: CollaborationActivity;
  updatedAt: number;
}

export interface WorkspacePresenceSnapshot {
  workspaceId: string;
  version: number;
  entries: FilePresenceEntry[];
}

export type WorkspacePresenceMessage =
  | ({ type: 'snapshot' } & WorkspacePresenceSnapshot)
  | {
      type: 'delta';
      workspaceId: string;
      version: number;
      documentId: string;
      entries: FilePresenceEntry[];
    };
