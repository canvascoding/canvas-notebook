import 'server-only';

import path from 'node:path';

import { resolveWorkspaceDataRoot } from './context';
import type { WorkspaceStatus, WorkspaceType, WorkspaceUserRole } from './types';
import type { WorkspaceColor } from './colors';
import type { WorkspaceIcon } from './icons';
import { DEFAULT_WORKSPACE_COLOR, parseWorkspaceColor } from './colors';
import { WORKSPACE_DESCRIPTION_MAX_LENGTH } from './description';

export interface WorkspaceRecord {
  id: string;
  organizationId: string;
  type: WorkspaceType;
  ownerUserId: string | null;
  customerId: string | null;
  projectId: string | null;
  rootRelativePath: string;
  displayName: string;
  description: string;
  icon: WorkspaceIcon;
  color: WorkspaceColor;
  status: WorkspaceStatus;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DefaultWorkspaceRecords { personal: WorkspaceRecord; }
export interface WorkspaceMemberRecord {
  workspaceId: string; userId: string; name: string | null; email: string | null;
  role: WorkspaceUserRole; status: WorkspaceStatus; canRead: boolean; canWrite: boolean;
  canManage: boolean; createdAt: number; updatedAt: number;
}
export interface WorkspaceMemberCandidate {
  userId: string; name: string | null; email: string | null;
  role: WorkspaceUserRole; status: WorkspaceStatus;
}
export type CreateWorkspaceRecordType = 'personal' | 'team' | 'project';

export class WorkspaceOperationError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WorkspaceOperationError';
    this.code = code;
    this.status = status;
  }
}

export const personalWorkspaceRootRelativePath = (userId: string) => path.posix.join('workspaces', 'personal', userId, 'files');
export const personalWorkspaceRootRelativePathForSlug = (userId: string, slug: string) => path.posix.join('workspaces', 'personal', userId, slug, 'files');
export const organizationWorkspaceRootRelativePath = (organizationId: string) => path.posix.join('workspaces', 'organization', organizationId, 'files');
export const organizationWorkspaceRootRelativePathForSlug = (organizationId: string, slug: string) => path.posix.join('workspaces', 'organization', organizationId, slug, 'files');
export const teamWorkspaceRootRelativePath = (organizationId: string) => path.posix.join('workspaces', 'team', organizationId, 'default', 'files');
export const teamWorkspaceRootRelativePathForSlug = (organizationId: string, slug: string) => path.posix.join('workspaces', 'team', organizationId, slug, 'files');
export const legacyTeamWorkspaceRootRelativePath = (organizationId: string) => path.posix.join('workspaces', 'team', organizationId, 'files');
export const projectWorkspaceRootRelativePath = (projectId: string) => path.posix.join('workspaces', 'project', projectId, 'files');

export function workspaceAbsoluteRoot(rootRelativePath: string): string {
  if (path.isAbsolute(rootRelativePath) || rootRelativePath.includes('\0')) throw new Error('Invalid workspace root path');
  const segments = rootRelativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) throw new Error('Invalid workspace root path');
  return path.join(resolveWorkspaceDataRoot(), ...segments);
}

export function normalizeWorkspaceSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

export function normalizeWorkspaceColor(value: unknown, fallback: WorkspaceColor = DEFAULT_WORKSPACE_COLOR): WorkspaceColor {
  if (value === undefined || value === null) return fallback;
  const color = parseWorkspaceColor(value);
  if (color) return color;
  throw new WorkspaceOperationError('WORKSPACE_COLOR_INVALID', 'Workspace color is invalid.', 400);
}

export function normalizeWorkspaceDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new WorkspaceOperationError('WORKSPACE_DESCRIPTION_INVALID', 'Workspace description must be text.', 400);
  const description = value.trim();
  if (description.length > WORKSPACE_DESCRIPTION_MAX_LENGTH) throw new WorkspaceOperationError('WORKSPACE_DESCRIPTION_TOO_LONG', `Workspace description must be ${WORKSPACE_DESCRIPTION_MAX_LENGTH} characters or fewer.`, 400);
  return description;
}
