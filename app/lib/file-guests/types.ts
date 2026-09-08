export type FileGuestPermission = 'read' | 'write';

export interface FileGuestInvitationView {
  id: string;
  path: string;
  email: string;
  permission: FileGuestPermission;
  status: 'active' | 'expired' | 'revoked' | 'unavailable';
  expiresAt: string | null;
  policyRevision: number;
  createdAt: string;
  url: string;
  assetCount: number;
}

export type FileGuestAsset = { path: string; identity: string };

export const fileGuestUrl = (id: string) => `/guest/files/${encodeURIComponent(id)}`;
export const fileGuestApi = (id: string) => `/api/guest/files/${encodeURIComponent(id)}`;
export const fileGuestCookieName = (id: string) => `canvas-file-guest-${id}`;
export const isFileGuestId = (id: string) => /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u.test(id);
