'use client';

import { useCallback, useEffect, useMemo, useState, startTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Plus, RefreshCw, Save, Stethoscope, Trash2, RotateCcw, ChevronDown, Wrench, Search, X, Clock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { PiProviderSetupCard } from './PiProviderSetupCard';
import { Switch } from '@/components/ui/switch';
import {
  resolveEnabledToolNames,
  serializeEnabledToolNames,
  isDefaultToolsConfig,
  getDefaultEnabledToolNames,
} from '@/app/lib/pi/enabled-tools';
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditor';

const MANAGED_FILES = ['AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;

type ManagedFileName = (typeof MANAGED_FILES)[number];

type AgentConfigReadiness = {
  activeProviderId: string;
  activeProviderReady: boolean;
  pi?: {
    activeProvider: string;
    model: string;
    ready: boolean;
    authSet: boolean;
    issues: string[];
  };
};

type DoctorResult = {
  checkedAt: string;
  summary: {
    ready: boolean;
    errors: number;
    warnings: number;
  };
  readiness: AgentConfigReadiness;
  promptDiagnostics: {
    loadedFiles: ManagedFileName[];
    includedFiles: ManagedFileName[];
    emptyFiles: ManagedFileName[];
    usedFallback: boolean;
    fallbackReason: 'all-empty' | 'read-failed' | null;
  };
  qmd: {
    enabled: boolean;
    ready: boolean;
    binaryAvailable: boolean;
    defaultMode: 'search' | 'vsearch' | 'query';
    allowExpensiveQueryMode: boolean;
    collections: Array<{
      name: string;
      sourceType: 'workspace-text' | 'workspace-derived';
      path: string;
      present: boolean;
    }>;
    lastUpdateAt: string | null;
    lastUpdateSuccess: boolean;
    lastEmbedAt: string | null;
    derivedDocxIndexing: {
      enabled: boolean;
      healthy: boolean;
      lastRunAt: string | null;
      extractedCount: number;
      updatedCount: number;
      errorCount: number;
      warningCount: number;
    };
    issues: string[];
  };
};

type SessionItem = {
  id: number;
  sessionId: string;
  title: string;
  model: string;
  createdAt: string;
  creator?: {
    name?: string | null;
    email?: string | null;
  };
};

type ToolMetadata = {
  name: string;
  label: string;
  description: string;
  group?: string;
  parameters?: string[];
  planningModeAllowed?: boolean;
  defaultEnabled?: boolean;
  notes?: string[];
};

type PiConfigData = {
  activeProvider: string;
  providers: Record<string, { enabledTools: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
};

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });

  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: T;
    sessions?: SessionItem[];
  };

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return (payload.data as T) ?? (payload as unknown as T);
}

export function AgentSettingsPanel() {
  const locale = useLocale();
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();

  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);

  const [filesLoading, setFilesLoading] = useState(true);
  const [filesSaving, setFilesSaving] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesSuccess, setFilesSuccess] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<ManagedFileName, string> | null>(null);
  const [fileDrafts, setFileDrafts] = useState<Record<ManagedFileName, string>>({
    'AGENTS.md': '',
    'IDENTITY.md': '',
    'USER.md': '',
    'MEMORY.md': '',
    'SOUL.md': '',
    'TOOLS.md': '',
    'HEARTBEAT.md': '',
  });
  const [activeFile, setActiveFile] = useState<ManagedFileName>('AGENTS.md');
  const [filesResetting, setFilesResetting] = useState(false);

  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<'current' | 'all' | null>(null);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [createTitle, setCreateTitle] = useState('');
  const [sessionPendingId, setSessionPendingId] = useState<string | null>(null);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});

  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [openToolRows, setOpenToolRows] = useState<Record<string, boolean>>({});
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsPiConfig, setToolsPiConfig] = useState<PiConfigData | null>(null);
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [activeToolGroups, setActiveToolGroups] = useState<Set<string>>(new Set());

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);

    try {
      const payload = await fetchJson<{ files: Record<ManagedFileName, string> }>('/api/agents/files');
      setFiles(payload.files);
      setFileDrafts(payload.files);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : t('agentPanel.files.errors.load'));
    } finally {
      setFilesLoading(false);
    }
  }, [t]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionError(null);

    try {
      const payload = await fetch('/api/sessions', {
        credentials: 'include',
        cache: 'no-store',
      });
      const body = (await payload.json()) as {
        success?: boolean;
        error?: string;
        sessions?: SessionItem[];
      };

      if (!payload.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.sessions.errors.load'));
      }

      const nextSessions = body.sessions || [];
      setSessions(nextSessions);
      setRenameDrafts(
        Object.fromEntries(nextSessions.map((item) => [item.sessionId, item.title || ''])) as Record<string, string>,
      );
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.load'));
    } finally {
      setSessionsLoading(false);
    }
  }, [t]);

  const loadTools = useCallback(async () => {
    setToolsLoading(true);
    setToolsError(null);

    try {
      const payload = await fetchJson<{ tools: ToolMetadata[] }>('/api/agents/tools');
      setAvailableTools(payload.tools);
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.loading'));
    } finally {
      setToolsLoading(false);
    }
  }, [t]);

  const loadToolsConfig = useCallback(async () => {
    try {
      const payload = await fetchJson<{ piConfig: PiConfigData }>('/api/agents/config');
      setToolsPiConfig(payload.piConfig);
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.saveError'));
    }
  }, [t]);

  const runDoctor = useCallback(async () => {
    setDoctorRunning(true);
    setDoctorError(null);

    try {
      const payload = await fetchJson<DoctorResult>('/api/agents/doctor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ livePing: true }),
      });
      setDoctorResult(payload);
    } catch (error) {
      setDoctorError(error instanceof Error ? error.message : t('agentPanel.doctor.errors.run'));
    } finally {
      setDoctorRunning(false);
    }
  }, [t]);

  useEffect(() => {
    startTransition(() => {
      void loadFiles();
      void loadSessions();
      void loadTools();
      void loadToolsConfig();
    });
  }, [loadFiles, loadSessions, loadTools, loadToolsConfig]);

  useEffect(() => {
    if (searchParams.get('panel') === 'doctor' && !doctorResult && !doctorRunning) {
      startTransition(() => { void runDoctor(); });
    }
  }, [searchParams, doctorResult, doctorRunning, runDoctor]);

  const saveActiveFile = async () => {
    setFilesSaving(true);
    setFilesError(null);
    setFilesSuccess(null);

    try {
      const content = fileDrafts[activeFile] ?? '';
      const payload = await fetchJson<{ fileName: ManagedFileName; content: string }>('/api/agents/files', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: activeFile,
          content,
        }),
      });

      setFiles((current) => ({
        ...(current || fileDrafts),
        [payload.fileName]: payload.content,
      }));
      setFileDrafts((current) => ({
        ...current,
        [payload.fileName]: payload.content,
      }));
      setFilesSuccess(t('agentPanel.files.saved', { fileName: payload.fileName }));
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : t('agentPanel.files.errors.save'));
    } finally {
      setFilesSaving(false);
    }
  };

  const resetFile = async () => {
    if (!resetTarget) return;

    setFilesResetting(true);
    setFilesError(null);
    setFilesSuccess(null);

    try {
      if (resetTarget === 'current') {
        const payload = await fetchJson<{ fileName: ManagedFileName; content: string }>('/api/agents/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'reset',
            fileName: activeFile,
          }),
        });

        setFiles((current) => ({
          ...(current || fileDrafts),
          [payload.fileName]: payload.content,
        }));
        setFileDrafts((current) => ({
          ...current,
          [payload.fileName]: payload.content,
        }));
        setFilesSuccess(t('agentPanel.files.resetSuccess', { fileName: payload.fileName }));
      } else {
        const payload = await fetchJson<{ files: Array<{ fileName: ManagedFileName; content: string }> }>('/api/agents/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'reset',
          }),
        });

        const newFiles: Record<ManagedFileName, string> = { ...fileDrafts };
        for (const { fileName, content } of payload.files) {
          newFiles[fileName] = content;
        }

        setFiles((current) => ({
          ...(current || fileDrafts),
          ...newFiles,
        }));
        setFileDrafts(newFiles);
        setFilesSuccess(t('agentPanel.files.resetAllSuccess'));
      }
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : t('agentPanel.files.errors.reset'));
    } finally {
      setFilesResetting(false);
      setResetDialogOpen(false);
      setResetTarget(null);
    }
  };

  const openResetDialog = (target: 'current' | 'all') => {
    setResetTarget(target);
    setResetDialogOpen(true);
  };

  const createSession = async () => {
    setSessionPendingId('create');
    setSessionError(null);

    try {
      await fetchJson<{ session: SessionItem }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: createTitle.trim() || undefined }),
      });

      setCreateTitle('');
      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.create'));
    } finally {
      setSessionPendingId(null);
    }
  };

  const renameSession = async (sessionId: string) => {
    setSessionPendingId(sessionId);
    setSessionError(null);

    try {
      await fetchJson<{ session: { sessionId: string; title: string } }>('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          title: (renameDrafts[sessionId] || '').trim(),
        }),
      });

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.rename'));
    } finally {
      setSessionPendingId(null);
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (!window.confirm(t('agentPanel.sessions.confirmDeleteOne'))) {
      return;
    }

    setSessionPendingId(sessionId);
    setSessionError(null);

    try {
      const response = await fetch(`/api/sessions?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.sessions.errors.delete'));
      }

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.delete'));
    } finally {
      setSessionPendingId(null);
    }
  };

  const deleteAllSessions = async () => {
    if (!window.confirm(t('agentPanel.sessions.confirmDeleteAll'))) {
      return;
    }

    setSessionPendingId('delete-all');
    setSessionError(null);

    try {
      const response = await fetch('/api/sessions?all=true', {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.sessions.errors.deleteAll'));
      }

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.deleteAll'));
    } finally {
      setSessionPendingId(null);
    }
  };

  const getActiveEnabledTools = (): string[] => {
    if (!toolsPiConfig) return [];
    const activeProvider = toolsPiConfig.providers[toolsPiConfig.activeProvider];
    return activeProvider?.enabledTools ?? [];
  };

  const isToolEnabled = (toolName: string): boolean => {
    const enabledTools = getActiveEnabledTools();
    const allNames = availableTools.map((t) => t.name);
    
    // If the user has never configured tools (empty config), use defaults
    if (isDefaultToolsConfig(enabledTools)) {
      const defaultSet = getDefaultEnabledToolNames(allNames);
      return defaultSet.has(toolName);
    }
    
    const enabledSet = resolveEnabledToolNames(allNames, enabledTools);
    return enabledSet.has(toolName);
  };

  const saveToolsConfig = async (newEnabledTools: string[]) => {
    if (!toolsPiConfig) return;
    setToolsSaving(true);
    setToolsError(null);

    try {
      const nextConfig = { ...toolsPiConfig };
      const providerId = nextConfig.activeProvider;
      nextConfig.providers = {
        ...nextConfig.providers,
        [providerId]: {
          ...nextConfig.providers[providerId],
          enabledTools: newEnabledTools,
        },
      };

      const payload = await fetchJson<{ piConfig: PiConfigData }>('/api/agents/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ piConfig: nextConfig }),
      });
      setToolsPiConfig(payload.piConfig);
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : t('agentPanel.tools.saveError'));
    } finally {
      setToolsSaving(false);
    }
  };

  const handleToolToggle = (toolName: string, enabled: boolean) => {
    const currentEnabled = getActiveEnabledTools();
    const allNames = availableTools.map((t) => t.name);
    let newEnabledTools: string[];

    if (enabled) {
      const enabledSet = resolveEnabledToolNames(allNames, currentEnabled);
      enabledSet.add(toolName);
      newEnabledTools = serializeEnabledToolNames(enabledSet, allNames);
    } else {
      const enabledSet = resolveEnabledToolNames(allNames, currentEnabled);
      enabledSet.delete(toolName);
      newEnabledTools = serializeEnabledToolNames(enabledSet, allNames);
    }

    void saveToolsConfig(newEnabledTools);
  };

  const handleEnableAll = () => {
    void saveToolsConfig([]);
  };

  const handleDisableAll = () => {
    void saveToolsConfig(['__none__']);
  };

  const toolGroups = useMemo(() => {
    const groups = [...new Set(availableTools.map(t => t.group).filter(Boolean))] as string[];
    return groups.sort();
  }, [availableTools]);

  const filteredTools = useMemo(() => {
    let result = availableTools;
    if (activeToolGroups.size > 0) {
      result = result.filter(t => t.group && activeToolGroups.has(t.group));
    }
    if (toolSearchQuery.trim()) {
      const q = toolSearchQuery.trim().toLowerCase();
      result = result.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.group && t.group.toLowerCase().includes(q))
      );
    }
    return result;
  }, [availableTools, activeToolGroups, toolSearchQuery]);

  const toggleToolGroup = (group: string) => {
    setActiveToolGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const deleteOlderSessions = async () => {
    setSessionPendingId('delete-older');
    setSessionError(null);

    try {
      const countResponse = await fetch('/api/sessions?countOnly=true&olderThanDays=14', {
        credentials: 'include',
      });
      const countBody = (await countResponse.json()) as { success?: boolean; count?: number; error?: string };
      if (!countResponse.ok || !countBody.success) {
        throw new Error(countBody.error || t('agentPanel.sessions.errors.deleteOlder'));
      }

      const olderCount = countBody.count ?? 0;
      if (olderCount === 0) {
        setSessionError(t('agentPanel.sessions.noOlderSessions'));
        return;
      }

      if (!window.confirm(t('agentPanel.sessions.deleteOlderConfirm', { count: olderCount }))) {
        return;
      }

      const response = await fetch('/api/sessions?olderThanDays=14', {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await response.json()) as { success?: boolean; error?: string; count?: number };
      if (!response.ok || !body.success) {
        throw new Error(body.error || t('agentPanel.sessions.errors.deleteOlder'));
      }

      await loadSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t('agentPanel.sessions.errors.deleteOlder'));
    } finally {
      setSessionPendingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div id="onboarding-settings-agentSettings">
        <PiProviderSetupCard />
      </div>

      <Card id="onboarding-settings-tools">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            {t('agentPanel.tools.title')}
          </CardTitle>
          <CardDescription>{t('agentPanel.tools.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {toolsLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('agentPanel.tools.loading')}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9 pr-9"
                  placeholder={t('agentPanel.tools.searchPlaceholder')}
                  value={toolSearchQuery}
                  onChange={(e) => setToolSearchQuery(e.target.value)}
                />
                {toolSearchQuery && (
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setToolSearchQuery('')}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {toolGroups.map((group) => (
                  <Button
                    key={group}
                    size="sm"
                    variant={activeToolGroups.has(group) ? 'default' : 'outline'}
                    onClick={() => toggleToolGroup(group)}
                    className="h-7 text-xs"
                  >
                    {group}
                    {activeToolGroups.has(group) && <X className="ml-1 h-3 w-3" />}
                  </Button>
                ))}
                {toolGroups.length > 0 && activeToolGroups.size > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={() => setActiveToolGroups(new Set())}
                  >
                    {t('agentPanel.tools.allGroups')}
                  </Button>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {t('agentPanel.tools.showingCount', { shown: filteredTools.length, total: availableTools.length })}
                </span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={handleEnableAll} disabled={toolsSaving}>
                  {t('agentPanel.tools.enableAll')}
                </Button>
                <Button size="sm" variant="outline" onClick={handleDisableAll} disabled={toolsSaving}>
                  {t('agentPanel.tools.disableAll')}
                </Button>
              </div>
              <div className="max-h-[400px] overflow-y-auto space-y-2">
                {filteredTools.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">{t('agentPanel.tools.noMatchingTools')}</p>
                ) : (
                  filteredTools.map((tool) => {
                    const isOpen = openToolRows[tool.name] ?? false;
                    return (
                      <Collapsible
                        key={tool.name}
                        open={isOpen}
                        onOpenChange={(open) => setOpenToolRows((current) => ({ ...current, [tool.name]: open }))}
                        className="rounded border border-border bg-background"
                      >
                        <div className="flex items-center gap-3 p-3">
                          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 text-left">
                            <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{tool.label || tool.name}</span>
                                {tool.group && <Badge variant="secondary">{tool.group}</Badge>}
                              </div>
                              <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{tool.name}</div>
                            </div>
                          </CollapsibleTrigger>
                          <Switch
                            checked={isToolEnabled(tool.name)}
                            onCheckedChange={(checked) => handleToolToggle(tool.name, checked)}
                            disabled={toolsSaving}
                            aria-label={tool.label || tool.name}
                          />
                        </div>
                        <CollapsibleContent>
                          <div className="border-t border-border px-10 py-3 text-sm">
                            <p className="text-muted-foreground">{tool.description || t('agentPanel.tools.noDescription')}</p>
                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                              <div>
                                <div className="text-xs font-semibold uppercase text-muted-foreground">{t('agentPanel.tools.parameters')}</div>
                                {tool.parameters && tool.parameters.length > 0 ? (
                                  <ul className="mt-2 space-y-1">
                                    {tool.parameters.map((parameter) => (
                                      <li key={parameter} className="break-words font-mono text-xs text-muted-foreground">{parameter}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="mt-2 text-xs text-muted-foreground">{t('agentPanel.tools.noParameters')}</p>
                                )}
                              </div>
                              <div>
                                <div className="text-xs font-semibold uppercase text-muted-foreground">{t('agentPanel.tools.runtime')}</div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <Badge variant={tool.planningModeAllowed ? 'secondary' : 'outline'}>
                                    {tool.planningModeAllowed ? t('agentPanel.tools.planningAllowed') : t('agentPanel.tools.planningBlocked')}
                                  </Badge>
                                  <Badge variant={tool.defaultEnabled ? 'secondary' : 'outline'}>
                                    {tool.defaultEnabled ? t('agentPanel.tools.defaultEnabled') : t('agentPanel.tools.defaultDisabled')}
                                  </Badge>
                                </div>
                                {tool.notes && tool.notes.length > 0 && (
                                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                                    {tool.notes.map((note) => (
                                      <li key={note}>{note}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    );
                  })
                )}
              </div>
            </div>
          )}
          {toolsError && <p className="text-sm text-destructive mt-2">{toolsError}</p>}
        </CardContent>
      </Card>

      <Card id="onboarding-settings-managedFiles">
        <CardHeader>
          <CardTitle>{t('agentPanel.files.title')}</CardTitle>
          <CardDescription>{t('agentPanel.files.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {filesLoading || !files ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('agentPanel.files.loading')}
            </div>
          ) : (
            <>
              <Tabs value={activeFile} onValueChange={(value) => setActiveFile(value as ManagedFileName)}>
                <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
                  {MANAGED_FILES.map((fileName) => (
                    <TabsTrigger key={fileName} value={fileName} className="border border-border data-[state=active]:bg-muted">
                      {fileName}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              <div
                data-testid="agent-managed-file-editor"
                className="h-[400px] overflow-hidden rounded-md border border-input"
              >
                <MarkdownEditor
                  value={fileDrafts[activeFile] ?? ''}
                  onChange={(nextValue) =>
                    setFileDrafts((current) => ({
                      ...current,
                      [activeFile]: nextValue,
                    }))
                  }
                />
              </div>

              {filesError && <p className="text-sm text-destructive">{filesError}</p>}
              {filesSuccess && <p className="text-sm text-primary">{filesSuccess}</p>}

              <div className="flex flex-wrap gap-2">
                <Button data-testid="agent-managed-file-save" onClick={() => void saveActiveFile()} disabled={filesSaving || filesResetting}>
                  {filesSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {t('agentPanel.files.save')}
                </Button>
                <Button variant="outline" onClick={() => void loadFiles()} disabled={filesLoading || filesSaving || filesResetting}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('agentPanel.files.reload')}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" disabled={filesLoading || filesSaving || filesResetting}>
                      {filesResetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                      {t('agentPanel.files.reset')}
                      <ChevronDown className="ml-2 h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => openResetDialog('current')}>
                      {t('agentPanel.files.resetCurrentFile')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openResetDialog('all')}>
                      {t('agentPanel.files.resetAllFiles')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resetTarget === 'all' ? t('agentPanel.files.confirmResetAllTitle') : t('agentPanel.files.confirmResetTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resetTarget === 'all' ? t('agentPanel.files.confirmResetAll') : t('agentPanel.files.confirmReset', { fileName: activeFile })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setResetDialogOpen(false); setResetTarget(null); }}>
              {tCommon('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void resetFile()}>
              {t('agentPanel.files.reset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader>
          <CardTitle>{t('agentPanel.sessions.title')}</CardTitle>
          <CardDescription>{t('agentPanel.sessions.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              className="flex-1 min-w-[200px]"
              placeholder={t('agentPanel.sessions.newSessionPlaceholder')}
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              disabled={sessionPendingId !== null}
            />
            <Button onClick={() => void createSession()} disabled={sessionPendingId !== null}>
              {sessionPendingId === 'create' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {t('agentPanel.sessions.new')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void deleteAllSessions()}
              disabled={sessionPendingId !== null || sessionsLoading || sessions.length === 0}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t('agentPanel.sessions.deleteAll')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void deleteOlderSessions()}
              disabled={sessionPendingId !== null || sessionsLoading}
            >
              {sessionPendingId === 'delete-older' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock className="mr-2 h-4 w-4" />}
              {t('agentPanel.sessions.deleteOlder')}
            </Button>
          </div>

          {sessionError && <p className="text-sm text-destructive">{sessionError}</p>}

          {sessionsLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('agentPanel.sessions.loading')}
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('agentPanel.sessions.empty')}</p>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {sessions.map((sessionItem) => {
                const isPending = sessionPendingId === sessionItem.sessionId;
                const creatorLabel =
                  sessionItem.creator?.name || sessionItem.creator?.email || t('agentPanel.sessions.unknownUser');

                return (
                  <div key={sessionItem.sessionId} className="rounded border border-border p-3 hover:bg-muted/10 transition-colors">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground uppercase tracking-wider font-bold">
                      <span>{sessionItem.sessionId}</span>
                      <span>{new Date(sessionItem.createdAt).toLocaleString(locale)}</span>
                    </div>

                    <div className="mb-2 grid gap-2 md:grid-cols-[1fr_auto_auto] md:items-center">
                      <Input
                        value={renameDrafts[sessionItem.sessionId] ?? ''}
                        onChange={(event) =>
                          setRenameDrafts((current) => ({
                            ...current,
                            [sessionItem.sessionId]: event.target.value,
                          }))
                        }
                        disabled={sessionPendingId !== null}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void renameSession(sessionItem.sessionId)}
                        disabled={sessionPendingId !== null}
                      >
                        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => void deleteSession(sessionItem.sessionId)}
                        disabled={sessionPendingId !== null}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="text-[10px] text-muted-foreground flex justify-between">
                      <span>{t('agentPanel.sessions.modelLabel')} {sessionItem.model}</span>
                      <span>{t('agentPanel.sessions.userLabel')} {creatorLabel}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('agentPanel.doctor.title')}</CardTitle>
          <CardDescription>{t('agentPanel.doctor.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => void runDoctor()} disabled={doctorRunning}>
            {doctorRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stethoscope className="mr-2 h-4 w-4" />}
            {t('agentPanel.doctor.run')}
          </Button>

          {doctorError && <p className="text-sm text-destructive">{doctorError}</p>}

          {doctorResult && (
            <div className="rounded border border-border bg-muted/40 p-3 text-sm">
              <p>
                {t('agentPanel.doctor.statusLabel')}{' '}
                <span className={doctorResult.summary.ready ? 'text-primary' : 'text-destructive'}>
                  {doctorResult.summary.ready ? t('agentPanel.doctor.ready') : t('agentPanel.doctor.issuesDetected')}
                </span>
              </p>
              <p>{t('agentPanel.doctor.errorsLabel')} {doctorResult.summary.errors}</p>
              <p>{t('agentPanel.doctor.warningsLabel')} {doctorResult.summary.warnings}</p>
              <p>{t('agentPanel.doctor.checkedLabel')} {new Date(doctorResult.checkedAt).toLocaleString(locale)}</p>
              <p>{t('agentPanel.doctor.promptFilesLoaded')} {doctorResult.promptDiagnostics.loadedFiles.join(', ') || t('agentPanel.doctor.none')}</p>
              <p>{t('agentPanel.doctor.promptFilesIncluded')} {doctorResult.promptDiagnostics.includedFiles.join(', ') || t('agentPanel.doctor.none')}</p>
              <p>{t('agentPanel.doctor.promptFilesEmpty')} {doctorResult.promptDiagnostics.emptyFiles.join(', ') || t('agentPanel.doctor.none')}</p>
              <p>
                {t('agentPanel.doctor.promptFallback')}{' '}
                <span className={doctorResult.promptDiagnostics.usedFallback ? 'text-destructive font-medium' : 'text-primary'}>
                  {doctorResult.promptDiagnostics.usedFallback
                    ? t('agentPanel.doctor.promptFallbackActive', {
                        reason: doctorResult.promptDiagnostics.fallbackReason || t('agentPanel.doctor.unknown'),
                      })
                    : t('agentPanel.doctor.promptFallbackInactive')}
                </span>
              </p>
              <div className="mt-3 rounded border border-border/70 bg-background/70 p-3">
                <p>
                  {t('agentPanel.doctor.qmdLabel')}{' '}
                  <span className={
                    !doctorResult.qmd.enabled
                      ? 'text-muted-foreground font-medium'
                      : doctorResult.qmd.ready
                        ? 'text-primary font-medium'
                        : 'text-destructive font-medium'
                  }>
                    {!doctorResult.qmd.enabled
                      ? t('agentPanel.doctor.disabledStatus')
                      : doctorResult.qmd.ready
                        ? t('agentPanel.doctor.ready')
                        : t('agentPanel.doctor.needsAttention')}
                  </span>
                </p>
                {doctorResult.qmd.enabled && (
                  <>
                    <p>{t('agentPanel.doctor.qmdBinary')} {doctorResult.qmd.binaryAvailable ? t('agentPanel.doctor.available') : t('agentPanel.doctor.missing')}</p>
                    <p>{t('agentPanel.doctor.defaultMode')} {doctorResult.qmd.defaultMode}</p>
                    <p>{t('agentPanel.doctor.expensiveQueryMode')} {doctorResult.qmd.allowExpensiveQueryMode ? t('agentPanel.doctor.enabled') : t('agentPanel.doctor.disabled')}</p>
                    <p>{t('agentPanel.doctor.collections')} {doctorResult.qmd.collections.map((collection) => collection.name).join(', ') || t('agentPanel.doctor.none')}</p>
                    <p>{t('agentPanel.doctor.lastQmdUpdate')} {doctorResult.qmd.lastUpdateAt ? new Date(doctorResult.qmd.lastUpdateAt).toLocaleString(locale) : t('agentPanel.doctor.noSuccessfulUpdateYet')}</p>
                    <p>{t('agentPanel.doctor.lastQmdEmbed')} {doctorResult.qmd.lastEmbedAt ? new Date(doctorResult.qmd.lastEmbedAt).toLocaleString(locale) : t('agentPanel.doctor.notRecordedYet')}</p>
                    <p>
                      {t('agentPanel.doctor.derivedDocxIndexing')}{' '}
                      <span className={doctorResult.qmd.derivedDocxIndexing.enabled && doctorResult.qmd.derivedDocxIndexing.healthy ? 'text-primary font-medium' : 'text-destructive font-medium'}>
                        {doctorResult.qmd.derivedDocxIndexing.enabled
                          ? doctorResult.qmd.derivedDocxIndexing.healthy
                            ? t('agentPanel.doctor.healthy')
                            : t('agentPanel.doctor.withIssues')
                          : t('agentPanel.doctor.disabled')}
                      </span>
                    </p>
                    <p>{t('agentPanel.doctor.derivedLastRun')} {doctorResult.qmd.derivedDocxIndexing.lastRunAt ? new Date(doctorResult.qmd.derivedDocxIndexing.lastRunAt).toLocaleString(locale) : t('agentPanel.doctor.notRunYet')}</p>
                    <p>{t('agentPanel.doctor.derivedFiles')} {doctorResult.qmd.derivedDocxIndexing.extractedCount}</p>
                    <p>{t('agentPanel.doctor.derivedUpdates')} {doctorResult.qmd.derivedDocxIndexing.updatedCount}</p>
                    <p>{t('agentPanel.doctor.derivedWarnings')} {doctorResult.qmd.derivedDocxIndexing.warningCount}</p>
                    <p>{t('agentPanel.doctor.derivedErrors')} {doctorResult.qmd.derivedDocxIndexing.errorCount}</p>
                  </>
                )}
              </div>
              {doctorResult.readiness.pi?.issues.map((issue, idx) => (
                <p key={idx} className="text-destructive font-medium mt-1">• {issue}</p>
              ))}
              {doctorResult.qmd.enabled && doctorResult.qmd.issues.map((issue, idx) => (
                <p key={`qmd-${idx}`} className="text-destructive font-medium mt-1">• {issue}</p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
