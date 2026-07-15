'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw, Trash2, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type GrantTargetType = 'organization' | 'role' | 'workspace' | 'project' | 'user';
type AccessLevel = 'user' | 'editor' | 'manager';

type AgentGrant = {
  id: string;
  targetType: GrantTargetType;
  targetId: string;
  canUse: boolean;
  canEdit: boolean;
  canManage: boolean;
  revision: number;
};

type AgentSummary = {
  agentId: string;
  organizationId: string | null;
  revision: number;
};

type AgentGrantsEditorProps = {
  active: boolean;
  agentId: string;
  revision: number;
  onChanged?: (agent: AgentSummary) => void | Promise<void>;
};

function accessLevel(grant: Pick<AgentGrant, 'canEdit' | 'canManage'>): AccessLevel {
  return grant.canManage ? 'manager' : grant.canEdit ? 'editor' : 'user';
}

function accessPayload(level: AccessLevel) {
  return {
    canUse: true,
    canEdit: level === 'editor' || level === 'manager',
    canManage: level === 'manager',
  };
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string };
  if (!response.ok || !payload.success) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload.data as T;
}

export function AgentGrantsEditor({ active, agentId, revision, onChanged }: AgentGrantsEditorProps) {
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [targetType, setTargetType] = useState<GrantTargetType>('user');
  const [targetId, setTargetId] = useState('');
  const [level, setLevel] = useState<AccessLevel>('user');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentRevision = agent?.revision ?? revision;
  const resolvedTargetId = targetType === 'organization' ? agent?.organizationId || '' : targetId.trim();
  const canSubmit = Boolean(resolvedTargetId) && !saving;

  const load = useCallback(async () => {
    if (!active || !agentId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ agentId });
      const data = await readResponse<{ agent: AgentSummary; grants: AgentGrant[] }>(await fetch(`/api/agents/grants?${params}`, {
        credentials: 'include',
        cache: 'no-store',
      }));
      setAgent(data.agent);
      setGrants(data.grants || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Agent grants could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [active, agentId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const targetHint = useMemo(() => {
    if (targetType === 'organization') return 'Everyone in this organization';
    if (targetType === 'role') return 'Role name, for example member or admin';
    if (targetType === 'workspace') return 'Workspace ID';
    if (targetType === 'project') return 'Project ID';
    return 'User ID';
  }, [targetType]);

  const save = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const data = await readResponse<{ agent: AgentSummary; grant: AgentGrant }>(await fetch('/api/agents/grants', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          expectedRevision: currentRevision,
          targetType,
          targetId: resolvedTargetId,
          ...accessPayload(level),
        }),
      }));
      setAgent(data.agent);
      setGrants((current) => [
        ...current.filter((entry) => !(entry.targetType === data.grant.targetType && entry.targetId === data.grant.targetId)),
        data.grant,
      ].sort((left, right) => `${left.targetType}:${left.targetId}`.localeCompare(`${right.targetType}:${right.targetId}`)));
      if (targetType !== 'organization') setTargetId('');
      await onChanged?.(data.agent);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Agent grant could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (grant: AgentGrant) => {
    const key = `${grant.targetType}:${grant.targetId}`;
    setPendingKey(key);
    setError(null);
    try {
      const data = await readResponse<{ agent: AgentSummary; removed: boolean }>(await fetch('/api/agents/grants', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          expectedRevision: currentRevision,
          targetType: grant.targetType,
          targetId: grant.targetId,
        }),
      }));
      setAgent(data.agent);
      setGrants((current) => current.filter((entry) => !(entry.targetType === grant.targetType && entry.targetId === grant.targetId)));
      await onChanged?.(data.agent);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Agent grant could not be removed.');
    } finally {
      setPendingKey(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="agent-grants-editor">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4" /> Organization access</h3>
          <p className="mt-1 text-xs text-muted-foreground">Assign this central agent to the whole organization, a role, workspace, project, or individual user.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          <span className="sr-only">Reload grants</span>
        </Button>
      </div>

      <div className="grid gap-2 rounded-md border bg-muted/15 p-3 sm:grid-cols-[10rem_minmax(0,1fr)_9rem_auto]">
        <select
          aria-label="Grant target type"
          value={targetType}
          onChange={(event) => setTargetType(event.target.value as GrantTargetType)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="user">User</option>
          <option value="role">Role</option>
          <option value="workspace">Workspace</option>
          <option value="project">Project</option>
          <option value="organization">Organization</option>
        </select>
        {targetType === 'role' ? (
          <select
            aria-label="Role"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Select role</option>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
            <option value="external">External</option>
          </select>
        ) : (
          <Input
            aria-label="Grant target ID"
            value={targetType === 'organization' ? agent?.organizationId || '' : targetId}
            onChange={(event) => setTargetId(event.target.value)}
            placeholder={targetHint}
            disabled={targetType === 'organization'}
          />
        )}
        <select
          aria-label="Grant access level"
          value={level}
          onChange={(event) => setLevel(event.target.value as AccessLevel)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="user">Use</option>
          <option value="editor">Edit</option>
          <option value="manager">Manage</option>
        </select>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!canSubmit}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!loading && grants.length === 0 ? <p className="text-sm text-muted-foreground">No cascading grants yet. The creator remains the agent manager.</p> : null}
      <div className="space-y-2">
        {grants.map((grant) => {
          const key = `${grant.targetType}:${grant.targetId}`;
          return (
            <div key={key} className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{grant.targetType}</Badge>
                  <span className="break-all font-mono text-xs">{grant.targetId}</span>
                </div>
              </div>
              <Badge variant="outline">{accessLevel(grant)}</Badge>
              <Button type="button" variant="ghost" size="sm" onClick={() => void remove(grant)} disabled={pendingKey === key}>
                {pendingKey === key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                <span className="sr-only">Remove grant</span>
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
