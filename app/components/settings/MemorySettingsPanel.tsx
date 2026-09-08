'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowRightLeft, BookOpenText, BrainCircuit, Check, ChevronRight, Download, Loader2, Pencil, Plus, RotateCcw, Save, Send, Sparkles, Trash2, Upload } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { MemoryMarkdownContent } from '@/app/components/settings/MemoryMarkdownContent';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { memoryCategoryDescription, memoryCategoryLabel, type MemoryDisplayLocale } from '@/app/lib/memory/categories';
import { DEFAULT_MANUAL_MEMORY_PRIORITY, memoryPriorityBand } from '@/app/lib/memory/contract';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

type MemoryScope = 'user' | 'agent' | 'workspace' | 'organization';
type MemoryEntryView = 'published' | 'pending' | 'archived';

type Entry = {
  id: string;
  content: string;
  status: 'pending' | 'published' | 'archived';
  priority: number;
  pinned: boolean;
  collectionId: string;
  updatedAt: number;
  lastUsedAt?: number | null;
};

type MemoryEvent = { id: string; action: string; actorType: string; decisionCode: string | null; createdAt: number };

type Collection = {
  id: string;
  category: string;
  title: string;
  summary: string | null;
  status: 'active' | 'archived';
  updatedAt: number;
  entryCount: number;
  publishedCount: number;
  pendingCount: number;
  archivedCount: number;
  totalCount: number;
};

type MemorySettings = {
  automaticMemoryEnabled: boolean;
  automaticMemoryOperational: boolean;
  memoryReviewWorkerAvailable: boolean;
  memoryReviewWorkerReason: 'available' | 'production_build' | 'environment_disabled';
  providerInstallationId: string | null;
  modelId: string | null;
  runtimeConfigured: boolean;
  canManageMemoryRuntime: boolean;
  catalogRevision: number | null;
  memoryPromptMaxTokens: number;
  sensitiveMemoryEnabled: boolean;
  review: {
    status: string;
    count: number;
    counts: { running: number; scheduled: number; retrying: number; awaitingConfiguration: number; completed: number };
    lastCompletedAt: number | null;
    nextScheduledAt: number | null;
    lastErrorCode: string | null;
    lastErrorAt: number | null;
  };
  providers: Array<{ installationId: string; name: string; providerId: string; models: Array<{ id: string; name: string }> }>;
};

type AgentMemoryOwner = {
  agentId: string;
  name: string;
  iconId: string;
  scopeType: 'user' | 'organization' | 'system' | 'deleted';
  status: 'active' | 'deleted';
  collectionCount: number;
  archivedCollectionCount: number;
  entryCount: number;
  updatedAt: number;
};

type MemoryPermissions = {
  canReadPublished: boolean;
  canSuggest: boolean;
  canPublish: boolean;
  canUpdatePublished: boolean;
  canArchive: boolean;
};

type MemoryResponse<T> = { success?: boolean; data?: T; error?: string };
type MemoryMutationResponse = { entry?: Entry; changed: boolean };

const MEMORY_SCOPES: MemoryScope[] = ['user', 'agent', 'workspace', 'organization'];

function scopeFromParam(value: string | null): MemoryScope {
  return value === 'agent' || value === 'workspace' || value === 'organization' ? value : 'user';
}

function entryViewFromParam(value: string | null): MemoryEntryView {
  return value === 'pending' || value === 'archived' ? value : 'published';
}

function formatDate(value: number, locale: MemoryDisplayLocale): string {
  return value
    ? new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-US', { dateStyle: 'medium' }).format(new Date(value))
    : locale === 'de' ? 'Noch nicht aktualisiert' : 'Not yet updated';
}

async function readJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'include', cache: 'no-store', ...init });
  const payload = await response.json().catch(() => null) as MemoryResponse<T> | null;
  if (!response.ok || payload?.success !== true || !payload.data) throw new Error(payload?.error || 'Request failed.');
  return payload.data;
}

function queryForScope(
  scope: MemoryScope,
  agentId: string | null,
  workspaceId: string | null,
  collectionId?: string | null,
  status?: MemoryEntryView,
) {
  const query = new URLSearchParams({ scope });
  if (scope === 'agent' && agentId) query.set('agentId', agentId);
  if (scope === 'workspace' && workspaceId) query.set('workspaceId', workspaceId);
  if (collectionId) query.set('collectionId', collectionId);
  if (status) query.set('status', status);
  return query;
}

export function MemorySettingsPanel() {
  const searchParams = useSearchParams();
  const locationQuery = searchParams.toString();
  const t = useTranslations('settings.memoryPanel');
  const locale: MemoryDisplayLocale = useLocale() === 'en' ? 'en' : 'de';
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspacesLoading = useWorkspaceStore((state) => state.isLoading);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => searchParams.get('workspaceId') || activeWorkspace?.id || null);
  const [agentId, setAgentId] = useState<string | null>(() => searchParams.get('agentId'));
  const [scope, setScope] = useState<MemoryScope>(() => scopeFromParam(searchParams.get('scope')));
  const [agentOwners, setAgentOwners] = useState<AgentMemoryOwner[]>([]);
  const [ownersLoading, setOwnersLoading] = useState(true);
  const [transferTargetAgentId, setTransferTargetAgentId] = useState('');
  const [ownerOperation, setOwnerOperation] = useState<string | null>(null);
  const [agentDeletionDialogOpen, setAgentDeletionDialogOpen] = useState(false);
  const initialCollectionIdRef = useRef(searchParams.get('collectionId'));
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [exportingCollectionId, setExportingCollectionId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<MemoryPermissions | null>(null);
  const [entryView, setEntryView] = useState<MemoryEntryView>(() => entryViewFromParam(searchParams.get('status')));
  const [entryQuery, setEntryQuery] = useState('');
  const [entrySort, setEntrySort] = useState<'priority' | 'updated' | 'lastUsed'>('priority');
  const [historyForEntryId, setHistoryForEntryId] = useState<string | null>(null);
  const [entryHistory, setEntryHistory] = useState<MemoryEvent[]>([]);
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(() => searchParams.get('entryId'));
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [runtimeDraftChanged, setRuntimeDraftChanged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggleSaving, setToggleSaving] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftPriority, setDraftPriority] = useState(DEFAULT_MANUAL_MEMORY_PRIORITY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editingPriority, setEditingPriority] = useState(DEFAULT_MANUAL_MEMORY_PRIORITY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importEntries, setImportEntries] = useState<string[] | null>(null);
  const [deletionDialogOpen, setDeletionDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const lastLocationQueryRef = useRef(locationQuery);
  const collectionLoadVersionRef = useRef(0);
  const entryLoadVersionRef = useRef(0);

  const selectedProvider = useMemo(
    () => settings?.providers.find((provider) => provider.installationId === settings.providerInstallationId) ?? null,
    [settings],
  );
  const selectedAgentOwner = useMemo(() => agentOwners.find((owner) => owner.agentId === agentId) ?? null, [agentId, agentOwners]);
  const accessibleWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.status === 'active' && workspace.permissions.canRead),
    [workspaces],
  );
  const selectedWorkspace = useMemo(
    () => accessibleWorkspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    [accessibleWorkspaces, workspaceId],
  );
  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId],
  );
  const activeTransferTargets = useMemo(() => agentOwners.filter((owner) => owner.status === 'active' && owner.agentId !== agentId), [agentId, agentOwners]);
  const agentMemoryReadOnly = scope === 'agent' && selectedAgentOwner?.status === 'deleted';
  const canUseScope = scope === 'agent'
    ? Boolean(agentId && selectedAgentOwner)
    : scope !== 'workspace' || Boolean(workspaceId && selectedWorkspace);
  const reviewerActive = Boolean(settings?.automaticMemoryEnabled && settings.memoryReviewWorkerAvailable);
  const query = useMemo(() => queryForScope(scope, agentId, workspaceId), [agentId, scope, workspaceId]);
  const visibleEntries = useMemo(() => {
    const normalizedQuery = entryQuery.trim().toLocaleLowerCase();
    const matching = normalizedQuery ? entries.filter((entry) => entry.content.toLocaleLowerCase().includes(normalizedQuery)) : entries;
    const metric = (entry: Entry) => entrySort === 'priority'
      ? entry.priority
      : entrySort === 'updated'
        ? entry.updatedAt
        : entry.lastUsedAt ?? 0;
    return [...matching].sort((left, right) => Number(right.pinned) - Number(left.pinned) || metric(right) - metric(left) || left.id.localeCompare(right.id));
  }, [entries, entryQuery, entrySort]);

  const loadSettings = useCallback(async () => {
    const data = await readJson<MemorySettings>('/api/memory?settings=1');
    setSettings(data);
    setRuntimeDraftChanged(false);
  }, []);

  const selectAgentOwner = useCallback((nextAgentId: string) => {
    collectionLoadVersionRef.current += 1;
    entryLoadVersionRef.current += 1;
    setAgentId(nextAgentId);
    setSelectedCollectionId(null);
    setEntries([]);
    setHighlightedEntryId(null);
    setEntryView('published');
    setTransferTargetAgentId('');
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'memory');
    url.searchParams.set('scope', 'agent');
    url.searchParams.set('agentId', nextAgentId);
    url.searchParams.set('status', 'published');
    url.searchParams.delete('collectionId');
    url.searchParams.delete('entryId');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const selectWorkspace = useCallback((nextWorkspaceId: string) => {
    collectionLoadVersionRef.current += 1;
    entryLoadVersionRef.current += 1;
    setWorkspaceId(nextWorkspaceId);
    setSelectedCollectionId(null);
    setEntries([]);
    setEntryView('published');
    setEntryQuery('');
    setHistoryForEntryId(null);
    setEntryHistory([]);
    setEditingId(null);
    setHighlightedEntryId(null);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'memory');
    url.searchParams.set('scope', 'workspace');
    url.searchParams.set('workspaceId', nextWorkspaceId);
    url.searchParams.delete('collectionId');
    url.searchParams.delete('entryId');
    url.searchParams.set('status', 'published');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  useEffect(() => {
    const previousQuery = lastLocationQueryRef.current;
    if (previousQuery === locationQuery) return;
    lastLocationQueryRef.current = locationQuery;
    const previousParams = new URLSearchParams(previousQuery);
    const params = new URLSearchParams(locationQuery);
    const nextScope = scopeFromParam(params.get('scope'));
    const nextWorkspaceId = params.get('workspaceId');
    const nextAgentId = params.get('agentId');
    const nextCollectionId = params.get('collectionId');
    const nextEntryView = entryViewFromParam(params.get('status'));
    const nextHighlightedEntryId = params.get('entryId');
    const scopeChanged = nextScope !== scopeFromParam(previousParams.get('scope'));
    const workspaceChanged = nextScope === 'workspace' && nextWorkspaceId !== previousParams.get('workspaceId');
    const agentChanged = nextScope === 'agent' && nextAgentId !== previousParams.get('agentId');
    const collectionChanged = nextCollectionId !== previousParams.get('collectionId');
    const viewChanged = nextEntryView !== entryViewFromParam(previousParams.get('status'));

    if (scopeChanged || workspaceChanged || agentChanged || collectionChanged) {
      collectionLoadVersionRef.current += 1;
      entryLoadVersionRef.current += 1;
    } else if (viewChanged) {
      entryLoadVersionRef.current += 1;
    }

    initialCollectionIdRef.current = nextCollectionId;
    const timer = window.setTimeout(() => {
      if (scopeChanged || workspaceChanged || agentChanged) {
        setCollections([]);
        setSelectedCollectionId(nextCollectionId);
        setEntries([]);
        setEntryQuery('');
        setHistoryForEntryId(null);
        setEntryHistory([]);
        setEditingId(null);
        setLoading(true);
      } else if (collectionChanged || viewChanged) {
        setEntries([]);
        setEntryQuery('');
        setHistoryForEntryId(null);
        setEntryHistory([]);
        setEditingId(null);
      }

      setScope(nextScope);
      if (nextScope === 'workspace') setWorkspaceId(nextWorkspaceId);
      if (nextScope === 'agent') setAgentId(nextAgentId);
      if (collectionChanged) setSelectedCollectionId(nextCollectionId);
      setEntryView(nextEntryView);
      setHighlightedEntryId(nextHighlightedEntryId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [locationQuery]);

  useEffect(() => {
    if (scope !== 'workspace' || workspacesLoading || selectedWorkspace) return;
    const fallback = accessibleWorkspaces.find((workspace) => workspace.id === activeWorkspace?.id) ?? accessibleWorkspaces[0];
    if (!fallback) return;
    const timer = window.setTimeout(() => selectWorkspace(fallback.id), 0);
    return () => window.clearTimeout(timer);
  }, [accessibleWorkspaces, activeWorkspace?.id, scope, selectWorkspace, selectedWorkspace, workspacesLoading]);

  const loadAgentOwners = useCallback(async () => {
    try {
      const data = await readJson<{ owners: AgentMemoryOwner[] }>('/api/memory?owners=1');
      setAgentOwners(data.owners);
      if (scope === 'agent' && !agentId) {
        const preferred = data.owners.find((owner) => owner.agentId === DEFAULT_AGENT_ID) ?? data.owners.find((owner) => owner.status === 'active') ?? data.owners[0];
        if (preferred) selectAgentOwner(preferred.agentId);
      } else if (scope === 'agent' && agentId && !data.owners.some((owner) => owner.agentId === agentId)) {
        throw new Error(`Agent "${agentId}" is not available and has no retained memory.`);
      }
    } finally {
      setOwnersLoading(false);
    }
  }, [agentId, scope, selectAgentOwner]);

  const loadCollections = useCallback(async (preferredCollectionId?: string | null) => {
    const loadVersion = ++collectionLoadVersionRef.current;
    if (!canUseScope) {
      if (loadVersion === collectionLoadVersionRef.current) {
        setCollections([]);
        setEntries([]);
        setSelectedCollectionId(null);
      }
      return;
    }
    const data = await readJson<{ collections: Collection[]; entries: Entry[]; permissions: MemoryPermissions }>(`/api/memory?${query.toString()}`);
    if (loadVersion !== collectionLoadVersionRef.current) return;
    setCollections(data.collections);
    setPermissions(data.permissions);
    const requestedCollectionId = preferredCollectionId ?? initialCollectionIdRef.current;
    initialCollectionIdRef.current = null;
    const selected = requestedCollectionId && data.collections.some((collection) => collection.id === requestedCollectionId)
      ? requestedCollectionId
      : data.collections[0]?.id ?? null;
    setSelectedCollectionId(selected);
  }, [canUseScope, query]);

  const loadEntries = useCallback(async (collectionId: string | null, requestedView = entryView) => {
    const loadVersion = ++entryLoadVersionRef.current;
    if (!collectionId || !canUseScope) {
      if (loadVersion === entryLoadVersionRef.current) setEntries([]);
      return;
    }
    const data = await readJson<{ entries: Entry[] }>(`/api/memory?${queryForScope(scope, agentId, workspaceId, collectionId, requestedView).toString()}`);
    if (loadVersion !== entryLoadVersionRef.current) return;
    setEntries(data.entries);
  }, [agentId, canUseScope, entryView, scope, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      Promise.all([loadSettings(), loadAgentOwners(), loadCollections()])
        .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : t('errors.loadMemory')); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [loadAgentOwners, loadCollections, loadSettings, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadEntries(selectedCollectionId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : t('errors.loadEntries')));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadEntries, selectedCollectionId, t]);

  useEffect(() => {
    if (!highlightedEntryId || !entries.some((entry) => entry.id === highlightedEntryId)) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`memory-entry-${highlightedEntryId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [entries, highlightedEntryId]);

  const setScopeWithUrl = (nextScope: MemoryScope) => {
    if (nextScope === scope) return;
    collectionLoadVersionRef.current += 1;
    entryLoadVersionRef.current += 1;
    setLoading(true);
    setCollections([]);
    setEntries([]);
    setSelectedCollectionId(null);
    setHistoryForEntryId(null);
    setEntryHistory([]);
    setEditingId(null);
    setHighlightedEntryId(null);
    setEntryView('published');
    setScope(nextScope);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'memory');
    url.searchParams.set('scope', nextScope);
    if (nextScope === 'workspace' && workspaceId) url.searchParams.set('workspaceId', workspaceId);
    if (nextScope === 'agent' && agentId) url.searchParams.set('agentId', agentId);
    url.searchParams.set('status', 'published');
    url.searchParams.delete('collectionId');
    url.searchParams.delete('entryId');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const setAutomaticMemoryEnabled = async (automaticMemoryEnabled: boolean) => {
    if (!settings) return;
    const previous = settings;
    setToggleSaving(true); setError(null); setNotice(null);
    setSettings({ ...settings, automaticMemoryEnabled, automaticMemoryOperational: automaticMemoryEnabled && settings.memoryReviewWorkerAvailable });
    try {
      const data = await readJson<MemorySettings>('/api/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automaticMemoryEnabled }),
      });
      setSettings(data);
      setNotice(automaticMemoryEnabled ? t('reviewer.enabledNotice') : t('reviewer.disabledNotice'));
    } catch (saveError) {
      setSettings(previous);
      setError(saveError instanceof Error ? saveError.message : t('reviewer.saveError'));
    } finally {
      setToggleSaving(false);
    }
  };

  const savePersonalSettings = async () => {
    if (!settings) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const data = await readJson<MemorySettings>('/api/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memoryPromptMaxTokens: settings.memoryPromptMaxTokens,
          sensitiveMemoryEnabled: settings.sensitiveMemoryEnabled,
        }),
      });
      setSettings(data);
      setNotice(t('reviewer.personalSaved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('reviewer.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const saveRuntimeSettings = async () => {
    if (!settings?.canManageMemoryRuntime) return;
    setRuntimeSaving(true); setError(null); setNotice(null);
    try {
      if (!settings.providerInstallationId || !settings.modelId || !settings.catalogRevision) {
        throw new Error(t('reviewer.chooseRuntimeError'));
      }
      await readJson('/api/admin/memory-review-runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerInstallationId: settings.providerInstallationId,
          modelId: settings.modelId,
          expectedCatalogRevision: settings.catalogRevision,
        }),
      });
      await loadSettings();
      setNotice(t('reviewer.runtimeSaved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('reviewer.runtimeSaveError'));
    } finally {
      setRuntimeSaving(false);
    }
  };

  const refreshScope = async (requestedView = entryView) => {
    await loadCollections(selectedCollectionId);
    await loadEntries(selectedCollectionId, requestedView);
  };

  const selectEntryView = (nextView: MemoryEntryView) => {
    entryLoadVersionRef.current += 1;
    setEntryView(nextView);
    setEntryQuery('');
    setHistoryForEntryId(null);
    setEntryHistory([]);
    setEditingId(null);
    setHighlightedEntryId(null);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'memory');
    url.searchParams.set('scope', scope);
    url.searchParams.set('status', nextView);
    if (selectedCollectionId) url.searchParams.set('collectionId', selectedCollectionId);
    url.searchParams.delete('entryId');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const selectCollection = (collectionId: string) => {
    collectionLoadVersionRef.current += 1;
    entryLoadVersionRef.current += 1;
    setSelectedCollectionId(collectionId);
    setEntryQuery('');
    setHistoryForEntryId(null);
    setEntryHistory([]);
    setEditingId(null);
    setHighlightedEntryId(null);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'memory');
    url.searchParams.set('scope', scope);
    url.searchParams.set('collectionId', collectionId);
    url.searchParams.set('status', entryView);
    url.searchParams.delete('entryId');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const addEntry = async () => {
    if (!draft.trim()) return;
    setAdding(true); setError(null); setNotice(null);
    try {
      const result = await readJson<MemoryMutationResponse>('/api/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, agentId, workspaceId, content: draft, priority: draftPriority }),
      });
      const nextView: MemoryEntryView = result.entry?.status === 'pending' ? 'pending' : 'published';
      setDraft('');
      setNotice(result.entry?.status === 'pending' ? t('notices.suggestionCreated') : t('notices.memorySaved'));
      setHighlightedEntryId(result.entry?.id ?? null);
      if (result.entry?.collectionId) setSelectedCollectionId(result.entry.collectionId);
      selectEntryView(nextView);
      await loadCollections(result.entry?.collectionId ?? selectedCollectionId);
      await loadEntries(result.entry?.collectionId ?? selectedCollectionId, nextView);
      window.dispatchEvent(new CustomEvent('notification_summary_updated'));
    } catch (addError) { setError(addError instanceof Error ? addError.message : t('errors.addMemory')); }
    finally { setAdding(false); }
  };

  const mutateEntry = async (entry: Entry, action: 'publish' | 'restore' | 'update' | 'archive') => {
    setError(null); setNotice(null);
    try {
      const entryQuery = queryForScope(scope, agentId, workspaceId);
      if (action === 'archive') {
        await readJson(`/api/memory/entries/${encodeURIComponent(entry.id)}?${entryQuery.toString()}`, { method: 'DELETE' });
      } else {
        await readJson(`/api/memory/entries/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope, agentId, workspaceId, action, content: action === 'update' ? editingContent : undefined, priority: action === 'update' ? editingPriority : undefined }),
        });
      }
      setEditingId(null); setNotice(action === 'publish' ? t('notices.published') : action === 'restore' ? t('notices.restored') : action === 'archive' ? t('notices.archived') : t('notices.updated'));
      await refreshScope();
      window.dispatchEvent(new CustomEvent('notification_summary_updated'));
    } catch (mutationError) { setError(mutationError instanceof Error ? mutationError.message : t('errors.updateMemory')); }
  };

  const toggleEntryHistory = async (entry: Entry) => {
    if (historyForEntryId === entry.id) {
      setHistoryForEntryId(null); setEntryHistory([]);
      return;
    }
    setError(null);
    try {
      const entryQuery = queryForScope(scope, agentId, workspaceId);
      const history = await readJson<MemoryEvent[]>(`/api/memory/entries/${encodeURIComponent(entry.id)}?${entryQuery.toString()}`);
      setHistoryForEntryId(entry.id); setEntryHistory(history);
    } catch (historyError) { setError(historyError instanceof Error ? historyError.message : t('errors.loadHistory')); }
  };

  const exportCurrentCollection = async () => {
    if (!selectedCollection) return;
    setExportingCollectionId(selectedCollection.id);
    setError(null);
    try {
      const exportQuery = queryForScope(scope, agentId, workspaceId, selectedCollection.id);
      exportQuery.set('includeArchived', '1');
      const data = await readJson<{ entries: Entry[] }>(`/api/memory?${exportQuery.toString()}`);
      const content = JSON.stringify({
        exportedAt: new Date().toISOString(),
        scope,
        collection: selectedCollection,
        entries: data.entries,
      }, null, 2);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `canvas-memory-${scope}-${selectedCollection.category}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : t('errors.loadEntries'));
    } finally {
      setExportingCollectionId(null);
    }
  };

  const exportSelectedAgentMemory = async () => {
    if (!agentId) return;
    setOwnerOperation('export'); setError(null); setNotice(null);
    try {
      const exportData = await readJson<Record<string, unknown>>(`/api/memory?scope=agent&agentId=${encodeURIComponent(agentId)}&export=1`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `canvas-agent-memory-${agentId}.json`; anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`Exported all retained memory for ${selectedAgentOwner?.name || agentId}.`);
    } catch (exportError) { setError(exportError instanceof Error ? exportError.message : 'Unable to export agent memory.'); }
    finally { setOwnerOperation(null); }
  };

  const setSelectedAgentMemoryArchived = async (archived: boolean) => {
    if (!agentId) return;
    setOwnerOperation(archived ? 'archive' : 'restore'); setError(null); setNotice(null);
    try {
      const result = await readJson<{ collections: number }>('/api/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: archived ? 'archive-agent-memory' : 'restore-agent-memory', agentId }),
      });
      setNotice(`${archived ? 'Archived' : 'Restored'} ${result.collections} agent-memory ${result.collections === 1 ? 'collection' : 'collections'}.`);
      await Promise.all([loadAgentOwners(), refreshScope()]);
    } catch (archiveError) { setError(archiveError instanceof Error ? archiveError.message : 'Unable to update agent memory.'); }
    finally { setOwnerOperation(null); }
  };

  const transferSelectedAgentMemory = async () => {
    if (!agentId || !transferTargetAgentId) return;
    setOwnerOperation('transfer'); setError(null); setNotice(null);
    try {
      const result = await readJson<{ collections: number; entries: number }>('/api/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'transfer-agent-memory', agentId, targetAgentId: transferTargetAgentId }),
      });
      const target = agentOwners.find((owner) => owner.agentId === transferTargetAgentId);
      setNotice(`Transferred ${result.entries} ${result.entries === 1 ? 'entry' : 'entries'} to ${target?.name || transferTargetAgentId}.`);
      selectAgentOwner(transferTargetAgentId);
    } catch (transferError) { setError(transferError instanceof Error ? transferError.message : 'Unable to transfer agent memory.'); }
    finally { setOwnerOperation(null); }
  };

  const deleteSelectedAgentMemory = async () => {
    if (!agentId) return;
    setDeleting(true); setError(null); setNotice(null);
    try {
      const result = await readJson<{ collections: number; entries: number }>(`/api/memory?scope=agent&agentId=${encodeURIComponent(agentId)}&confirm=delete-agent-memory`, { method: 'DELETE' });
      setAgentDeletionDialogOpen(false);
      setNotice(`Deleted ${result.entries} retained agent-memory ${result.entries === 1 ? 'entry' : 'entries'}.`);
      const nextOwner = agentOwners.find((owner) => owner.status === 'active' && owner.agentId !== agentId);
      if (nextOwner) selectAgentOwner(nextOwner.agentId);
      else setAgentId(null);
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete agent memory.'); }
    finally { setDeleting(false); }
  };

  const readImportFile = async (file: File | null) => {
    if (!file) return;
    setError(null); setNotice(null);
    try {
      const parsed = JSON.parse(await file.text()) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) throw new Error('Choose a Canvas memory export with an entries array.');
      const candidates = parsed.entries
        .map((entry) => typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'content' in entry && typeof entry.content === 'string' ? entry.content : null)
        .filter((entry): entry is string => Boolean(entry?.trim()));
      if (candidates.length === 0) throw new Error('The selected export has no importable memory entries.');
      if (candidates.length > 100) throw new Error('Import at most 100 memory entries at a time.');
      setImportEntries(candidates);
    } catch (importError) { setError(importError instanceof Error ? importError.message : 'Unable to read the memory export.'); }
    finally { if (importInputRef.current) importInputRef.current.value = ''; }
  };

  const importMemory = async () => {
    if (!importEntries) return;
    setAdding(true); setError(null);
    try {
      const result = await readJson<{ added: number; skipped: number }>('/api/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'import', entries: importEntries }),
      });
      setImportEntries(null);
      setNotice(`${result.added} memory ${result.added === 1 ? 'entry' : 'entries'} imported${result.skipped ? `; ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped` : ''}.`);
      await refreshScope();
    } catch (importError) { setError(importError instanceof Error ? importError.message : 'Unable to import memory.'); }
    finally { setAdding(false); }
  };

  const deletePersonalMemory = async () => {
    setDeleting(true); setError(null); setNotice(null);
    try {
      const result = await readJson<{ collections: number; entries: number }>('/api/memory?confirm=delete-personal-memory', { method: 'DELETE' });
      setDeletionDialogOpen(false);
      setNotice(`Deleted ${result.entries} private memory ${result.entries === 1 ? 'entry' : 'entries'} from ${result.collections} ${result.collections === 1 ? 'collection' : 'collections'}.`);
      await refreshScope();
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete personal memory.'); }
    finally { setDeleting(false); }
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden border-primary/20 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.14),transparent_43%)]">
        <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-primary"><BrainCircuit className="size-5" /><span className="text-xs font-bold uppercase tracking-[0.18em]">{t('eyebrow')}</span></div>
            <CardTitle className="text-2xl tracking-tight">{t('title')}</CardTitle>
            <CardDescription className="max-w-2xl text-sm leading-6">{t('description')}</CardDescription>
          </div>
        </CardHeader>
      </Card>

      {error ? <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">{notice}</p> : null}

      <Card className={cn('border-border', reviewerActive && 'border-primary/30 bg-primary/[0.03]')} data-testid="memory-reviewer-toggle-card">
        <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <span className={cn('grid size-10 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground', reviewerActive && 'border-primary/25 bg-primary/10 text-primary')}>
              <Sparkles className="size-5" />
            </span>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{t('reviewer.title')}</p>
                <Badge variant={reviewerActive ? 'secondary' : 'outline'}>
                  {!settings ? t('loading') : !settings.memoryReviewWorkerAvailable ? t('reviewer.serverDisabled') : reviewerActive ? t('reviewer.enabled') : t('reviewer.disabled')}
                </Badge>
              </div>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {!settings
                  ? t('loading')
                  : !settings.memoryReviewWorkerAvailable
                    ? t('reviewer.serverDisabledDescription')
                    : reviewerActive
                      ? t('reviewer.enabledDescription')
                      : t('reviewer.disabledDescription')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 self-end sm:self-center">
            {toggleSaving ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('reviewer.saving')} /> : null}
            <Switch
              id="automatic-memory"
              data-testid="automatic-memory-switch"
              aria-label={t('reviewer.toggleLabel')}
              checked={reviewerActive}
              disabled={!settings || !settings.memoryReviewWorkerAvailable || toggleSaving}
              onCheckedChange={(checked) => void setAutomaticMemoryEnabled(checked)}
            />
          </div>
        </CardContent>
      </Card>

      <div className={cn('grid gap-6', reviewerActive && 'xl:grid-cols-[minmax(0,1fr)_22rem]')}>
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('scopeAriaLabel')}>
            {MEMORY_SCOPES.map((item) => (
              <Button key={item} variant={scope === item ? 'default' : 'outline'} size="sm" onClick={() => setScopeWithUrl(item)} disabled={item === 'workspace' && !workspacesLoading && accessibleWorkspaces.length === 0}>{t(`scopes.${item}`)}</Button>
            ))}
          </div>

          {scope === 'agent' ? (
            <Card className="border-primary/25" data-testid="agent-memory-owner-card">
              <CardHeader className="space-y-1">
                <CardTitle className="text-base">Agent memory owner</CardTitle>
                <CardDescription>Every collection below belongs only to the selected agent. Changing the selection never mixes memories between agents.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {ownersLoading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading agents…</p> : agentOwners.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No accessible agents exist yet. <Link href="/settings?tab=agent-settings&createAgent=1" className="font-medium text-primary underline-offset-4 hover:underline">Create an agent</Link> before storing agent-specific memory.</div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="agent-memory-owner">Selected agent</Label>
                      <select id="agent-memory-owner" data-testid="agent-memory-owner-select" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={agentId ?? ''} onChange={(event) => selectAgentOwner(event.target.value)}>
                        <option value="" disabled>Choose an agent</option>
                        {agentOwners.map((owner) => <option key={owner.agentId} value={owner.agentId}>{owner.name} · {owner.agentId}{owner.status === 'deleted' ? ' · deleted' : ''} · {owner.entryCount} memories</option>)}
                      </select>
                    </div>
                    {selectedAgentOwner ? (
                      <div className="rounded-lg border bg-muted/20 p-4">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 items-center gap-3">
                            <AgentAvatar iconId={selectedAgentOwner.iconId} className={selectedAgentOwner.status === 'deleted' ? 'opacity-60' : ''} />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{selectedAgentOwner.name}</p><Badge variant={selectedAgentOwner.status === 'deleted' ? 'outline' : 'secondary'}>{selectedAgentOwner.status}</Badge></div>
                              <p className="truncate font-mono text-xs text-muted-foreground">{selectedAgentOwner.agentId}</p>
                              <p className="mt-1 text-xs text-muted-foreground">{selectedAgentOwner.entryCount} entries · {selectedAgentOwner.collectionCount} collections · {selectedAgentOwner.archivedCollectionCount} archived</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" onClick={() => void exportSelectedAgentMemory()} disabled={ownerOperation !== null}><Download className="mr-2 size-4" />Export all</Button>
                            {selectedAgentOwner.collectionCount > 0 ? <Button variant="outline" size="sm" onClick={() => void setSelectedAgentMemoryArchived(selectedAgentOwner.archivedCollectionCount < selectedAgentOwner.collectionCount)} disabled={ownerOperation !== null}>{selectedAgentOwner.archivedCollectionCount === selectedAgentOwner.collectionCount ? <RotateCcw className="mr-2 size-4" /> : <Archive className="mr-2 size-4" />}{selectedAgentOwner.archivedCollectionCount === selectedAgentOwner.collectionCount ? 'Restore all' : 'Archive all'}</Button> : null}
                            {selectedAgentOwner.collectionCount > 0 ? <Button variant="destructive" size="sm" onClick={() => setAgentDeletionDialogOpen(true)} disabled={ownerOperation !== null}><Trash2 className="mr-2 size-4" />Delete data</Button> : null}
                          </div>
                        </div>
                        {selectedAgentOwner.status === 'deleted' ? <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">This agent was deleted. Its memory is retained for you and is not used by another agent unless you explicitly transfer it.</p> : null}
                        {selectedAgentOwner.collectionCount > 0 && activeTransferTargets.length > 0 ? <div className="mt-4 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-end"><div className="min-w-0 flex-1 space-y-2"><Label htmlFor="agent-memory-transfer-target">Transfer all memory to</Label><select id="agent-memory-transfer-target" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={transferTargetAgentId} onChange={(event) => setTransferTargetAgentId(event.target.value)}><option value="">Choose a target agent</option>{activeTransferTargets.map((owner) => <option key={owner.agentId} value={owner.agentId}>{owner.name} · {owner.agentId}</option>)}</select></div><Button variant="outline" onClick={() => void transferSelectedAgentMemory()} disabled={!transferTargetAgentId || ownerOperation !== null}>{ownerOperation === 'transfer' ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ArrowRightLeft className="mr-2 size-4" />}Transfer</Button></div> : null}
                      </div>
                    ) : <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">Choose a valid agent before loading agent memory.</p>}
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}

          {scope === 'workspace' ? (
            <Card className="border-primary/25" data-testid="workspace-memory-owner-card">
              <CardHeader className="space-y-1">
                <CardTitle className="text-base">{t('workspaceSelector.title')}</CardTitle>
                <CardDescription>{t('workspaceSelector.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {workspacesLoading && accessibleWorkspaces.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('workspaceSelector.loading')}</p>
                ) : accessibleWorkspaces.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('workspaceSelector.empty')}</p>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="workspace-memory-owner">{t('workspaceSelector.label')}</Label>
                      <select
                        id="workspace-memory-owner"
                        data-testid="workspace-memory-owner-select"
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={workspaceId ?? ''}
                        onChange={(event) => selectWorkspace(event.target.value)}
                      >
                        <option value="" disabled>{t('workspaceSelector.choose')}</option>
                        {accessibleWorkspaces.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.name} · {t(`workspaceSelector.types.${workspace.type}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {selectedWorkspace ? (
                      <div className="rounded-lg border bg-muted/20 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{selectedWorkspace.name}</p>
                          <Badge variant="secondary">{t(`workspaceSelector.types.${selectedWorkspace.type}`)}</Badge>
                        </div>
                        {selectedWorkspace.description ? <p className="mt-1 text-sm text-muted-foreground">{selectedWorkspace.description}</p> : null}
                        <p className="mt-2 text-xs text-muted-foreground">{t('workspaceSelector.selectedHint')}</p>
                      </div>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="space-y-1">
              <CardTitle className="text-base">{t('categories.title')}</CardTitle>
              <CardDescription>{t('categories.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('categories.loading')}</p> : null}
              {!loading && collections.length === 0 ? (
                <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                  {t('categories.empty')}
                </p>
              ) : null}
              {collections.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {collections.map((collection) => {
                    const categoryLabel = memoryCategoryLabel(collection.category, locale);
                    const categoryDescription = memoryCategoryDescription(collection.category, locale);
                    const selected = selectedCollectionId === collection.id;
                    return (
                      <div
                        key={collection.id}
                        data-testid="memory-category-card"
                        data-collection-id={collection.id}
                        className={cn(
                          'group flex min-h-36 flex-col overflow-hidden rounded-xl border bg-card transition-[border-color,box-shadow,background-color] hover:border-primary/40 hover:bg-muted/20',
                          selected && 'border-primary bg-primary/[0.04] shadow-sm ring-1 ring-primary/15',
                        )}
                      >
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => selectCollection(collection.id)}
                          className="flex flex-1 flex-col p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span className={cn('grid size-9 place-items-center rounded-lg border bg-muted/40 text-muted-foreground', selected && 'border-primary/25 bg-primary/10 text-primary')}>
                              <BookOpenText className="size-4" />
                            </span>
                            <div className="flex items-center gap-2">
                              {collection.pendingCount > 0 ? <Badge variant="outline">{t('categories.pending', { count: collection.pendingCount })}</Badge> : null}
                              {collection.archivedCount > 0 ? <Badge variant="outline">{t('categories.archived', { count: collection.archivedCount })}</Badge> : null}
                              <ChevronRight className={cn('size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5', selected && 'text-primary')} />
                            </div>
                          </div>
                          <p className="mt-3 font-semibold tracking-tight">{categoryLabel}</p>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{categoryDescription}</p>
                          <p className="mt-auto pt-3 text-xs text-muted-foreground">
                            {t('categories.entries', { count: collection.totalCount })} · {formatDate(collection.updatedAt, locale)}
                          </p>
                        </button>
                        {selected ? (
                          <div className="border-t border-primary/15 p-3">
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full bg-background/80"
                              onClick={() => void exportCurrentCollection()}
                              disabled={exportingCollectionId !== null || collection.totalCount === 0}
                            >
                              {exportingCollectionId === collection.id ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
                              {t('categories.export')}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="space-y-2">
            {selectedCollection ? (
              <div className="flex flex-wrap gap-2 rounded-lg border bg-muted/20 p-2" role="tablist" aria-label={t('entries.statusAriaLabel')}>
                <Button data-testid="memory-status-published" size="sm" variant={entryView === 'published' ? 'default' : 'ghost'} onClick={() => selectEntryView('published')}>
                  {t('entries.views.published', { count: selectedCollection.publishedCount })}
                </Button>
                {(selectedCollection.pendingCount > 0 || entryView === 'pending') ? (
                  <Button data-testid="memory-status-pending" size="sm" variant={entryView === 'pending' ? 'default' : 'ghost'} onClick={() => selectEntryView('pending')}>
                    {t('entries.views.pending', { count: selectedCollection.pendingCount })}
                  </Button>
                ) : null}
                {(selectedCollection.archivedCount > 0 || entryView === 'archived') && permissions?.canArchive ? (
                  <Button data-testid="memory-status-archived" size="sm" variant={entryView === 'archived' ? 'default' : 'ghost'} onClick={() => selectEntryView('archived')}>
                    {t('entries.views.archived', { count: selectedCollection.archivedCount })}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">{entries.length > 0 ? <Input aria-label={t('entries.searchLabel')} value={entryQuery} onChange={(event) => setEntryQuery(event.target.value)} placeholder={t('entries.searchPlaceholder')} className="max-w-sm" /> : null}{entries.length > 0 ? <select aria-label={t('entries.sortLabel')} className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={entrySort} onChange={(event) => setEntrySort(event.target.value as 'priority' | 'updated' | 'lastUsed')}><option value="priority">{t('entries.sortPriority')}</option><option value="updated">{t('entries.sortUpdated')}</option><option value="lastUsed">{t('entries.sortLastUsed')}</option></select> : null}</div>
            {visibleEntries.map((entry) => (
              <Card
                id={`memory-entry-${entry.id}`}
                key={entry.id}
                data-testid="memory-entry-card"
                data-entry-id={entry.id}
                data-entry-status={entry.status}
                className={cn(
                  entry.status === 'pending' ? 'border-amber-500/40 bg-amber-500/5' : entry.status === 'archived' ? 'border-dashed opacity-75' : '',
                  highlightedEntryId === entry.id && 'ring-2 ring-primary ring-offset-2',
                )}
              >
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {editingId === entry.id ? (
                        <div className="space-y-3">
                          <Textarea value={editingContent} onChange={(event) => setEditingContent(event.target.value)} maxLength={800} />
                          <div className="max-w-48 space-y-1">
                            <Label htmlFor={`memory-priority-${entry.id}`}>{t('entries.priorityLabel')}</Label>
                            <Input
                              id={`memory-priority-${entry.id}`}
                              type="number"
                              min={0}
                              max={100}
                              step={1}
                              value={editingPriority}
                              onChange={(event) => setEditingPriority(Number(event.target.value))}
                            />
                            <p className="text-xs text-muted-foreground">{t(`entries.priorityBands.${memoryPriorityBand(editingPriority)}`)}</p>
                          </div>
                        </div>
                      ) : <MemoryMarkdownContent content={entry.content} />}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge variant={entry.status === 'published' ? 'secondary' : 'outline'}>{t(`entries.status.${entry.status}`)}</Badge>
                        <span className="text-xs text-muted-foreground">{t('entries.priorityWithBand', { priority: entry.priority, band: t(`entries.priorityBands.${memoryPriorityBand(entry.priority)}`) })}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {!agentMemoryReadOnly && entry.status === 'pending' && permissions?.canPublish ? <Button size="icon" variant="outline" title={t('entries.publish')} onClick={() => void mutateEntry(entry, 'publish')}><Send className="size-4" /></Button> : null}
                      {!agentMemoryReadOnly && entry.status === 'archived' && permissions?.canArchive ? <Button size="icon" variant="ghost" title={t('entries.restore')} onClick={() => void mutateEntry(entry, 'restore')}><RotateCcw className="size-4" /></Button> : null}
                      {!agentMemoryReadOnly && entry.status !== 'archived' && permissions?.canUpdatePublished ? editingId === entry.id
                        ? <Button size="icon" title={t('entries.save')} disabled={editingPriority < 0 || editingPriority > 100 || !Number.isInteger(editingPriority)} onClick={() => void mutateEntry(entry, 'update')}><Check className="size-4" /></Button>
                        : <Button size="icon" variant="ghost" title={t('entries.edit')} onClick={() => { setEditingId(entry.id); setEditingContent(entry.content); setEditingPriority(entry.priority); }}><Pencil className="size-4" /></Button>
                        : null}
                      {!agentMemoryReadOnly && entry.status !== 'archived' && permissions?.canArchive ? <Button size="icon" variant="ghost" title={t('entries.archive')} onClick={() => void mutateEntry(entry, 'archive')}><Archive className="size-4" /></Button> : null}
                    </div>
                  </div>
                  <Button className="mt-3 px-0" size="sm" variant="link" onClick={() => void toggleEntryHistory(entry)}>{historyForEntryId === entry.id ? t('entries.hideHistory') : t('entries.history')}</Button>
                  {historyForEntryId === entry.id ? <div className="mt-2 space-y-1 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">{entryHistory.map((event) => <p key={event.id}><span className="font-medium text-foreground">{event.action}</span> · {event.actorType}{event.decisionCode ? ` · ${event.decisionCode.replaceAll('_', ' ')}` : ''} · {formatDate(event.createdAt, locale)}</p>)}</div> : null}
                </CardContent>
              </Card>
            ))}
            {!loading && selectedCollectionId && entries.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-5 text-sm text-muted-foreground">{t(`entries.emptyViews.${entryView}`)}</p> : null}
            {!loading && entries.length > 0 && visibleEntries.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-5 text-sm text-muted-foreground">{t('entries.noSearchResults')}</p> : null}
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">{t('editor.title')}</CardTitle><CardDescription>{scope === 'workspace' || scope === 'organization' ? permissions?.canPublish ? t('editor.sharedManagerDescription') : t('editor.sharedContributorDescription') : t('editor.description')}</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={800} placeholder={t('editor.placeholder')} disabled={agentMemoryReadOnly} />
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-end">
                <div className="space-y-1">
                  <Label htmlFor="new-memory-priority">{t('entries.priorityLabel')}</Label>
                  <Input id="new-memory-priority" type="number" min={0} max={100} step={1} value={draftPriority} onChange={(event) => setDraftPriority(Number(event.target.value))} disabled={agentMemoryReadOnly} />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('editor.priorityHint', { band: t(`entries.priorityBands.${memoryPriorityBand(draftPriority)}`) })}
                </p>
              </div>
              <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{agentMemoryReadOnly ? t('editor.deletedAgentReadOnly') : `${draft.length}/800`}</span><Button onClick={() => void addEntry()} disabled={!draft.trim() || adding || !canUseScope || agentMemoryReadOnly || draftPriority < 0 || draftPriority > 100 || !Number.isInteger(draftPriority)}>{adding ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />}{scope === 'workspace' || scope === 'organization' ? permissions?.canPublish ? t('editor.publish') : t('editor.suggest') : t('editor.save')}</Button></div>
            </CardContent>
          </Card>

          {scope === 'user' ? <Card className="border-dashed">
            <CardHeader><CardTitle className="text-base">{t('privateData.title')}</CardTitle><CardDescription>{t('privateData.description')}</CardDescription></CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <input ref={importInputRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void readImportFile(event.target.files?.[0] ?? null)} />
              <Button variant="outline" onClick={() => importInputRef.current?.click()}><Upload className="mr-2 size-4" />{t('privateData.import')}</Button>
              <Button variant="destructive" onClick={() => setDeletionDialogOpen(true)}><Trash2 className="mr-2 size-4" />{t('privateData.delete')}</Button>
            </CardContent>
          </Card> : null}
        </div>

        {reviewerActive && settings ? (
          <Card className="h-fit xl:sticky xl:top-6" data-testid="memory-reviewer-settings">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" />{t('reviewer.runtimeTitle')}</CardTitle>
              <CardDescription>{t('reviewer.runtimeDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                {settings.canManageMemoryRuntime ? t('reviewer.adminRuntimeHint') : t('reviewer.memberRuntimeHint')}
              </div>
              <div className="space-y-2">
                <Label htmlFor="memory-provider">{t('reviewer.provider')}</Label>
                <select id="memory-provider" data-testid="memory-reviewer-provider" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={settings.providerInstallationId ?? ''} disabled={!settings.canManageMemoryRuntime || runtimeSaving} onChange={(event) => { setSettings({ ...settings, providerInstallationId: event.target.value || null, modelId: null }); setRuntimeDraftChanged(true); }}>
                  <option value="">{t('reviewer.chooseProvider')}</option>
                  {settings.providers.map((provider) => <option value={provider.installationId} key={provider.installationId}>{provider.name}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="memory-model">{t('reviewer.model')}</Label>
                <select id="memory-model" data-testid="memory-reviewer-model" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={settings.modelId ?? ''} disabled={!settings.canManageMemoryRuntime || !selectedProvider || runtimeSaving} onChange={(event) => { setSettings({ ...settings, modelId: event.target.value || null }); setRuntimeDraftChanged(true); }}>
                  <option value="">{t('reviewer.chooseModel')}</option>
                  {selectedProvider?.models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">{settings.runtimeConfigured && !runtimeDraftChanged ? t('reviewer.runtimeVerified') : settings.canManageMemoryRuntime ? t('reviewer.runtimeVerificationNeeded') : t('reviewer.runtimeWaitingForAdmin')}</p>
              </div>
              {settings.canManageMemoryRuntime ? (
                <Button variant="outline" className="w-full" onClick={() => void saveRuntimeSettings()} disabled={runtimeSaving || (!runtimeDraftChanged && settings.runtimeConfigured)}>
                  {runtimeSaving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Check className="mr-2 size-4" />}{t('reviewer.verifyRuntime')}
                </Button>
              ) : null}
              <div className="border-t pt-5">
                <div className="space-y-2">
                  <Label htmlFor="memory-budget">{t('reviewer.promptBudget')}</Label>
                  <Input id="memory-budget" data-testid="memory-reviewer-budget" type="number" min={0} max={4000} value={settings.memoryPromptMaxTokens} onChange={(event) => setSettings({ ...settings, memoryPromptMaxTokens: Number(event.target.value) })} />
                  <p className="text-xs text-muted-foreground">{t('reviewer.promptBudgetHint')}</p>
                </div>
                <Button className="mt-4 w-full" onClick={() => void savePersonalSettings()} disabled={saving}>
                  {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}{t('reviewer.savePersonal')}
                </Button>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">{t('reviewer.queue')}</span>
                <span className="font-medium">{t('reviewer.jobs', { count: settings.review.count })}</span>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <AlertDialog open={Boolean(importEntries)} onOpenChange={(open) => !open && setImportEntries(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Import {importEntries?.length ?? 0} private memory entries?</AlertDialogTitle><AlertDialogDescription>Entries are deduplicated and added only to your private memory. Review shared facts manually in their respective scope.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={adding}>Cancel</AlertDialogCancel><AlertDialogAction disabled={adding} onClick={(event) => { event.preventDefault(); void importMemory(); }}>{adding ? 'Importing…' : 'Import private memory'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deletionDialogOpen} onOpenChange={setDeletionDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete all private memory?</AlertDialogTitle><AlertDialogDescription>This permanently removes your personal and private-agent collections, including their history. Workspace and organization memory are not affected.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" disabled={deleting} onClick={(event) => { event.preventDefault(); void deletePersonalMemory(); }}>{deleting ? 'Deleting…' : 'Delete private memory'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={agentDeletionDialogOpen} onOpenChange={setAgentDeletionDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete all memory for {selectedAgentOwner?.name || agentId}?</AlertDialogTitle><AlertDialogDescription>This permanently removes {selectedAgentOwner?.entryCount ?? 0} entries and their full history for agent ID {agentId}. The agent profile and every other agent’s memory remain unchanged.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" disabled={deleting} onClick={(event) => { event.preventDefault(); void deleteSelectedAgentMemory(); }}>{deleting ? 'Deleting…' : 'Delete agent memory'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
