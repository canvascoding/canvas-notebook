'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  MemberAccessEditor,
  type MemberAccessPerson,
} from '@/app/components/settings/MemberAccessEditor';

type AgentMemberRecord = {
  agentId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  canUse: boolean;
  canEdit: boolean;
  canManage: boolean;
};

type AgentMemberCandidate = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
};

type AgentAccessLevel = 'user' | 'editor' | 'manager';

type AgentMembersEditorProps = {
  active: boolean;
  agentId: string;
  onChanged?: () => void | Promise<void>;
};

function getAccessLevel(member: Pick<AgentMemberRecord, 'canEdit' | 'canManage'>): AgentAccessLevel {
  if (member.canManage) return 'manager';
  if (member.canEdit) return 'editor';
  return 'user';
}

function getAccessInput(accessLevel: AgentAccessLevel) {
  if (accessLevel === 'manager') return { canUse: true, canEdit: true, canManage: true };
  if (accessLevel === 'editor') return { canUse: true, canEdit: true, canManage: false };
  return { canUse: true, canEdit: false, canManage: false };
}

export function AgentMembersEditor({ active, agentId, onChanged }: AgentMembersEditorProps) {
  const t = useTranslations('settings.agentPanel.members');
  const [members, setMembers] = useState<AgentMemberRecord[]>([]);
  const [candidates, setCandidates] = useState<AgentMemberCandidate[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [newAccessLevel, setNewAccessLevel] = useState<AgentAccessLevel>('user');
  const [isLoading, setIsLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/members`;

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

  const memberViews = useMemo<Array<MemberAccessPerson<AgentAccessLevel>>>(() => (
    members.map((member) => ({
      userId: member.userId,
      name: member.name,
      email: member.email,
      accessLevel: getAccessLevel(member),
    }))
  ), [members]);
  const availableCandidates = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.userId));
    return candidates.filter((candidate) => !memberIds.has(candidate.userId));
  }, [candidates, members]);

  const updateMember = async (userId: string, accessLevel: AgentAccessLevel) => {
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
        throw new Error(payload.code === 'AGENT_LAST_MANAGER' ? t('errors.lastManager') : payload.error || t('errors.save'));
      }
      await loadMembers();
      setSelectedUserId('');
      setNewAccessLevel('user');
      await Promise.resolve(onChanged?.()).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.save'));
    } finally {
      setActiveAction(null);
    }
  };

  const removeMember = async (member: MemberAccessPerson<AgentAccessLevel>) => {
    setActiveAction(`remove:${member.userId}`);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(member.userId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.code === 'AGENT_LAST_MANAGER' ? t('errors.lastManager') : payload.error || t('errors.remove'));
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
        { value: 'user', label: t('accessLevels.user') },
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
