'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  MemberAccessEditor,
  type MemberAccessPerson,
} from '@/app/components/settings/MemberAccessEditor';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import {
  getSoleActiveWorkspaceManagerId,
  WORKSPACE_LAST_MANAGER_CODE,
} from '@/app/lib/workspaces/member-manager-policy';

type WorkspaceMemberRecord = {
  workspaceId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
};

type WorkspaceMemberCandidate = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
};

type WorkspaceAccessLevel = 'viewer' | 'editor' | 'manager';

type WorkspaceMembersEditorProps = {
  active: boolean;
  workspace: ClientWorkspaceSummary;
  onChanged?: () => void | Promise<void>;
};

function getAccessLevel(member: Pick<WorkspaceMemberRecord, 'canWrite' | 'canManage'>): WorkspaceAccessLevel {
  if (member.canManage) return 'manager';
  if (member.canWrite) return 'editor';
  return 'viewer';
}

function getAccessInput(accessLevel: WorkspaceAccessLevel) {
  if (accessLevel === 'manager') {
    return { canRead: true, canWrite: true, canManage: true, role: 'admin' };
  }
  if (accessLevel === 'editor') {
    return { canRead: true, canWrite: true, canManage: false, role: 'member' };
  }
  return { canRead: true, canWrite: false, canManage: false, role: 'member' };
}

export function WorkspaceMembersEditor({ active, workspace, onChanged }: WorkspaceMembersEditorProps) {
  const t = useTranslations('settings.workspacePanel.management.members');
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([]);
  const [candidates, setCandidates] = useState<WorkspaceMemberCandidate[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [newAccessLevel, setNewAccessLevel] = useState<WorkspaceAccessLevel>('viewer');
  const [isLoading, setIsLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/workspaces/${encodeURIComponent(workspace.id)}/members`;

  const loadMembers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.load'));
      setMembers(Array.isArray(payload.members) ? payload.members : []);
      setCandidates(Array.isArray(payload.candidates) ? payload.candidates : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [endpoint, t]);

  useEffect(() => {
    if (!active) return;
    const timeout = window.setTimeout(() => void loadMembers(), 0);
    return () => window.clearTimeout(timeout);
  }, [active, loadMembers]);

  const memberViews = useMemo<Array<MemberAccessPerson<WorkspaceAccessLevel>>>(() => {
    const soleManagerId = getSoleActiveWorkspaceManagerId(members);
    return members.map((member) => {
      const protectsWorkspaceAccess = member.userId === soleManagerId;
      return {
        userId: member.userId,
        name: member.name,
        email: member.email,
        accessLevel: getAccessLevel(member),
        accessLevelLocked: protectsWorkspaceAccess,
        removalLocked: protectsWorkspaceAccess,
        restrictionHint: protectsWorkspaceAccess ? t('lastFullAccessHint') : null,
      };
    });
  }, [members, t]);
  const availableCandidates = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.userId));
    return candidates.filter((candidate) => !memberIds.has(candidate.userId));
  }, [candidates, members]);

  const updateMember = async (userId: string, accessLevel: WorkspaceAccessLevel) => {
    setActiveAction(`update:${userId}`);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...getAccessInput(accessLevel) }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.code === WORKSPACE_LAST_MANAGER_CODE ? t('errors.lastManager') : payload.error || t('errors.save'));
      }
      await loadMembers();
      setSelectedUserId('');
      setNewAccessLevel('viewer');
      await Promise.resolve(onChanged?.()).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.save'));
    } finally {
      setActiveAction(null);
    }
  };

  const removeMember = async (member: MemberAccessPerson<WorkspaceAccessLevel>) => {
    setActiveAction(`remove:${member.userId}`);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(member.userId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.code === WORKSPACE_LAST_MANAGER_CODE ? t('errors.lastManager') : payload.error || t('errors.remove'));
      }
      await loadMembers();
      await Promise.resolve(onChanged?.()).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.remove'));
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <MemberAccessEditor
      members={memberViews}
      candidates={availableCandidates}
      accessLevels={[
        { value: 'viewer', label: t('accessLevels.viewer') },
        { value: 'editor', label: t('accessLevels.editor') },
        { value: 'manager', label: t('accessLevels.manager') },
      ]}
      selectedUserId={selectedUserId}
      newAccessLevel={newAccessLevel}
      isLoading={isLoading}
      activeAction={activeAction}
      error={error}
      labels={{
        currentMembers: t('currentMembers'),
        currentMembersDescription: t('currentMembersDescription'),
        addMember: t('addMember'),
        addMemberDescription: t('addMemberDescription'),
        selectUser: t('selectUser'),
        accessLevel: t('accessLevel'),
        person: t('person'),
        actions: t('actions'),
        removeMember: t('removeMember'),
        refresh: t('refresh'),
        loading: t('loading'),
        noMembers: t('noMembers'),
        noCandidatesDescription: t('noCandidatesDescription'),
        cancel: t('cancel'),
        removeTitle: t('removeDialog.title'),
        removeDescription: (name) => t('removeDialog.description', { name }),
        removeConfirm: t('removeDialog.confirm'),
      }}
      onRefresh={() => void loadMembers()}
      onSelectedUserIdChange={setSelectedUserId}
      onNewAccessLevelChange={setNewAccessLevel}
      onUpdateMember={(userId, accessLevel) => void updateMember(userId, accessLevel)}
      onRemoveMember={(member) => void removeMember(member)}
    />
  );
}
