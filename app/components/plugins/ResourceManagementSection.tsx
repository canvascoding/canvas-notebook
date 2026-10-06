'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type {
  CapabilityResourceConfiguration, CapabilityResourceDescriptor, CapabilityResourceGrantInput,
  CapabilityResourceMetadataPatch, CapabilityResourceMutation,
} from '@/app/lib/capabilities/resources/contracts';
import type { CapabilityPolicyTargetType } from '@/app/lib/capabilities/types';
import type { OrganizationPolicyTargetCatalog } from '@/app/lib/organization/policy-targets';
import { SearchablePolicyTargetPicker, type PolicyTargetOption } from '@/app/components/organization/SearchablePolicyTargetPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { InlineNotice } from '@/components/ui/inline-notice';

type ResourceResponse = { success: boolean; data?: { resource: CapabilityResourceDescriptor }; code?: string };
const EMPTY_ORGANIZATION_POLICY_TARGETS: OrganizationPolicyTargetCatalog = { users: [], workspaces: [], projects: [] };
const grantInputs = (resource: CapabilityResourceDescriptor): CapabilityResourceGrantInput[] => (resource.grants || []).map(grant => ({
  targetType: grant.targetType, targetId: grant.targetId, canUse: grant.canUse, canEdit: grant.canEdit, canManage: grant.canManage,
}));

export function ResourceManagementSection({ resourceRef, workspaceId, onUpdated }: {
  resourceRef: string; workspaceId?: string | null; onUpdated?: () => void;
}) {
  const t = useTranslations('skills.resourceManagement');
  const [resource, setResource] = useState<CapabilityResourceDescriptor | null>(null);
  const [targets, setTargets] = useState<OrganizationPolicyTargetCatalog>(EMPTY_ORGANIZATION_POLICY_TARGETS);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetsUnavailable, setTargetsUnavailable] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [responsible, setResponsible] = useState('');
  const [grants, setGrants] = useState<CapabilityResourceGrantInput[]>([]);
  const [accessMode, setAccessMode] = useState<'inherit' | 'restricted'>('inherit');
  const [ownerType, setOwnerType] = useState<'user' | 'organization' | 'team'>('user');
  const [teamId, setTeamId] = useState('');
  const [targetType, setTargetType] = useState<CapabilityPolicyTargetType>('user');
  const [targetId, setTargetId] = useState('');
  const [newRights, setNewRights] = useState({ canUse: false, canEdit: false, canManage: false });
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestRevision = useRef(0);
  const writeRevision = useRef(0);
  const path = useCallback((suffix = '') => {
    const query = workspaceId ? `?${new URLSearchParams({ workspaceId })}` : '';
    return `/api/capabilities/resources/${encodeURIComponent(resourceRef)}${suffix}${query}`;
  }, [resourceRef, workspaceId]);

  const apply = useCallback((value: CapabilityResourceDescriptor, retainDraft = false) => {
    setResource(value);
    if (retainDraft) return;
    setDisplayName(value.metadata.displayName || '');
    setDescription(value.metadata.description || '');
    setResponsible(value.metadata.responsibleUserId || '');
    setGrants(grantInputs(value));
    setAccessMode(value.metadata.accessMode);
    setOwnerType(value.metadata.ownership.type === 'system' ? 'user' : value.metadata.ownership.type);
    setTeamId(value.metadata.ownership.type === 'team' ? value.metadata.ownership.workspaceId : '');
  }, []);

  const load = useCallback(async (retainDraft = false) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const revision = ++requestRevision.current;
    setLoading(true);
    setTargetsUnavailable(false);
    setTargets(EMPTY_ORGANIZATION_POLICY_TARGETS);
    try {
      const response = await fetch(path(), { cache: 'no-store', signal: request.signal });
      const payload = await response.json() as ResourceResponse;
      if (!response.ok || !payload.success || !payload.data?.resource) throw new Error('resource_read_failed');
      if (revision !== requestRevision.current || request.signal.aborted) return;
      const value = payload.data.resource;
      apply(value, retainDraft);
      if (value.access.canManage && value.metadata.ownership.type !== 'system') {
        const targetResponse = await fetch(path('/targets'), { cache: 'no-store', signal: request.signal });
        const targetPayload = await targetResponse.json() as { success: boolean; data?: { targets: OrganizationPolicyTargetCatalog } };
        if (revision !== requestRevision.current || request.signal.aborted) return;
        if (!targetResponse.ok || !targetPayload.success || !targetPayload.data?.targets) setTargetsUnavailable(true);
        else setTargets(targetPayload.data.targets);
      }
    } catch {
      if (revision === requestRevision.current && !request.signal.aborted) {
        setResource(null);
        setError(t('loadError'));
      }
    } finally {
      if (revision === requestRevision.current && !request.signal.aborted) setLoading(false);
    }
  }, [apply, path, t]);

  useEffect(() => {
    startTransition(() => { setError(null); setConflict(false); setResource(null); setPending(false); void load(); });
    return () => { controller.current?.abort(); requestRevision.current += 1; writeRevision.current += 1; };
  }, [load]);

  const userOptions: PolicyTargetOption[] = targets.users.map(user => ({ id: user.userId,
    label: user.name || user.email || t('unknownPerson'), description: user.name && user.email ? user.email : null }));
  const teamOptions: PolicyTargetOption[] = targets.workspaces.filter(workspace => workspace.type === 'team')
    .map(workspace => ({ id: workspace.workspaceId, label: workspace.name, description: t('scopes.team') }));
  const options: PolicyTargetOption[] = targetType === 'user' ? userOptions
    : targetType === 'workspace' ? targets.workspaces.map(workspace => ({ id: workspace.workspaceId, label: workspace.name, description: t('targets.workspace') }))
      : targetType === 'project' ? targets.projects.map(project => ({ id: project.projectId, label: project.name, description: t('targets.project') }))
        : targetType === 'role' ? ['owner', 'admin', 'member', 'external'].map(role => ({ id: role, label: t(`roles.${role}`), description: null }))
          : resource && resource.metadata.ownership.type !== 'system' && resource.metadata.ownership.organizationId
            ? [{ id: resource.metadata.ownership.organizationId, label: t('scopes.organization'), description: null }] : [];
  const person = (id: string | null) => id ? userOptions.find(option => option.id === id)?.label
    || Object.values(resource?.people || {}).find(value => value?.userId === id)?.name || t('unknownPerson') : t('none');
  const targetLabel = (grant: CapabilityResourceGrantInput) => grant.targetType === 'user' ? person(grant.targetId)
    : grant.targetType === 'role' ? t(`roles.${grant.targetId}`)
      : grant.targetType === 'workspace' ? targets.workspaces.find(workspace => workspace.workspaceId === grant.targetId)?.name || t('unknownTarget')
        : grant.targetType === 'project' ? targets.projects.find(project => project.projectId === grant.targetId)?.name || t('unknownTarget') : t('scopes.organization');

  async function save() {
    if (!resource || pending || conflict) return;
    const write = ++writeRevision.current;
    setPending(true); setError(null);
    try {
      const metadata: CapabilityResourceMetadataPatch = {};
      if (resource.access.canEdit) {
        metadata.displayName = displayName.trim() || null;
        metadata.description = description.trim() || null;
      }
      if (resource.access.canManage && !targetsUnavailable && responsible !== (resource.metadata.responsibleUserId || '')) metadata.responsibleUserId = responsible || null;
      const input: CapabilityResourceMutation = {
        expectedMetadataRevision: resource.metadata.metadataRevision,
        expectedGrantsRevision: resource.metadata.grantsRevision,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      };
      if (resource.access.canManage && !targetsUnavailable) {
        if (JSON.stringify(grants) !== JSON.stringify(grantInputs(resource))) input.grants = grants;
        if (accessMode !== resource.metadata.accessMode) input.accessMode = accessMode;
      }
      const unmanaged = resource.metadata.metadataRevision === 0;
      const configuration: CapabilityResourceConfiguration = { ...input,
        ownership: ownerType === 'team' ? { type: 'team', workspaceId: teamId } : { type: ownerType } };
      const response = await fetch(path(), { method: unmanaged ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unmanaged ? configuration : input) });
      const payload = await response.json() as ResourceResponse;
      if (write !== writeRevision.current) return;
      if (response.status === 409) {
        setConflict(true); setError(t('conflict'));
        await load(true);
        return;
      }
      if (!response.ok || !payload.success || !payload.data?.resource) throw new Error('resource_write_failed');
      apply(payload.data.resource);
      await load();
      if (write === writeRevision.current) onUpdated?.();
    } catch { if (write === writeRevision.current) setError(t('saveError')); }
    finally { if (write === writeRevision.current) setPending(false); }
  }

  function addGrant() {
    if (!targetId || !options.some(option => option.id === targetId)) return;
    if (grants.some(grant => grant.targetType === targetType && grant.targetId === targetId)) return;
    setGrants(current => [...current, { targetType, targetId, ...newRights }]);
    setTargetId(''); setNewRights({ canUse: false, canEdit: false, canManage: false });
  }

  if (loading && !resource) return <section data-testid="resource-management" className="rounded-lg border p-4 text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />{t('loading')}</section>;
  if (!resource) return <section data-testid="resource-management" className="space-y-2 rounded-lg border p-4"><InlineNotice size="compact">{error || t('loadError')}</InlineNotice><Button variant="outline" size="sm" onClick={() => { setError(null); void load(); }}>{t('reload')}</Button></section>;
  const { metadata, access, artifact } = resource;
  const ownership = metadata.ownership;
  const unmanaged = metadata.metadataRevision === 0;
  const disabled = pending || loading || conflict;
  const canSave = unmanaged ? access.canManage && artifact.scopeType !== 'system' : access.canEdit || access.canManage;
  const scopeLabel = ownership.type === 'team'
    ? `${t('scopes.team')} · ${resource.ownershipLabel || targets.workspaces.find(workspace => workspace.workspaceId === ownership.workspaceId)?.name || t('unknownTarget')}`
    : ownership.type === 'user' ? `${t('scopes.user')} · ${resource.ownershipLabel || person(ownership.ownerUserId)}` : t(`scopes.${ownership.type}`);

  return <section ref={setPortalContainer} data-testid="resource-management" className="space-y-3 rounded-lg border bg-muted/10 p-4">
    <h3 className="text-sm font-semibold">{t('title')}</h3>
    <dl className="grid gap-3 text-sm sm:grid-cols-3">
      <div><dt className="text-xs text-muted-foreground">{t('owner')}</dt><dd className="mt-1">{scopeLabel}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('lastEditor')}</dt><dd className="mt-1">{person(metadata.updatedByUserId)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t('responsible')}</dt><dd className="mt-1">{person(metadata.responsibleUserId)}</dd></div>
    </dl>
    <p className="text-xs text-muted-foreground">{t('rightsHint')}</p>
    {error ? <InlineNotice variant="destructive" size="compact">{error}</InlineNotice> : null}
    {targetsUnavailable ? <InlineNotice size="compact">{t('targetsError')}</InlineNotice> : null}
    {conflict ? <Button size="sm" variant="outline" onClick={() => { setConflict(false); setError(null); void load(); }}><RefreshCw className="mr-2 size-4" />{t('reload')}</Button> : null}
    {canSave ? <details className="group space-y-3">
      <summary className="cursor-pointer text-sm font-medium">{t('edit')}</summary>
      <div className="space-y-4 pt-2">
        {unmanaged && access.canManage ? <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('configureHint')}</p>
          <Label htmlFor={`resource-owner-${artifact.name}`}>{t('owner')}</Label>
          {artifact.scopeType === 'organization' ? <>
            <select id={`resource-owner-${artifact.name}`} data-testid="resource-owner-scope" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={ownerType} disabled={disabled || targetsUnavailable}
              onChange={event => { setOwnerType(event.target.value as 'organization' | 'team'); setTeamId(''); }}>
              <option value="organization">{t('scopes.organization')}</option><option value="team">{t('scopes.team')}</option>
            </select>
            {ownerType === 'team' ? <SearchablePolicyTargetPicker id={`resource-team-${artifact.name}`} value={teamId} options={teamOptions}
              portalContainer={portalContainer}
              label={t('team')} placeholder={t('selectTarget')} searchPlaceholder={t('searchTargets')} emptyLabel={t('noTargets')}
              disabled={disabled || targetsUnavailable} testId="resource-owner-team" onValueChange={setTeamId} /> : null}
          </> : <p className="text-sm">{t('scopes.user')}</p>}
        </div> : null}
        <div className="space-y-2"><Label htmlFor={`resource-name-${artifact.name}`}>{t('displayName')}</Label>
          <Input id={`resource-name-${artifact.name}`} data-testid="resource-display-name" value={displayName} maxLength={200} placeholder={artifact.name} disabled={disabled || !access.canEdit} onChange={event => setDisplayName(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor={`resource-description-${artifact.name}`}>{t('description')}</Label>
          <Textarea id={`resource-description-${artifact.name}`} data-testid="resource-description" value={description} maxLength={4096} disabled={disabled || !access.canEdit} onChange={event => setDescription(event.target.value)} /></div>
        {access.canManage ? <>
          <div className="space-y-2"><Label>{t('responsible')}</Label><div className="flex min-w-0 gap-2">
            <div className="min-w-0 flex-1">
              <SearchablePolicyTargetPicker id={`resource-responsible-${artifact.name}`} value={responsible} options={userOptions} label={t('responsible')}
                portalContainer={portalContainer}
                placeholder={t('none')} searchPlaceholder={t('searchTargets')} emptyLabel={t('noTargets')} disabled={disabled || targetsUnavailable} testId="resource-responsible-picker" onValueChange={setResponsible} />
            </div>
            <Button variant="outline" size="sm" disabled={disabled || targetsUnavailable || !responsible} onClick={() => setResponsible('')}>{t('clear')}</Button>
          </div></div>
          <div className="space-y-2"><Label htmlFor={`resource-access-${artifact.name}`}>{t('audience')}</Label>
            <select id={`resource-access-${artifact.name}`} data-testid="resource-access-mode" value={accessMode} disabled={disabled || targetsUnavailable} onChange={event => setAccessMode(event.target.value as 'inherit' | 'restricted')} className="h-9 w-full rounded-md border bg-background px-3 text-sm">
              <option value="inherit">{t('inherit')}</option><option value="restricted">{t('restricted')}</option>
            </select><p className="text-xs text-muted-foreground">{t('accessHint')}</p></div>
          <div className="space-y-3" data-testid="resource-grants">
            <h4 className="text-sm font-medium">{t('grants')}</h4>
            {grants.map((grant, index) => <div key={`${grant.targetType}:${grant.targetId}`} className="flex flex-wrap items-center gap-3 rounded-md border p-3" data-testid="resource-grant">
              <span className="min-w-0 flex-1 text-sm">{targetLabel(grant)}</span>
              {(['canUse', 'canEdit', 'canManage'] as const).map(right => <label key={right} className="flex items-center gap-2 text-xs">
                <input type="checkbox" className="size-4 accent-primary" checked={grant[right]} disabled={disabled || targetsUnavailable} aria-label={`${t(`rights.${right}`)}: ${targetLabel(grant)}`}
                  onChange={event => setGrants(current => current.map((item, position) => position === index ? { ...item, [right]: event.target.checked } : item))} />{t(`rights.${right}`)}
              </label>)}
              <Button variant="ghost" size="icon" disabled={disabled || targetsUnavailable} aria-label={t('removeGrant', { name: targetLabel(grant) })} onClick={() => setGrants(current => current.filter((_, position) => position !== index))}><Trash2 className="size-4" /></Button>
            </div>)}
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <select data-testid="resource-grant-type" aria-label={t('targetType')} className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={targetType} disabled={disabled || targetsUnavailable}
                onChange={event => { setTargetType(event.target.value as CapabilityPolicyTargetType); setTargetId(''); }}>
                {(['user', 'workspace', 'role', 'organization', 'project'] as const).map(type => <option key={type} value={type}>{t(`targets.${type}`)}</option>)}
              </select>
              <SearchablePolicyTargetPicker id={`resource-grant-target-${artifact.name}`} value={targetId} options={options} label={t('target')}
                portalContainer={portalContainer}
                placeholder={t('selectTarget')} searchPlaceholder={t('searchTargets')} emptyLabel={t('noTargets')} disabled={disabled || targetsUnavailable}
                testId="resource-grant-target" onValueChange={setTargetId} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {(['canUse', 'canEdit', 'canManage'] as const).map(right => <label key={right} className="flex items-center gap-2 text-xs">
                <input type="checkbox" className="size-4 accent-primary" checked={newRights[right]} disabled={disabled || targetsUnavailable} aria-label={t(`rights.${right}`)} data-testid={`resource-new-${right}`}
                  onChange={event => setNewRights(current => ({ ...current, [right]: event.target.checked }))} />{t(`rights.${right}`)}
              </label>)}
              <Button variant="outline" size="sm" disabled={disabled || targetsUnavailable || !targetId || grants.length >= 100} onClick={addGrant}><Plus className="mr-2 size-4" />{t('addGrant')}</Button>
            </div>
          </div>
        </> : null}
        <Button data-testid="resource-save" disabled={disabled || (unmanaged && ownerType === 'team' && !teamId)} onClick={() => void save()}>
          {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}{unmanaged ? t('configure') : t('save')}
        </Button>
      </div>
    </details> : <p className="text-xs text-muted-foreground">{t('readOnly')}</p>}
  </section>;
}
