'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type ComposioEffectiveProfile = {
  id: string;
  name: string;
  source: 'default' | 'workspace_override';
  workspaceId: string;
  isDefault: boolean;
};

type ComposioProfile = {
  id: string;
  name: string;
  isDefault: boolean;
  status: 'active' | 'archived';
  workspaceOverrideCount: number;
  automationCount: number;
  connectedApps: Array<{ slug: string; name: string }>;
};

type TriggerChange = {
  jobId: string;
  jobName: string;
  toolkitSlug: string;
  status: 'unchanged' | 'migrated' | 'paused_missing_connection' | 'paused_repair_required';
  message?: string;
};

type ProfilesPayload = {
  success?: boolean;
  profiles?: ComposioProfile[];
  effectiveProfile?: ComposioEffectiveProfile;
  error?: string;
};

type ComposioProfileSwitcherProps = {
  workspaceId: string;
  workspaceName: string;
  initialEffectiveProfile?: ComposioEffectiveProfile | null;
  onProfileChanged: () => void | Promise<void>;
  onEffectiveProfileUsageChange?: (usage: { workspaceOverrideCount: number; automationCount: number }) => void;
  selectionRequest?: number;
  createRequest?: number;
};

function appPreview(profile: ComposioProfile, emptyLabel: string): string {
  if (profile.connectedApps.length === 0) return emptyLabel;
  const visible = profile.connectedApps.slice(0, 3).map((app) => app.name || app.slug);
  const remaining = profile.connectedApps.length - visible.length;
  return remaining > 0 ? `${visible.join(', ')} +${remaining}` : visible.join(', ');
}

export function ComposioProfileSwitcher({
  workspaceId,
  workspaceName,
  initialEffectiveProfile,
  onProfileChanged,
  onEffectiveProfileUsageChange,
  selectionRequest = 0,
  createRequest = 0,
}: ComposioProfileSwitcherProps) {
  const t = useTranslations('settings.connectedApps.profiles');
  const [profiles, setProfiles] = useState<ComposioProfile[]>([]);
  const [effectiveProfile, setEffectiveProfile] = useState<ComposioEffectiveProfile | null>(initialEffectiveProfile || null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [renamingProfileId, setRenamingProfileId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const requestHeaders = useCallback((json = false): HeadersInit => ({
    [WORKSPACE_ID_HEADER]: workspaceId,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }), [workspaceId]);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/composio/profiles', {
        credentials: 'include',
        cache: 'no-store',
        headers: requestHeaders(),
      });
      const payload = await response.json() as ProfilesPayload;
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || t('loadError'));
      }
      const nextProfiles = Array.isArray(payload.profiles) ? payload.profiles : [];
      const nextEffectiveProfile = payload.effectiveProfile || initialEffectiveProfile || null;
      setProfiles(nextProfiles);
      setEffectiveProfile(nextEffectiveProfile);
      const effectiveRecord = nextProfiles.find((profile) => profile.id === nextEffectiveProfile?.id);
      onEffectiveProfileUsageChange?.({
        workspaceOverrideCount: effectiveRecord?.workspaceOverrideCount || 0,
        automationCount: effectiveRecord?.automationCount || 0,
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [initialEffectiveProfile, onEffectiveProfileUsageChange, requestHeaders, t]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadProfiles();
    });
    return () => {
      cancelled = true;
    };
  }, [loadProfiles]);

  useEffect(() => {
    if (selectionRequest <= 0) return;
    queueMicrotask(() => setSelectionOpen(true));
  }, [selectionRequest]);

  useEffect(() => {
    if (createRequest <= 0) return;
    queueMicrotask(() => {
      setCreateOpen(true);
      setSelectionOpen(true);
    });
  }, [createRequest]);

  const summarizeTriggerChanges = useCallback((changes: TriggerChange[]) => {
    const migrated = changes.filter((change) => change.status === 'migrated').length;
    const paused = changes.filter((change) => change.status.startsWith('paused_')).length;
    if (paused > 0) return t('changePaused', { paused, migrated });
    if (migrated > 0) return t('changeMigrated', { count: migrated });
    return t('changeSaved');
  }, [t]);

  const applyProfile = useCallback(async (profile: ComposioProfile) => {
    setActionId(profile.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/composio/workspace-profile', {
        method: profile.isDefault ? 'DELETE' : 'PUT',
        credentials: 'include',
        headers: requestHeaders(!profile.isDefault),
        body: profile.isDefault ? undefined : JSON.stringify({ workspaceId, profileId: profile.id }),
      });
      const payload = await response.json() as {
        success?: boolean;
        effectiveProfile?: ComposioEffectiveProfile;
        triggerChanges?: TriggerChange[];
        error?: string;
      };
      if (!response.ok || payload.success === false || !payload.effectiveProfile) {
        throw new Error(payload.error || t('changeError'));
      }
      setEffectiveProfile(payload.effectiveProfile);
      setSelectionOpen(false);
      setNotice(summarizeTriggerChanges(payload.triggerChanges || []));
      await loadProfiles();
      await onProfileChanged();
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : t('changeError'));
    } finally {
      setActionId(null);
    }
  }, [loadProfiles, onProfileChanged, requestHeaders, summarizeTriggerChanges, t, workspaceId]);

  const createProfile = useCallback(async () => {
    const name = newProfileName.trim();
    if (!name) return;
    setActionId('create');
    setError(null);
    try {
      const response = await fetch('/api/composio/profiles', {
        method: 'POST',
        credentials: 'include',
        headers: requestHeaders(true),
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as { success?: boolean; profile?: ComposioProfile; error?: string };
      if (!response.ok || payload.success === false || !payload.profile) {
        throw new Error(payload.error || t('createError'));
      }
      setNewProfileName('');
      setCreateOpen(false);
      await loadProfiles();
      await applyProfile({ ...payload.profile, connectedApps: payload.profile.connectedApps || [] });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('createError'));
    } finally {
      setActionId(null);
    }
  }, [applyProfile, loadProfiles, newProfileName, requestHeaders, t]);

  const renameProfile = useCallback(async (profileId: string) => {
    const name = renameDraft.trim();
    if (!name) return;
    setActionId(`rename:${profileId}`);
    setError(null);
    try {
      const response = await fetch(`/api/composio/profiles/${encodeURIComponent(profileId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: requestHeaders(true),
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || payload.success === false) throw new Error(payload.error || t('renameError'));
      setRenamingProfileId(null);
      setRenameDraft('');
      await loadProfiles();
      await onProfileChanged();
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : t('renameError'));
    } finally {
      setActionId(null);
    }
  }, [loadProfiles, onProfileChanged, renameDraft, requestHeaders, t]);

  const archiveProfile = useCallback(async (profile: ComposioProfile) => {
    if (!window.confirm(t('archiveConfirm', { name: profile.name }))) return;
    setActionId(`archive:${profile.id}`);
    setError(null);
    try {
      const response = await fetch(`/api/composio/profiles/${encodeURIComponent(profile.id)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: requestHeaders(),
      });
      const payload = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || payload.success === false) throw new Error(payload.error || t('archiveError'));
      await loadProfiles();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : t('archiveError'));
    } finally {
      setActionId(null);
    }
  }, [loadProfiles, requestHeaders, t]);

  if (loading && !effectiveProfile) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  return (
    <>
      <section
        className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-sm"
        data-testid="composio-profile-context"
      >
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary" />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-background text-primary shadow-sm">
              <Layers3 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t('eyebrow', { workspace: workspaceName })}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h3 className="truncate text-base font-semibold">
                  {effectiveProfile?.name || t('unknownProfile')}
                </h3>
                <Badge variant={effectiveProfile?.source === 'workspace_override' ? 'default' : 'outline'}>
                  {effectiveProfile?.source === 'workspace_override' ? t('workspaceOnly') : t('usesDefault')}
                </Badge>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
                {t('privateExplanation')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
            {effectiveProfile?.source === 'workspace_override' && profiles.some((profile) => profile.isDefault) ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const profile = profiles.find((candidate) => candidate.isDefault);
                  if (profile) void applyProfile(profile);
                }}
                disabled={Boolean(actionId)}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                {t('restoreDefault')}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setManagementOpen(true)}>
              {t('manage')}
            </Button>
            <Button size="sm" onClick={() => setSelectionOpen(true)} data-testid="composio-change-profile">
              {t('change')}
            </Button>
          </div>
        </div>
        {notice ? (
          <p className="mt-3 border-l-2 border-primary/40 pl-3 text-xs leading-5 text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      </section>

      <Dialog open={selectionOpen} onOpenChange={setSelectionOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('selectionTitle', { workspace: workspaceName })}</DialogTitle>
            <DialogDescription>{t('selectionDescription')}</DialogDescription>
          </DialogHeader>
          <Alert className="rounded-lg bg-muted/25">
            <AlertTriangle />
            <AlertTitle>{t('noCopyTitle')}</AlertTitle>
            <AlertDescription>{t('noCopyDescription')}</AlertDescription>
          </Alert>
          <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1" data-testid="composio-profile-list">
            {profiles.map((profile) => {
              const selected = profile.id === effectiveProfile?.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={`group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    selected ? 'border-primary bg-primary/5' : 'hover:border-foreground/25 hover:bg-muted/30'
                  }`}
                  onClick={() => void applyProfile(profile)}
                  disabled={Boolean(actionId)}
                  data-testid={`composio-profile-option-${profile.id}`}
                >
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/35'
                  }`}>
                    {selected ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{profile.name}</span>
                      {profile.isDefault ? <Badge variant="outline">{t('defaultBadge')}</Badge> : null}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {appPreview(profile, t('noApps'))}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t('workspaceUsage', { count: profile.workspaceOverrideCount })}
                      {' · '}
                      {t('automationUsage', { count: profile.automationCount })}
                    </span>
                  </span>
                  {actionId === profile.id ? <Loader2 className="mt-1 h-4 w-4 animate-spin" /> : null}
                </button>
              );
            })}
          </div>
          {createOpen ? (
            <div className="rounded-lg border bg-muted/20 p-3">
              <Label htmlFor="composio-profile-name">{t('newName')}</Label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input
                  id="composio-profile-name"
                  value={newProfileName}
                  onChange={(event) => setNewProfileName(event.target.value)}
                  placeholder={t('newPlaceholder')}
                  maxLength={80}
                  autoFocus
                />
                <Button onClick={() => void createProfile()} disabled={!newProfileName.trim() || actionId === 'create'}>
                  {actionId === 'create' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
                  {t('createAndUse')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" className="justify-start" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('create')}
            </Button>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={managementOpen} onOpenChange={setManagementOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('managementTitle')}</DialogTitle>
            <DialogDescription>{t('managementDescription')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {profiles.map((profile) => (
              <div key={profile.id} className="rounded-lg border p-3">
                {renamingProfileId === profile.id ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      maxLength={80}
                      autoFocus
                    />
                    <Button size="sm" onClick={() => void renameProfile(profile.id)} disabled={!renameDraft.trim()}>
                      {actionId === `rename:${profile.id}` ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      {t('saveName')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenamingProfileId(null)}>{t('cancel')}</Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium">{profile.name}</p>
                        {profile.isDefault ? <Badge variant="outline">{t('defaultBadge')}</Badge> : null}
                        {profile.id === effectiveProfile?.id ? <Badge>{t('activeHere')}</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {appPreview(profile, t('noApps'))} · {t('workspaceUsage', { count: profile.workspaceOverrideCount })} · {t('automationUsage', { count: profile.automationCount })}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setRenamingProfileId(profile.id);
                          setRenameDraft(profile.name);
                        }}
                      >
                        <Pencil className="mr-1.5 h-3.5 w-3.5" />
                        {t('rename')}
                      </Button>
                      {!profile.isDefault ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => void archiveProfile(profile)}
                          disabled={profile.workspaceOverrideCount > 0 || profile.automationCount > 0 || Boolean(actionId)}
                          title={profile.workspaceOverrideCount > 0 || profile.automationCount > 0 ? t('archiveInUse') : undefined}
                        >
                          {actionId === `archive:${profile.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                          {t('archive')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManagementOpen(false)}>{t('close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
