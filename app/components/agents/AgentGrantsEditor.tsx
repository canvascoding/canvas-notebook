'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Loader2, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

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

type AgentGrantTargetCatalog = {
  users: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    role: string;
  }>;
  workspaces: Array<{
    workspaceId: string;
    name: string;
    type: string;
  }>;
  projects: Array<{
    projectId: string;
    name: string;
  }>;
};

type GrantTargetOption = {
  id: string;
  label: string;
  description: string | null;
};

type AgentGrantsEditorProps = {
  active: boolean;
  agentId: string;
  revision: number;
  onChanged?: (agent: AgentSummary) => void | Promise<void>;
};

type SearchableTargetPickerProps = {
  id: string;
  value: string;
  options: GrantTargetOption[];
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  disabled?: boolean;
  testId: string;
  onValueChange: (value: string) => void;
};

const EMPTY_TARGETS: AgentGrantTargetCatalog = {
  users: [],
  workspaces: [],
  projects: [],
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

function SearchableTargetPicker({
  id,
  value,
  options,
  label,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  disabled = false,
  testId,
  onValueChange,
}: SearchableTargetPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => options.find((option) => option.id === value) || null,
    [options, value],
  );

  return (
    <Popover open={disabled ? false : open} onOpenChange={(nextOpen) => {
      if (!disabled) setOpen(nextOpen);
    }}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={!disabled && open}
          disabled={disabled}
          data-testid={testId}
          className="h-9 w-full min-w-0 justify-between px-3 font-normal"
        >
          <span className={cn('min-w-0 truncate text-left', !selected && 'text-muted-foreground')}>
            {selected?.label || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
      >
        <Command>
          <CommandInput aria-label={searchPlaceholder} placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.description || ''} ${option.id}`}
                  data-testid={`${testId}-option-${option.id}`}
                  className="items-start py-2.5"
                  onSelect={() => {
                    onValueChange(option.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mt-0.5 h-4 w-4', value === option.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{option.description}</span>
                    ) : null}
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/80">{option.id}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function AgentGrantsEditor({ active, agentId, revision, onChanged }: AgentGrantsEditorProps) {
  const t = useTranslations('settings.agentPanel.grants');
  const workspaceTypesT = useTranslations('workspaces.types');
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [targets, setTargets] = useState<AgentGrantTargetCatalog>(EMPTY_TARGETS);
  const [targetType, setTargetType] = useState<GrantTargetType>('user');
  const [targetId, setTargetId] = useState('');
  const [level, setLevel] = useState<AccessLevel>('user');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentRevision = agent?.revision ?? revision;
  const resolvedTargetId = targetType === 'organization' ? agent?.organizationId || '' : targetId.trim();
  const canSubmit = Boolean(resolvedTargetId) && !saving && !loading;

  const roleLabel = useCallback((role: string) => {
    if (role === 'owner') return t('roles.owner');
    if (role === 'admin') return t('roles.admin');
    if (role === 'external') return t('roles.external');
    return t('roles.member');
  }, [t]);

  const targetTypeLabel = useCallback((type: GrantTargetType) => {
    if (type === 'organization') return t('targetTypes.organization');
    if (type === 'role') return t('targetTypes.role');
    if (type === 'workspace') return t('targetTypes.workspace');
    if (type === 'project') return t('targetTypes.project');
    return t('targetTypes.user');
  }, [t]);

  const accessLevelLabel = useCallback((access: AccessLevel) => {
    if (access === 'manager') return t('accessLevels.manager');
    if (access === 'editor') return t('accessLevels.editor');
    return t('accessLevels.user');
  }, [t]);

  const workspaceTypeLabel = useCallback((type: string) => {
    if (type === 'organization') return workspaceTypesT('organization');
    if (type === 'team') return workspaceTypesT('team');
    if (type === 'project') return workspaceTypesT('project');
    return workspaceTypesT('personal');
  }, [workspaceTypesT]);

  const load = useCallback(async () => {
    if (!active || !agentId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ agentId });
      const data = await readResponse<{
        agent: AgentSummary;
        grants: AgentGrant[];
        targets?: AgentGrantTargetCatalog;
      }>(await fetch(`/api/agents/grants?${params}`, {
        credentials: 'include',
        cache: 'no-store',
      }));
      setAgent(data.agent);
      setGrants(data.grants || []);
      setTargets(data.targets || EMPTY_TARGETS);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setLoading(false);
    }
  }, [active, agentId, t]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const targetOptions = useMemo<GrantTargetOption[]>(() => {
    if (targetType === 'user') {
      return targets.users.map((user) => {
        const name = user.name?.trim();
        const email = user.email?.trim();
        const label = name || email || user.userId;
        const descriptionParts = [
          email && email !== label ? email : null,
          roleLabel(user.role),
        ].filter((value): value is string => Boolean(value));
        return {
          id: user.userId,
          label,
          description: descriptionParts.join(' · ') || null,
        };
      });
    }
    if (targetType === 'workspace') {
      return targets.workspaces.map((workspace) => ({
        id: workspace.workspaceId,
        label: workspace.name,
        description: workspaceTypeLabel(workspace.type),
      }));
    }
    if (targetType === 'project') {
      return targets.projects.map((project) => ({
        id: project.projectId,
        label: project.name,
        description: t('projectDescription'),
      }));
    }
    return [];
  }, [roleLabel, t, targetType, targets.projects, targets.users, targets.workspaces, workspaceTypeLabel]);

  const optionByGrantKey = useMemo(() => {
    const entries: Array<[string, GrantTargetOption]> = [];
    for (const user of targets.users) {
      const name = user.name?.trim();
      const email = user.email?.trim();
      const label = name || email || user.userId;
      entries.push([`user:${user.userId}`, {
        id: user.userId,
        label,
        description: email && email !== label ? email : roleLabel(user.role),
      }]);
    }
    for (const workspace of targets.workspaces) {
      entries.push([`workspace:${workspace.workspaceId}`, {
        id: workspace.workspaceId,
        label: workspace.name,
        description: workspaceTypeLabel(workspace.type),
      }]);
    }
    for (const project of targets.projects) {
      entries.push([`project:${project.projectId}`, {
        id: project.projectId,
        label: project.name,
        description: t('projectDescription'),
      }]);
    }
    return new Map(entries);
  }, [roleLabel, t, targets.projects, targets.users, targets.workspaces, workspaceTypeLabel]);

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
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
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
      setError(removeError instanceof Error ? removeError.message : t('errors.remove'));
    } finally {
      setPendingKey(null);
    }
  };

  const targetControl = targetType === 'role' ? (
    <select
      id="agent-grant-target"
      aria-label={t('roleLabel')}
      value={targetId}
      onChange={(event) => setTargetId(event.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <option value="">{t('select.role')}</option>
      <option value="member">{t('roles.member')}</option>
      <option value="admin">{t('roles.admin')}</option>
      <option value="owner">{t('roles.owner')}</option>
      <option value="external">{t('roles.external')}</option>
    </select>
  ) : targetType === 'organization' ? (
    <Input
      id="agent-grant-target"
      aria-label={t('organizationLabel')}
      value={agent?.organizationId || ''}
      disabled
      title={t('organizationHint')}
      className="font-mono text-xs"
    />
  ) : (
    <SearchableTargetPicker
      id="agent-grant-target"
      value={targetId}
      options={targetOptions}
      label={targetType === 'workspace'
        ? t('pickerLabels.workspace')
        : targetType === 'project'
          ? t('pickerLabels.project')
          : t('pickerLabels.user')}
      placeholder={targetType === 'workspace'
        ? t('select.workspace')
        : targetType === 'project'
          ? t('select.project')
          : t('select.user')}
      searchPlaceholder={targetType === 'workspace'
        ? t('search.workspace')
        : targetType === 'project'
          ? t('search.project')
          : t('search.user')}
      emptyLabel={targetType === 'workspace'
        ? t('empty.workspace')
        : targetType === 'project'
          ? t('empty.project')
          : t('empty.user')}
      disabled={loading}
      testId={`grant-target-${targetType}-picker`}
      onValueChange={setTargetId}
    />
  );

  return (
    <div className="space-y-4" data-testid="agent-grants-editor">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Users className="h-4 w-4" />
            {t('title')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading || saving}
          title={t('reload')}
          aria-label={t('reload')}
        >
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      <div className="grid gap-3 rounded-lg border bg-muted/15 p-3 sm:grid-cols-2 lg:grid-cols-[10rem_minmax(0,1fr)_9rem_auto] lg:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="agent-grant-target-type">{t('targetTypeLabel')}</Label>
          <select
            id="agent-grant-target-type"
            aria-label={t('targetTypeLabel')}
            value={targetType}
            onChange={(event) => {
              setTargetType(event.target.value as GrantTargetType);
              setTargetId('');
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="user">{t('targetTypes.user')}</option>
            <option value="role">{t('targetTypes.role')}</option>
            <option value="workspace">{t('targetTypes.workspace')}</option>
            <option value="project">{t('targetTypes.project')}</option>
            <option value="organization">{t('targetTypes.organization')}</option>
          </select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="agent-grant-target">{t('targetLabel')}</Label>
          {targetControl}
          {targetType === 'organization' ? (
            <p className="text-[11px] text-muted-foreground">{t('organizationHint')}</p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="agent-grant-access-level">{t('accessLevelLabel')}</Label>
          <select
            id="agent-grant-access-level"
            aria-label={t('accessLevelLabel')}
            value={level}
            onChange={(event) => setLevel(event.target.value as AccessLevel)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="user">{t('accessLevels.user')}</option>
            <option value="editor">{t('accessLevels.editor')}</option>
            <option value="manager">{t('accessLevels.manager')}</option>
          </select>
        </div>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!canSubmit} className="h-9">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t('add')}
        </Button>
      </div>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!loading && grants.length === 0 ? <p className="text-sm text-muted-foreground">{t('noGrants')}</p> : null}
      <div className="space-y-2">
        {grants.map((grant) => {
          const key = `${grant.targetType}:${grant.targetId}`;
          const option = optionByGrantKey.get(key);
          const label = grant.targetType === 'organization'
            ? t('organizationValue')
            : grant.targetType === 'role'
              ? roleLabel(grant.targetId)
              : option?.label || grant.targetId;
          const description = option?.description || null;
          return (
            <div key={key} className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="secondary">{targetTypeLabel(grant.targetType)}</Badge>
                  <span className="min-w-0 truncate text-sm font-medium">{label}</span>
                </div>
                {description ? <p className="mt-1 truncate text-xs text-muted-foreground">{description}</p> : null}
                {label !== grant.targetId ? (
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">{grant.targetId}</p>
                ) : null}
              </div>
              <Badge variant="outline">{accessLevelLabel(accessLevel(grant))}</Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void remove(grant)}
                disabled={pendingKey === key}
                title={t('remove')}
                aria-label={t('remove')}
              >
                {pendingKey === key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
