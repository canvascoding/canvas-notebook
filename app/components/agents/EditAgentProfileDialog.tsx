'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  FileText,
  Loader2,
  LockKeyhole,
  Plug,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { AgentFormSection } from '@/app/components/agents/AgentFormSection';
import { AgentGrantsEditor } from '@/app/components/agents/AgentGrantsEditor';
import { AgentIconPickerDialog } from '@/app/components/agents/AgentIconPickerDialog';
import { AgentMembersEditor } from '@/app/components/agents/AgentMembersEditor';
import {
  fetchAgentFormJson,
  getExplicitEnabledToolsFromConfig,
  isExactAgentDeleteConfirmation,
} from '@/app/components/agents/agent-form-client';
import {
  AgentConnectionsPicker,
  AgentPluginsPicker,
  AgentRelevantSkillsPicker,
  type AgentPluginSelection,
} from '@/app/components/settings/AgentCapabilityPickers';
import {
  AgentCatalogModelOverrideEditor,
  initialAgentCatalogSelection,
  isAgentCatalogSelectionValid,
  type AgentCatalogModelSelection,
} from '@/app/components/settings/AgentCatalogModelOverrideEditor';
import {
  AgentManagedFilesEditor,
  type ManagedFileName,
} from '@/app/components/settings/AgentManagedFilesCard';
import { readAdminRuntimeCatalog } from '@/app/components/settings/ai-runtime/catalog-client';
import { AgentToolsEditor, type ToolMetadata } from '@/app/components/settings/AgentToolsCard';
import type { AiAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/types';
import type { AgentIconId } from '@/app/lib/agents/icons';
import type { AgentProfile } from '@/app/lib/chat/types';
import {
  disableToolInConfig,
  enableToolInConfig,
  getDefaultEnabledToolNames,
  isDefaultToolsConfig,
  resolveEnabledToolNames,
} from '@/app/lib/pi/enabled-tools';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const EDIT_AGENT_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const satisfies readonly ManagedFileName[];

const EMPTY_FILES: Record<ManagedFileName, string> = {
  'AGENTS.md': '',
  'USER.md': '',
  'MEMORY.md': '',
  'SOUL.md': '',
  'TOOLS.md': '',
};

type AgentCapabilityBinding = {
  resourceType: 'skill' | 'plugin' | 'connection';
  resourceId: string;
  name: string;
  scopeType: 'system' | 'organization' | 'user';
};

type AgentInspection = {
  agent: AgentProfile;
  access: NonNullable<AgentProfile['access']>;
  bindings: AgentCapabilityBinding[];
  files?: Partial<Record<ManagedFileName, string>>;
};

type AgentToolsPayload = {
  tools: ToolMetadata[];
  config: {
    enabledTools: string[];
  };
};

type AgentDeletionPreview = {
  agent: AgentProfile & { revision: number };
  impacts: {
    sessions: number;
    members: number;
    grants: number;
    capabilityBindings: number;
    managedFiles: string[];
    memoryCollections: number;
    memoryEntries: number;
    memoryPolicy: 'retained';
  };
  confirmationToken: string;
};

type EditAgentProfileDialogProps = {
  open: boolean;
  agent: AgentProfile | null;
  canManageAgentDefaults: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (agent: AgentProfile) => void | Promise<void>;
  onDeleted: (agentId: string) => void | Promise<void>;
};

function selectionFromAgent(agent: AgentProfile): AgentCatalogModelSelection | null {
  const thinkingLevel = agent.defaultThinking;
  if (
    !agent.defaultProviderInstallationId
    || !agent.defaultProvider
    || !agent.defaultModel
    || !thinkingLevel
  ) {
    return null;
  }
  return {
    providerInstallationId: agent.defaultProviderInstallationId,
    providerId: agent.defaultProvider,
    modelId: agent.defaultModel,
    thinkingLevel,
  };
}

function filesFromInspection(files?: Partial<Record<ManagedFileName, string>>): Record<ManagedFileName, string> {
  return {
    ...EMPTY_FILES,
    ...files,
  };
}

export function EditAgentProfileDialog({
  open,
  agent,
  canManageAgentDefaults,
  onOpenChange,
  onChanged,
  onDeleted,
}: EditAgentProfileDialogProps) {
  const t = useTranslations('chat.agentEdit');
  const tCreate = useTranslations('settings.agentPanel.createDialog');
  const nameId = useId();
  const deleteConfirmationId = useId();
  const loadSequenceRef = useRef(0);

  const [currentAgent, setCurrentAgent] = useState<AgentProfile | null>(null);
  const [name, setName] = useState('');
  const [iconId, setIconId] = useState<AgentIconId>('bot');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [modelOverrideEnabled, setModelOverrideEnabled] = useState(false);
  const [modelOpen, setModelOpen] = useState(true);
  const [modelCatalog, setModelCatalog] = useState<AiAppRuntimeCatalog | null>(null);
  const [modelDraft, setModelDraft] = useState<AgentCatalogModelSelection | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [customEnabledTools, setCustomEnabledTools] = useState<string[] | null>(null);
  const [effectiveEnabledTools, setEffectiveEnabledTools] = useState<string[] | null>(null);
  const [toolsOverrideEnabled, setToolsOverrideEnabled] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [openToolRows, setOpenToolRows] = useState<Record<string, boolean>>({});
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [activeToolGroups, setActiveToolGroups] = useState<Set<string>>(new Set());

  const [connectionsOverrideEnabled, setConnectionsOverrideEnabled] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [selectedConnections, setSelectedConnections] = useState<string[]>([]);
  const [pluginsOverrideEnabled, setPluginsOverrideEnabled] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [selectedPlugins, setSelectedPlugins] = useState<AgentPluginSelection[]>([]);
  const [skillsOverrideEnabled, setSkillsOverrideEnabled] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);

  const [filesOpen, setFilesOpen] = useState(true);
  const [files, setFiles] = useState<Record<ManagedFileName, string> | null>(null);
  const [fileDrafts, setFileDrafts] = useState<Record<ManagedFileName, string>>(EMPTY_FILES);
  const [activeFile, setActiveFile] = useState<ManagedFileName>('AGENTS.md');
  const [accessOpen, setAccessOpen] = useState(true);

  const [deletePreviewLoading, setDeletePreviewLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePreview, setDeletePreview] = useState<AgentDeletionPreview | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canManageAccess = Boolean(currentAgent?.access?.canManage);
  const canDelete = Boolean(currentAgent?.removable && canManageAccess);

  const toolGroups = useMemo(() => {
    const groups = [...new Set(availableTools.map((tool) => tool.group).filter(Boolean))] as string[];
    return groups.sort();
  }, [availableTools]);

  const filteredTools = useMemo(() => {
    let result = availableTools;
    if (activeToolGroups.size > 0) {
      result = result.filter((tool) => tool.group && activeToolGroups.has(tool.group));
    }
    if (toolSearchQuery.trim()) {
      const query = toolSearchQuery.trim().toLowerCase();
      result = result.filter((tool) => (
        tool.name.toLowerCase().includes(query)
        || tool.label.toLowerCase().includes(query)
        || tool.description.toLowerCase().includes(query)
        || Boolean(tool.group?.toLowerCase().includes(query))
      ));
    }
    return result;
  }, [activeToolGroups, availableTools, toolSearchQuery]);

  const resetDialogState = useCallback(() => {
    loadSequenceRef.current += 1;
    setCurrentAgent(null);
    setName('');
    setIconId('bot');
    setIconPickerOpen(false);
    setLoading(false);
    setLoadError(null);
    setError(null);
    setIsSubmitting(false);
    setModelOverrideEnabled(false);
    setModelOpen(true);
    setModelCatalog(null);
    setModelDraft(null);
    setModelLoading(false);
    setModelError(null);
    setAvailableTools([]);
    setCustomEnabledTools(null);
    setEffectiveEnabledTools(null);
    setToolsOverrideEnabled(false);
    setToolsOpen(false);
    setToolsLoading(false);
    setToolsError(null);
    setOpenToolRows({});
    setToolSearchQuery('');
    setActiveToolGroups(new Set());
    setConnectionsOverrideEnabled(false);
    setConnectionsOpen(false);
    setSelectedConnections([]);
    setPluginsOverrideEnabled(false);
    setPluginsOpen(false);
    setSelectedPlugins([]);
    setSkillsOverrideEnabled(false);
    setSkillsOpen(false);
    setSelectedSkills([]);
    setFilesOpen(true);
    setFiles(null);
    setFileDrafts(EMPTY_FILES);
    setActiveFile('AGENTS.md');
    setAccessOpen(true);
    setDeletePreviewLoading(false);
    setDeleteDialogOpen(false);
    setDeletePreview(null);
    setDeleteConfirmation('');
    setDeleteError(null);
    setDeleting(false);
  }, []);

  const loadConfiguration = useCallback(async () => {
    if (!agent) return;
    const requestSequence = ++loadSequenceRef.current;
    setLoading(true);
    setLoadError(null);
    setError(null);
    setToolsLoading(true);
    setToolsError(null);
    setModelLoading(canManageAgentDefaults);
    setModelError(null);

    try {
      const params = new URLSearchParams({
        agentId: agent.agentId,
        includeFiles: 'true',
        includeAccess: 'true',
      });
      const [inspection, toolsPayload, catalogResult] = await Promise.all([
        fetchAgentFormJson<AgentInspection>(`/api/agents?${params.toString()}`),
        fetchAgentFormJson<AgentToolsPayload>(`/api/agents/tools?${new URLSearchParams({ agentId: agent.agentId }).toString()}`),
        canManageAgentDefaults
          ? readAdminRuntimeCatalog()
              .then((payload) => ({ payload, error: null }))
              .catch((catalogError: unknown) => ({
                payload: null,
                error: catalogError instanceof Error ? catalogError.message : tCreate('model.loadError'),
              }))
          : Promise.resolve({ payload: null, error: null }),
      ]);
      if (requestSequence !== loadSequenceRef.current) return;

      const inspectedAgent: AgentProfile = {
        ...inspection.agent,
        access: inspection.access,
      };
      const storedModelSelection = selectionFromAgent(inspectedAgent);
      const nextFiles = filesFromInspection(inspection.files);
      const storedTools = Array.isArray(inspectedAgent.enabledTools) ? inspectedAgent.enabledTools : null;
      const nextPlugins = (inspection.bindings || [])
        .filter((binding) => binding.resourceType === 'plugin')
        .map((binding): AgentPluginSelection => ({
          resourceType: 'plugin',
          resourceId: binding.resourceId,
          name: binding.name,
          scopeType: binding.scopeType,
        }));

      setCurrentAgent(inspectedAgent);
      setName(inspectedAgent.name);
      setIconId((inspectedAgent.iconId || 'bot') as AgentIconId);
      setModelOverrideEnabled(Boolean(storedModelSelection));
      setModelCatalog(catalogResult.payload?.catalog ?? null);
      setModelError(catalogResult.error);
      setModelDraft(storedModelSelection || (catalogResult.payload?.catalog
        ? initialAgentCatalogSelection(catalogResult.payload.catalog)
        : null));
      setAvailableTools(toolsPayload.tools || []);
      setEffectiveEnabledTools(toolsPayload.config?.enabledTools ?? []);
      setToolsOverrideEnabled(Array.isArray(inspectedAgent.enabledTools));
      setCustomEnabledTools(getExplicitEnabledToolsFromConfig(
        toolsPayload.tools || [],
        storedTools ?? toolsPayload.config?.enabledTools ?? [],
      ));
      setToolsOpen(Array.isArray(inspectedAgent.enabledTools));
      setSelectedConnections(inspectedAgent.relevantConnections || []);
      setConnectionsOverrideEnabled(Array.isArray(inspectedAgent.relevantConnections));
      setConnectionsOpen(Array.isArray(inspectedAgent.relevantConnections));
      setSelectedPlugins(nextPlugins);
      setPluginsOverrideEnabled(nextPlugins.length > 0);
      setPluginsOpen(nextPlugins.length > 0);
      setSelectedSkills(inspectedAgent.relevantSkills || []);
      setSkillsOverrideEnabled(Array.isArray(inspectedAgent.relevantSkills));
      setSkillsOpen(Array.isArray(inspectedAgent.relevantSkills));
      setFiles(nextFiles);
      setFileDrafts(nextFiles);
    } catch (loadFailure) {
      if (requestSequence !== loadSequenceRef.current) return;
      setLoadError(loadFailure instanceof Error ? loadFailure.message : t('errors.loadFailed'));
    } finally {
      if (requestSequence === loadSequenceRef.current) {
        setLoading(false);
        setToolsLoading(false);
        setModelLoading(false);
      }
    }
  }, [agent, canManageAgentDefaults, t, tCreate]);

  const loadModelOptions = useCallback(async () => {
    if (!canManageAgentDefaults) return;
    setModelLoading(true);
    setModelError(null);
    try {
      const payload = await readAdminRuntimeCatalog();
      setModelCatalog(payload.catalog);
      setModelDraft((current) => current || initialAgentCatalogSelection(payload.catalog));
    } catch (catalogError) {
      setModelError(catalogError instanceof Error ? catalogError.message : tCreate('model.loadError'));
    } finally {
      setModelLoading(false);
    }
  }, [canManageAgentDefaults, tCreate]);

  useEffect(() => {
    if (!open || !agent) return;
    queueMicrotask(() => void loadConfiguration());
  }, [agent, loadConfiguration, open]);

  useEffect(() => {
    if (currentAgent?.scopeType !== 'organization') return;
    queueMicrotask(() => {
      setSelectedPlugins((current) => current.filter((plugin) => plugin.scopeType !== 'user'));
    });
  }, [currentAgent?.scopeType]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (isSubmitting || deleting)) return;
    if (!nextOpen) resetDialogState();
    onOpenChange(nextOpen);
  };

  const isToolEnabled = useCallback((toolName: string): boolean => {
    const allNames = availableTools.map((tool) => tool.name);
    const enabledTools = customEnabledTools ?? [];
    if (isDefaultToolsConfig(enabledTools)) {
      return getDefaultEnabledToolNames(allNames).has(toolName);
    }
    return resolveEnabledToolNames(allNames, enabledTools).has(toolName);
  }, [availableTools, customEnabledTools]);

  const setToolsOverride = useCallback((enabled: boolean) => {
    setToolsOverrideEnabled(enabled);
    if (enabled && customEnabledTools === null) {
      setCustomEnabledTools(getExplicitEnabledToolsFromConfig(availableTools, effectiveEnabledTools));
    }
  }, [availableTools, customEnabledTools, effectiveEnabledTools]);

  const handleToolToggle = useCallback((toolName: string, enabled: boolean) => {
    const currentEnabled = customEnabledTools ?? [];
    const allNames = availableTools.map((tool) => tool.name);
    setCustomEnabledTools(
      enabled
        ? enableToolInConfig(toolName, currentEnabled, allNames)
        : disableToolInConfig(toolName, currentEnabled, allNames),
    );
  }, [availableTools, customEnabledTools]);

  const handleEnableAllTools = useCallback(() => {
    const allNames = availableTools.map((tool) => tool.name);
    let newEnabledTools = customEnabledTools ?? [];
    for (const tool of filteredTools) {
      if (tool.availability?.available === false) continue;
      newEnabledTools = enableToolInConfig(tool.name, newEnabledTools, allNames);
    }
    setCustomEnabledTools(newEnabledTools);
  }, [availableTools, customEnabledTools, filteredTools]);

  const handleDisableAllTools = useCallback(() => {
    const allNames = availableTools.map((tool) => tool.name);
    let newEnabledTools = customEnabledTools ?? [];
    for (const tool of filteredTools) {
      newEnabledTools = disableToolInConfig(tool.name, newEnabledTools, allNames);
    }
    setCustomEnabledTools(newEnabledTools);
  }, [availableTools, customEnabledTools, filteredTools]);

  const toggleToolGroup = useCallback((group: string) => {
    setActiveToolGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const modelSelectionReady = !canManageAgentDefaults || !modelOverrideEnabled || (
    canManageAgentDefaults
    && !modelLoading
    && !modelError
    && isAgentCatalogSelectionValid(modelCatalog, modelDraft)
  );
  const canSave = Boolean(
    currentAgent
    && !loading
    && !isSubmitting
    && name.trim()
    && name.trim().length <= 80
    && modelSelectionReady
    && (!toolsOverrideEnabled || (!toolsLoading && customEnabledTools !== null)),
  );

  const submit = async () => {
    if (!currentAgent || !canSave) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('errors.nameRequired'));
      return;
    }
    if (trimmedName.length > 80) {
      setError(t('errors.nameTooLong'));
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const patchPayload: Record<string, unknown> = {
        agentId: currentAgent.agentId,
        expectedRevision: currentAgent.revision ?? 1,
        name: trimmedName,
        iconId,
        enabledTools: toolsOverrideEnabled ? customEnabledTools ?? [] : null,
        relevantSkills: skillsOverrideEnabled ? selectedSkills : null,
        relevantConnections: connectionsOverrideEnabled ? selectedConnections : null,
        capabilities: pluginsOverrideEnabled
          ? selectedPlugins.map(({ resourceType, resourceId, name: pluginName }) => ({
              resourceType,
              resourceId,
              name: pluginName,
            }))
          : null,
      };
      if (canManageAgentDefaults) {
        patchPayload.defaultProviderInstallationId = modelOverrideEnabled ? modelDraft?.providerInstallationId ?? null : null;
        patchPayload.defaultProvider = modelOverrideEnabled ? modelDraft?.providerId ?? null : null;
        patchPayload.defaultModel = modelOverrideEnabled ? modelDraft?.modelId ?? null : null;
        patchPayload.defaultThinking = modelOverrideEnabled ? modelDraft?.thinkingLevel ?? null : null;
        if (modelOverrideEnabled) patchPayload.expectedCatalogRevision = modelCatalog?.revision;
      }

      const patched = await fetchAgentFormJson<{ agent: AgentProfile }>('/api/agents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchPayload),
      });
      let latestAgent: AgentProfile = {
        ...patched.agent,
        access: currentAgent.access,
      };

      for (const fileName of EDIT_AGENT_FILE_NAMES) {
        const nextContent = fileDrafts[fileName] ?? '';
        if (nextContent === (files?.[fileName] ?? '')) continue;
        const updatedFile = await fetchAgentFormJson<{ agent: AgentProfile }>('/api/agents/files', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: latestAgent.agentId,
            expectedRevision: latestAgent.revision ?? 1,
            fileName,
            content: nextContent,
          }),
        });
        latestAgent = {
          ...updatedFile.agent,
          access: currentAgent.access,
        };
      }

      setCurrentAgent(latestAgent);
      setFiles(fileDrafts);
      await onChanged(latestAgent);
      resetDialogState();
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.saveFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const requestDeletion = async () => {
    if (!currentAgent || !canDelete) return;
    setDeletePreviewLoading(true);
    setDeleteError(null);
    try {
      const preview = await fetchAgentFormJson<AgentDeletionPreview>('/api/agents/delete-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: currentAgent.agentId }),
      });
      setDeletePreview(preview);
      setDeleteConfirmation('');
      setDeleteDialogOpen(true);
    } catch (previewError) {
      setDeleteError(previewError instanceof Error ? previewError.message : t('errors.deleteFailed'));
    } finally {
      setDeletePreviewLoading(false);
    }
  };

  const confirmDeletion = async () => {
    if (!deletePreview || !isExactAgentDeleteConfirmation(deleteConfirmation, deletePreview.agent.name)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await fetchAgentFormJson<{ deleted: true; agentId: string }>('/api/agents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: deletePreview.agent.agentId,
          expectedRevision: deletePreview.agent.revision,
          confirmationToken: deletePreview.confirmationToken,
        }),
      });
      const deletedAgentId = deletePreview.agent.agentId;
      setDeleteDialogOpen(false);
      resetDialogState();
      await onDeleted(deletedAgentId);
      onOpenChange(false);
    } catch (deleteFailure) {
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : t('errors.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          layout="viewport"
          className="h-[100dvh] min-w-0 bg-background p-0 sm:h-[calc(100dvh-2rem)] md:h-[calc(100dvh-3rem)] lg:h-[calc(100dvh-4rem)]"
          data-testid="edit-agent-dialog"
        >
          <div className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader className="shrink-0 border-b px-4 py-3 pr-14 sm:px-5 sm:py-4">
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>
                {currentAgent || agent
                  ? t('description', { name: currentAgent?.name || agent?.name || '' })
                  : t('descriptionFallback')}
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="h-full min-h-0 max-w-full overflow-x-hidden">
              <div className="mx-auto box-border flex w-[100dvw] max-w-[100dvw] min-w-0 flex-col gap-4 overflow-x-hidden p-3 pr-[calc(0.75rem+0.625rem)] sm:gap-5 sm:p-5 sm:pr-[calc(1.25rem+0.625rem)] md:w-full md:max-w-4xl">
                {loading && !currentAgent ? (
                  <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/15 text-sm text-muted-foreground" role="status">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {t('loading')}
                  </div>
                ) : null}

                {loadError && !currentAgent ? (
                  <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4" role="alert">
                    <div className="flex items-start gap-2 text-sm text-destructive">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{loadError}</span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void loadConfiguration()}>
                      {t('retry')}
                    </Button>
                  </div>
                ) : null}

                {currentAgent ? (
                  <>
                    <section className="min-w-0 overflow-hidden rounded-md border bg-muted/10 p-3 sm:p-4">
                      <div className="flex min-w-0 flex-col gap-3 min-[420px]:flex-row min-[420px]:items-center sm:gap-4">
                        <button
                          type="button"
                          onClick={() => setIconPickerOpen(true)}
                          className="group shrink-0 self-start rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                          title={tCreate('changeIcon')}
                        >
                          <AgentAvatar
                            iconId={iconId}
                            className="h-16 w-16 border-primary/30 bg-background group-hover:bg-muted sm:h-20 sm:w-20"
                            iconClassName="h-8 w-8 sm:h-10 sm:w-10"
                          />
                        </button>
                        <div className="min-w-0 flex-1 space-y-2">
                          <Label className="text-xs font-medium uppercase text-muted-foreground" htmlFor={nameId}>
                            {tCreate('nameLabel')}
                          </Label>
                          <Input
                            id={nameId}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            maxLength={80}
                            required
                            disabled={isSubmitting}
                            className="h-12 min-w-0 text-base font-semibold sm:text-lg"
                            aria-invalid={Boolean(error)}
                          />
                          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                            <LockKeyhole className="h-3.5 w-3.5" />
                            <span className="font-medium text-foreground">{t('availabilityLabel')}</span>
                            <span>
                              {currentAgent.scopeType === 'organization'
                                ? tCreate('scope.organization')
                                : tCreate('scope.personal')}
                            </span>
                          </div>
                        </div>
                      </div>
                    </section>

                    {canManageAgentDefaults ? (
                      <AgentFormSection
                        title={tCreate('model.title')}
                        description={tCreate('model.description')}
                        icon={Brain}
                        open={modelOpen}
                        onOpenChange={setModelOpen}
                        enabled={modelOverrideEnabled}
                        showWhenDisabled
                        onEnabledChange={setModelOverrideEnabled}
                      >
                        {!modelOverrideEnabled ? (
                          <p className="mb-3 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm leading-relaxed text-muted-foreground">
                            {tCreate('model.inheritedDefault')}
                          </p>
                        ) : null}
                        <AgentCatalogModelOverrideEditor
                          catalog={modelCatalog}
                          selection={modelDraft}
                          loading={modelLoading}
                          error={modelError}
                          disabled={!modelOverrideEnabled}
                          onSelectionChange={setModelDraft}
                          onRetry={() => void loadModelOptions()}
                        />
                      </AgentFormSection>
                    ) : (
                      <section className="flex min-w-0 items-start gap-3 rounded-md border bg-muted/10 p-3 sm:gap-4 sm:p-4">
                        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                          <Brain className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 space-y-1">
                          <span className="block text-base font-semibold">{tCreate('model.title')}</span>
                          <span className="block text-sm leading-relaxed text-muted-foreground">
                            {tCreate('model.adminOnlyDescription')}
                          </span>
                        </span>
                      </section>
                    )}

                    <AgentFormSection
                      title={tCreate('tools.title')}
                      description={tCreate('tools.description')}
                      icon={Wrench}
                      open={toolsOpen}
                      onOpenChange={setToolsOpen}
                      enabled={toolsOverrideEnabled}
                      onEnabledChange={setToolsOverride}
                    >
                      <AgentToolsEditor
                        availableTools={availableTools}
                        filteredTools={filteredTools}
                        toolGroups={toolGroups}
                        activeToolGroups={activeToolGroups}
                        openToolRows={openToolRows}
                        toolsLoading={toolsLoading}
                        toolsSaving={isSubmitting}
                        toolsError={toolsError}
                        toolSearchQuery={toolSearchQuery}
                        isToolEnabled={isToolEnabled}
                        onToolSearchQueryChange={setToolSearchQuery}
                        onToggleToolGroup={toggleToolGroup}
                        onClearToolGroups={() => setActiveToolGroups(new Set())}
                        onToolRowOpenChange={(toolName, rowOpen) => setOpenToolRows((current) => ({ ...current, [toolName]: rowOpen }))}
                        onToolToggle={handleToolToggle}
                        onEnableAll={handleEnableAllTools}
                        onDisableAll={handleDisableAllTools}
                        compact
                      />
                    </AgentFormSection>

                    <AgentFormSection
                      title={tCreate('connections.title')}
                      description={tCreate('connections.description')}
                      icon={Plug}
                      open={connectionsOpen}
                      onOpenChange={setConnectionsOpen}
                      enabled={connectionsOverrideEnabled}
                      onEnabledChange={setConnectionsOverrideEnabled}
                    >
                      <AgentConnectionsPicker
                        enabled={connectionsOverrideEnabled}
                        selectedConnectionIds={selectedConnections}
                        onSelectedConnectionIdsChange={setSelectedConnections}
                        pageSize={6}
                      />
                    </AgentFormSection>

                    <AgentFormSection
                      title={tCreate('plugins.title')}
                      description={tCreate('plugins.description')}
                      icon={Sparkles}
                      open={pluginsOpen}
                      onOpenChange={setPluginsOpen}
                      enabled={pluginsOverrideEnabled}
                      onEnabledChange={setPluginsOverrideEnabled}
                    >
                      <AgentPluginsPicker
                        enabled={pluginsOverrideEnabled}
                        organizationOnly={currentAgent.scopeType === 'organization'}
                        selectedPlugins={selectedPlugins}
                        onSelectedPluginsChange={setSelectedPlugins}
                      />
                    </AgentFormSection>

                    <AgentFormSection
                      title={tCreate('skills.title')}
                      description={tCreate('skills.description')}
                      icon={Search}
                      open={skillsOpen}
                      onOpenChange={setSkillsOpen}
                      enabled={skillsOverrideEnabled}
                      onEnabledChange={setSkillsOverrideEnabled}
                    >
                      <AgentRelevantSkillsPicker
                        enabled={skillsOverrideEnabled}
                        selectedSkillNames={selectedSkills}
                        onSelectedSkillNamesChange={setSelectedSkills}
                      />
                    </AgentFormSection>

                    <AgentFormSection
                      title={tCreate('files.title')}
                      description={t('filesDescription')}
                      icon={FileText}
                      open={filesOpen}
                      onOpenChange={setFilesOpen}
                    >
                      <AgentManagedFilesEditor
                        isMainAgent={false}
                        files={files}
                        fileDrafts={fileDrafts}
                        activeFile={activeFile}
                        filesLoading={loading}
                        onActiveFileChange={setActiveFile}
                        onDraftChange={(fileName, value) => setFileDrafts((current) => ({ ...current, [fileName]: value }))}
                        visibleFileNames={EDIT_AGENT_FILE_NAMES}
                        showInheritedFiles={false}
                        editorClassName="h-[clamp(220px,34dvh,360px)]"
                      />
                    </AgentFormSection>

                    {canManageAccess ? (
                      <AgentFormSection
                        title={t('accessTitle')}
                        description={t('accessDescription')}
                        icon={Users}
                        open={accessOpen}
                        onOpenChange={setAccessOpen}
                      >
                        {currentAgent.scopeType === 'organization' ? (
                          <AgentGrantsEditor
                            active={open && accessOpen}
                            agentId={currentAgent.agentId}
                            revision={currentAgent.revision || 1}
                            onChanged={async (updated) => {
                              const nextAgent = { ...currentAgent, ...updated };
                              setCurrentAgent(nextAgent);
                              await onChanged(nextAgent);
                            }}
                          />
                        ) : !currentAgent.scopeType ? (
                          <AgentMembersEditor
                            active={open && accessOpen}
                            agentId={currentAgent.agentId}
                            onChanged={() => onChanged(currentAgent)}
                          />
                        ) : (
                          <div className="flex items-start gap-3 rounded-md border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
                            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{t('personalAccessDescription')}</span>
                          </div>
                        )}
                      </AgentFormSection>
                    ) : null}

                    {canDelete ? (
                      <section className="rounded-md border border-destructive/30 bg-destructive/[0.035] p-4" data-testid="agent-danger-zone">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2 font-semibold text-destructive">
                              <Trash2 className="h-4 w-4" />
                              {t('dangerTitle')}
                            </div>
                            <p className="text-sm leading-relaxed text-muted-foreground">{t('dangerDescription')}</p>
                          </div>
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => void requestDeletion()}
                            disabled={deletePreviewLoading || isSubmitting}
                            className="shrink-0"
                          >
                            {deletePreviewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            {t('deleteAgent')}
                          </Button>
                        </div>
                        {deleteError && !deleteDialogOpen ? (
                          <p className="mt-3 text-sm text-destructive" role="alert">{deleteError}</p>
                        ) : null}
                      </section>
                    ) : null}

                    {error ? (
                      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                        {error}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </ScrollArea>

            <DialogFooter className="shrink-0 border-t bg-background/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-4">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isSubmitting || deleting} className="w-full sm:w-auto">
                {tCreate('cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canSave} className="w-full sm:w-auto">
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isSubmitting ? t('saving') : t('save')}
              </Button>
            </DialogFooter>
          </div>

          <AgentIconPickerDialog
            open={iconPickerOpen}
            value={iconId}
            onOpenChange={setIconPickerOpen}
            onValueChange={setIconId}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(nextOpen) => {
          if (deleting) return;
          setDeleteDialogOpen(nextOpen);
          if (!nextOpen) {
            setDeletePreview(null);
            setDeleteConfirmation('');
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent data-testid="delete-agent-confirmation-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletePreview
                ? t('deleteImpact', {
                    sessions: deletePreview.impacts.sessions,
                    grants: deletePreview.impacts.grants + deletePreview.impacts.members,
                    capabilities: deletePreview.impacts.capabilityBindings,
                    files: deletePreview.impacts.managedFiles.length,
                    memoryEntries: deletePreview.impacts.memoryEntries,
                  })
                : t('dangerDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deletePreview ? (
            <div className="space-y-2">
              <Label htmlFor={deleteConfirmationId}>
                {t('deleteConfirmationLabel', { name: deletePreview.agent.name })}
              </Label>
              <Input
                id={deleteConfirmationId}
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoComplete="off"
                disabled={deleting}
                data-testid="delete-agent-confirmation-input"
              />
            </div>
          ) : null}
          {deleteError ? <p className="text-sm text-destructive" role="alert">{deleteError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tCreate('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmDeletion();
              }}
              disabled={deleting || !deletePreview || !isExactAgentDeleteConfirmation(deleteConfirmation, deletePreview.agent.name)}
              className={cn('bg-destructive text-destructive-foreground hover:bg-destructive/90')}
              data-testid="delete-agent-confirmation-submit"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {deleting ? t('deleting') : t('deleteAgent')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
