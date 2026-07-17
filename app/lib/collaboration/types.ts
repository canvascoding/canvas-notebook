export const COLLABORATION_SCHEMA_VERSION = 1;
export const COLLABORATION_TICKET_TTL_MS = 90_000;

export type CollaborationProvider = 'yjs' | 'excalidraw';
export type TextCollaborationRepresentation = 'plain_text' | 'tiptap_xml';
export type CollaborationRepresentation = TextCollaborationRepresentation | 'excalidraw_scene';
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

export interface CollaborationTicketClaims {
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
  success: true;
  documentId: string;
  documentName: string;
  provider: CollaborationProvider;
  representation: CollaborationRepresentation;
  lifecycleGeneration: number;
  schemaVersion: number;
  permission: CollaborationPermission;
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
