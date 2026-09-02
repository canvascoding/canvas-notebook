'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowRightLeft, BrainCircuit, Check, Clock3, Download, Loader2, Pencil, Plus, RotateCcw, Save, Send, Sparkles, Trash2, Upload } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
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
  status: 'active' | 'archived';
  updatedAt: number;
  entryCount: number;
  pendingCount: number;
};

type MemorySettings = {
  automaticMemoryEnabled: boolean;
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

const SCOPE_COPY: Record<MemoryScope, { label: string; eyebrow: string }> = {
  user: { label: 'My memory', eyebrow: 'Private to you' },
  agent: { label: 'Agent memory', eyebrow: 'Private agent context' },
  workspace: { label: 'Workspace', eyebrow: 'Shared workspace context' },
  organization: { label: 'Organization', eyebrow: 'Shared internal standards' },
};

function scopeFromParam(value: string | null): MemoryScope {
  return value === 'agent' || value === 'workspace' || value === 'organization' ? value : 'user';
}

function formatDate(value: number): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : 'Not yet updated';
}

async function readJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'include', cache: 'no-store', ...init });
  const payload = await response.json().catch(() => null) as MemoryResponse<T> | null;
  if (!response.ok || payload?.success !== true || !payload.data) throw new Error(payload?.error || 'Request failed.');
  return payload.data;
}

function queryForScope(scope: MemoryScope, agentId: string | null, workspaceId: string | null, collectionId?: string | null, includeArchived = false) {
  const query = new URLSearchParams({ scope });
  if (scope === 'agent' && agentId) query.set('agentId', agentId);
  if (scope === 'workspace' && workspaceId) query.set('workspaceId', workspaceId);
  if (collectionId) query.set('collectionId', collectionId);
  if (includeArchived) query.set('includeArchived', '1');
  return query;
}

export function MemorySettingsPanel() {
  const searchParams = useSearchParams();
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const workspaceId = searchParams.get('workspaceId') || activeWorkspace?.id || null;
  const [agentId, setAgentId] = useState<string | null>(() => searchParams.get('agentId'));
  const [scope, setScope] = useState<MemoryScope>(() => scopeFromParam(searchParams.get('scope')));
  const [agentOwners, setAgentOwners] = useState<AgentMemoryOwner[]>([]);
  const [ownersLoading, setOwnersLoading] = useState(true);
  const [transferTargetAgentId, setTransferTargetAgentId] = useState('');
  const [ownerOperation, setOwnerOperation] = useState<string | null>(null);
  const [agentDeletionDialogOpen, setAgentDeletionDialogOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [permissions, setPermissions] = useState<MemoryPermissions | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [entryQuery, setEntryQuery] = useState('');
  const [entrySort, setEntrySort] = useState<'priority' | 'updated' | 'lastUsed'>('priority');
  const [historyForEntryId, setHistoryForEntryId] = useState<string | null>(null);
  const [entryHistory, setEntryHistory] = useState<MemoryEvent[]>([]);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [runtimeDraftChanged, setRuntimeDraftChanged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importEntries, setImportEntries] = useState<string[] | null>(null);
  const [deletionDialogOpen, setDeletionDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const selectedProvider = useMemo(
    () => settings?.providers.find((provider) => provider.installationId === settings.providerInstallationId) ?? null,
    [settings],
  );
  const selectedAgentOwner = useMemo(() => agentOwners.find((owner) => owner.agentId === agentId) ?? null, [agentId, agentOwners]);
  const activeTransferTargets = useMemo(() => agentOwners.filter((owner) => owner.status === 'active' && owner.agentId !== agentId), [agentId, agentOwners]);
  const agentMemoryReadOnly = scope === 'agent' && selectedAgentOwner?.status === 'deleted';
  const canUseScope = scope === 'agent' ? Boolean(agentId && selectedAgentOwner) : scope !== 'workspace' || Boolean(workspaceId);
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
    setAgentId(nextAgentId);
    setSelectedCollectionId(null);
    setEntries([]);
    setTransferTargetAgentId('');
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'memory');
    url.searchParams.set('scope', 'agent');
    url.searchParams.set('agentId', nextAgentId);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

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
    if (!canUseScope) {
      setCollections([]);
      setEntries([]);
      setSelectedCollectionId(null);
      return;
    }
    const data = await readJson<{ collections: Collection[]; entries: Entry[]; permissions: MemoryPermissions }>(`/api/memory?${query.toString()}`);
    setCollections(data.collections);
    setPermissions(data.permissions);
    const selected = preferredCollectionId && data.collections.some((collection) => collection.id === preferredCollectionId)
      ? preferredCollectionId
      : data.collections[0]?.id ?? null;
    setSelectedCollectionId(selected);
  }, [canUseScope, query]);

  const loadEntries = useCallback(async (collectionId: string | null) => {
    if (!collectionId || !canUseScope) {
      setEntries([]);
      return;
    }
    const data = await readJson<{ entries: Entry[] }>(`/api/memory?${queryForScope(scope, agentId, workspaceId, collectionId, showArchived).toString()}`);
    setEntries(data.entries);
  }, [agentId, canUseScope, scope, showArchived, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      Promise.all([loadSettings(), loadAgentOwners(), loadCollections()])
        .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Unable to load memory.'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [loadAgentOwners, loadCollections, loadSettings]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadEntries(selectedCollectionId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Unable to load entries.'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadEntries, selectedCollectionId]);

  const setScopeWithUrl = (nextScope: MemoryScope) => {
    setScope(nextScope);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'memory');
    url.searchParams.set('scope', nextScope);
    if (nextScope === 'workspace' && workspaceId) url.searchParams.set('workspaceId', workspaceId);
    if (nextScope === 'agent' && agentId) url.searchParams.set('agentId', agentId);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      if (settings.canManageMemoryRuntime && (runtimeDraftChanged || !settings.runtimeConfigured)) {
        if (!settings.providerInstallationId || !settings.modelId || !settings.catalogRevision) {
          throw new Error('Choose a ready provider and model before verifying the organization Memory Reviewer.');
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
      }
      const data = await readJson<MemorySettings>('/api/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          automaticMemoryEnabled: settings.automaticMemoryEnabled,
          memoryPromptMaxTokens: settings.memoryPromptMaxTokens,
          sensitiveMemoryEnabled: settings.sensitiveMemoryEnabled,
        }),
      });
      setSettings(data); setRuntimeDraftChanged(false); setNotice(settings.canManageMemoryRuntime ? 'Memory Reviewer verified and settings saved.' : 'Personal memory settings saved.');
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'Unable to save settings.'); }
    finally { setSaving(false); }
  };

  const refreshScope = async () => {
    await loadCollections(selectedCollectionId);
    await loadEntries(selectedCollectionId);
  };

  const addEntry = async () => {
    if (!draft.trim()) return;
    setAdding(true); setError(null); setNotice(null);
    try {
      await readJson('/api/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, agentId, workspaceId, content: draft }),
      });
      setDraft(''); setNotice(scope === 'workspace' || scope === 'organization' ? 'Memory suggestion created for review.' : 'Memory saved.');
      await refreshScope();
    } catch (addError) { setError(addError instanceof Error ? addError.message : 'Unable to add memory.'); }
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
          body: JSON.stringify({ scope, agentId, workspaceId, action, content: action === 'update' ? editingContent : undefined }),
        });
      }
      setEditingId(null); setNotice(action === 'publish' ? 'Suggestion published.' : action === 'restore' ? 'Memory restored.' : action === 'archive' ? 'Memory archived.' : 'Memory updated.');
      await refreshScope();
    } catch (mutationError) { setError(mutationError instanceof Error ? mutationError.message : 'Unable to update memory.'); }
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
    } catch (historyError) { setError(historyError instanceof Error ? historyError.message : 'Unable to load memory history.'); }
  };

  const exportCurrentCollection = () => {
    const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId);
    const content = JSON.stringify({ exportedAt: new Date().toISOString(), scope, collection: selectedCollection, entries }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `canvas-memory-${scope}-${selectedCollection?.category || 'export'}.json`; anchor.click();
    URL.revokeObjectURL(url);
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
            <div className="flex items-center gap-2 text-primary"><BrainCircuit className="size-5" /><span className="text-xs font-bold uppercase tracking-[0.18em]">Persistent context</span></div>
            <CardTitle className="text-2xl tracking-tight">Memory Manager</CardTitle>
            <CardDescription className="max-w-2xl text-sm leading-6">A dedicated <strong>memory-manager</strong> worker reviews only new user turns. It is isolated from chat tools and uses the model you choose below—never a hidden chat-model fallback.</CardDescription>
          </div>
          <Badge variant={settings?.review.status === 'awaiting_model_configuration' ? 'outline' : 'secondary'} className="w-fit gap-1.5 px-3 py-1.5"><Clock3 className="size-3.5" />{settings?.review.status === 'awaiting_model_configuration' ? 'Model setup needed' : `${settings?.review.count ?? 0} review job(s)`}</Badge>
        </CardHeader>
      </Card>

      {error ? <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">{notice}</p> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Memory scope">
            {(Object.keys(SCOPE_COPY) as MemoryScope[]).map((item) => (
              <Button key={item} variant={scope === item ? 'default' : 'outline'} size="sm" onClick={() => setScopeWithUrl(item)} disabled={item === 'workspace' && !workspaceId}>{SCOPE_COPY[item].label}</Button>
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

          <Card>
            <CardHeader className="space-y-1"><CardTitle className="text-base">{SCOPE_COPY[scope].label}</CardTitle><CardDescription>{SCOPE_COPY[scope].eyebrow}. Published shared memory is visible to readers; pending suggestions need a manager’s approval.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading memory…</p> : null}
              {!loading && collections.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-5 text-sm text-muted-foreground">No collection exists yet. Add a concise fact below to begin.</p> : null}
              {collections.length > 0 ? <div className="grid gap-2 md:grid-cols-2">{collections.map((collection) => <button type="button" key={collection.id} onClick={() => setSelectedCollectionId(collection.id)} className={cn('rounded-lg border p-3 text-left transition-colors hover:bg-muted/50', selectedCollectionId === collection.id && 'border-primary bg-primary/5 shadow-sm')}><div className="flex items-start justify-between gap-2"><span className="font-medium">{collection.title}</span>{collection.pendingCount > 0 ? <Badge variant="outline">{collection.pendingCount} pending</Badge> : null}</div><p className="mt-1 text-xs text-muted-foreground">{collection.category} · {collection.entryCount} entries · {formatDate(collection.updatedAt)}</p></button>)}</div> : null}
              {selectedCollectionId ? <div className="flex justify-end"><Button variant="ghost" size="sm" onClick={exportCurrentCollection}><Download className="mr-2 size-4" />Export collection</Button></div> : null}
            </CardContent>
          </Card>

          {scope === 'user' ? <Card className="border-dashed">
            <CardHeader><CardTitle className="text-base">Import or remove private memory</CardTitle><CardDescription>Import only a Canvas memory export you recognize. Shared workspace and organization memory are never imported from this control.</CardDescription></CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <input ref={importInputRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void readImportFile(event.target.files?.[0] ?? null)} />
              <Button variant="outline" onClick={() => importInputRef.current?.click()}><Upload className="mr-2 size-4" />Import JSON</Button>
              <Button variant="destructive" onClick={() => setDeletionDialogOpen(true)}><Trash2 className="mr-2 size-4" />Delete all private memory</Button>
            </CardContent>
          </Card> : null}

          <Card>
            <CardHeader><CardTitle className="text-base">Add a durable fact</CardTitle><CardDescription>Keep it atomic and useful across future conversations. Secrets, session logs, and temporary tasks are rejected.</CardDescription></CardHeader>
            <CardContent className="space-y-3"><Textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={800} placeholder="e.g. Prefers short, decisive weekly updates." disabled={agentMemoryReadOnly} /><div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{agentMemoryReadOnly ? 'Deleted-agent memory is read-only until transferred.' : `${draft.length}/800`}</span><Button onClick={() => void addEntry()} disabled={!draft.trim() || adding || !canUseScope || agentMemoryReadOnly}>{adding ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />}{scope === 'workspace' || scope === 'organization' ? 'Suggest memory' : 'Save memory'}</Button></div></CardContent>
          </Card>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">{entries.length > 0 ? <Input aria-label="Search memory" value={entryQuery} onChange={(event) => setEntryQuery(event.target.value)} placeholder="Search this collection" className="max-w-sm" /> : null}<select aria-label="Sort memory" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={entrySort} onChange={(event) => setEntrySort(event.target.value as 'priority' | 'updated' | 'lastUsed')}><option value="priority">Priority</option><option value="updated">Last updated</option><option value="lastUsed">Last used</option></select>{permissions?.canArchive ? <Button size="sm" variant="outline" onClick={() => setShowArchived((value) => !value)}>{showArchived ? 'Hide archived' : 'Show archived'}</Button> : null}</div>
            {visibleEntries.map((entry) => <Card key={entry.id} className={entry.status === 'pending' ? 'border-amber-500/40 bg-amber-500/5' : entry.status === 'archived' ? 'border-dashed opacity-75' : ''}><CardContent className="pt-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1">{editingId === entry.id ? <Textarea value={editingContent} onChange={(event) => setEditingContent(event.target.value)} maxLength={800} /> : <p className="whitespace-pre-wrap text-sm leading-6">{entry.content}</p>}<div className="mt-2 flex gap-2"><Badge variant={entry.status === 'published' ? 'secondary' : 'outline'}>{entry.status}</Badge><span className="text-xs text-muted-foreground">Priority {entry.priority}</span></div></div><div className="flex shrink-0 flex-wrap justify-end gap-1">{!agentMemoryReadOnly && entry.status === 'pending' && permissions?.canPublish ? <Button size="icon" variant="outline" title="Publish" onClick={() => void mutateEntry(entry, 'publish')}><Send className="size-4" /></Button> : null}{!agentMemoryReadOnly && entry.status === 'archived' && permissions?.canArchive ? <Button size="icon" variant="ghost" title="Restore" onClick={() => void mutateEntry(entry, 'restore')}><RotateCcw className="size-4" /></Button> : null}{!agentMemoryReadOnly && entry.status !== 'archived' && permissions?.canUpdatePublished ? editingId === entry.id ? <Button size="icon" title="Save" onClick={() => void mutateEntry(entry, 'update')}><Check className="size-4" /></Button> : <Button size="icon" variant="ghost" title="Edit" onClick={() => { setEditingId(entry.id); setEditingContent(entry.content); }}><Pencil className="size-4" /></Button> : null}{!agentMemoryReadOnly && entry.status !== 'archived' && permissions?.canArchive ? <Button size="icon" variant="ghost" title="Archive" onClick={() => void mutateEntry(entry, 'archive')}><Archive className="size-4" /></Button> : null}</div></div><Button className="mt-3 px-0" size="sm" variant="link" onClick={() => void toggleEntryHistory(entry)}>{historyForEntryId === entry.id ? 'Hide history' : 'History'}</Button>{historyForEntryId === entry.id ? <div className="mt-2 space-y-1 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">{entryHistory.map((event) => <p key={event.id}><span className="font-medium text-foreground">{event.action}</span> · {event.actorType}{event.decisionCode ? ` · ${event.decisionCode.replaceAll('_', ' ')}` : ''} · {formatDate(event.createdAt)}</p>)}</div> : null}</CardContent></Card>)}
            {!loading && selectedCollectionId && entries.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-5 text-sm text-muted-foreground">This collection has no published entries you can view.</p> : null}
            {!loading && entries.length > 0 && visibleEntries.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-5 text-sm text-muted-foreground">No memory entries match this search.</p> : null}
          </div>
        </div>

        <Card className="h-fit xl:sticky xl:top-6"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" />Memory review runtime</CardTitle><CardDescription>Runs every 10 user turns, plus a 15-minute idle flush. Provider and model are managed once for the organization by an administrator.</CardDescription></CardHeader><CardContent className="space-y-5">
          {settings ? <><div className="flex items-center justify-between gap-3"><div><Label htmlFor="automatic-memory">Automatic memory</Label><p className="text-xs text-muted-foreground">Schedules the reserved reviewer.</p></div><Switch id="automatic-memory" checked={settings.automaticMemoryEnabled} onCheckedChange={(checked) => setSettings({ ...settings, automaticMemoryEnabled: checked })} /></div>
          <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">{settings.canManageMemoryRuntime ? 'Administrator setting · changing it runs a live model verification before it is saved.' : 'Managed by your organization administrator. You can still control whether automatic memory runs for your account.'}</div>
          <div className="space-y-2"><Label htmlFor="memory-provider">Organization provider</Label><select id="memory-provider" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={settings.providerInstallationId ?? ''} disabled={!settings.canManageMemoryRuntime || saving} onChange={(event) => { setSettings({ ...settings, providerInstallationId: event.target.value || null, modelId: null }); setRuntimeDraftChanged(true); }}><option value="">Choose a provider</option>{settings.providers.map((provider) => <option value={provider.installationId} key={provider.installationId}>{provider.name}</option>)}</select></div>
          <div className="space-y-2"><Label htmlFor="memory-model">Memory Reviewer model</Label><select id="memory-model" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={settings.modelId ?? ''} disabled={!settings.canManageMemoryRuntime || !selectedProvider || saving} onChange={(event) => { setSettings({ ...settings, modelId: event.target.value || null }); setRuntimeDraftChanged(true); }}><option value="">Choose a model</option>{selectedProvider?.models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}</select><p className="text-xs text-muted-foreground">{settings.runtimeConfigured && !runtimeDraftChanged ? 'Verified for the current provider catalog.' : settings.canManageMemoryRuntime ? 'Verification required before queue work can run.' : 'The queue waits safely until an administrator verifies a model.'}</p></div>
          <div className="space-y-2"><Label htmlFor="memory-budget">Prompt budget (tokens)</Label><Input id="memory-budget" type="number" min={0} max={4000} value={settings.memoryPromptMaxTokens} onChange={(event) => setSettings({ ...settings, memoryPromptMaxTokens: Number(event.target.value) })} /><p className="text-xs text-muted-foreground">Hard limit: 4,000 tokens and at most 10% of the usable context.</p></div>
          <Button className="w-full" onClick={() => void saveSettings()} disabled={saving}>{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}{settings.canManageMemoryRuntime && (runtimeDraftChanged || !settings.runtimeConfigured) ? 'Verify reviewer and save' : 'Save memory settings'}</Button></> : <p className="text-sm text-muted-foreground">Loading settings…</p>}
        </CardContent></Card>
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
