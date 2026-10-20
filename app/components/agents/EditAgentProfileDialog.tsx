'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  FileText,
  Loader2,
  LockKeyhole,
  Save,
  ShieldCheck,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

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
import { AgentExtensionEditor, type AgentExtensionEditorContext, type AgentExtensionEditorDraft,
  type AgentExtensionEditorProps, type AgentExtensionEditorValidation, clearAgentExtensionEditorDraft } from './AgentExtensionEditor';
import { readAgentExtensionManagement } from './agent-workflow-management-client';
import { rebaseAgentExtensionRetentions } from './agent-extension-retention-rebase';
import { clearAgentFormDraft, readAgentFormDraft, writeAgentFormDraft } from './agent-form-draft-storage';
import { agentProfileEditUrl, agentProfileModelFields, buildAgentProfileEditPatch,
  resolveAgentFormToolDraft, sameAgentProfileModelFields, toggleAgentFormToolDraft, toggleAgentFormToolsDraft,
  type AgentProfileModelPatch } from './agent-profile-edit-client';
import type { AgentExtensionConfigurationInput } from '@/app/lib/capabilities/extensions/contracts';
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
import { normalizeAgentIconId, type AgentIconId } from '@/app/lib/agents/icons';
import type { AgentProfile } from '@/app/lib/chat/types';
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

type AgentInspection = {
  agent: AgentProfile;
  access: NonNullable<AgentProfile['access']>;
  extensions?: { configuration: AgentExtensionConfigurationInput | null; workflowRevision: number;
    bindingSummaries?: AgentExtensionEditorProps['bindingSummaries']; standaloneSummaries?: AgentExtensionEditorProps['standaloneSummaries'] };
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
  context?: AgentExtensionEditorContext;
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
  context,
  onOpenChange,
  onChanged,
  onDeleted,
}: EditAgentProfileDialogProps) {
  const locale = useLocale();
  const labels = locale.startsWith('de') ? {
    historicalModel: 'Die gespeicherte Modellkonfiguration bleibt erhalten, bis du sie ausdrücklich änderst.',
    savedRefresh: 'Gespeichert. Die Anzeige konnte anschließend nicht aktualisiert werden.',
    refresh: 'Anzeige aktualisieren',
    draftConflict: 'Ein gespeicherter Entwurf gehört zu einem älteren Agentenstand. Er wurde nicht übernommen.',
    discardDraft: 'Alten Entwurf verwerfen und aktuellen Stand verwenden',
    retentionPending: 'Aktuelle Verbindungshinweise werden geladen …',
    retentionError: 'Die Änderung wurde gespeichert. Der Verbindungsstand muss vor weiteren Änderungen neu geladen werden.',
    retryRetention: 'Verbindungshinweise erneut laden',
    reloadConfiguration: 'Gespeicherte Konfiguration laden',
    discardUnsaved: 'Ungespeicherte Formularänderungen werden verworfen. Den gespeicherten Stand laden?',
    grantRefreshError: 'Berechtigungen gespeichert. Die Agentenliste konnte danach nicht aktualisiert werden.',
  } : {
    historicalModel: 'The saved model configuration stays in place until you explicitly change it.',
    savedRefresh: 'Saved. The display could not be refreshed afterward.',
    refresh: 'Refresh display',
    draftConflict: 'A saved draft belongs to an older Agent revision. It has not been applied.',
    discardDraft: 'Discard the old draft and use the current configuration',
    retentionPending: 'Loading current connection hints…',
    retentionError: 'The change was saved. Reload the connection state before making more changes.',
    retryRetention: 'Retry connection metadata',
    reloadConfiguration: 'Reload saved configuration',
    discardUnsaved: 'Unsaved form changes will be discarded. Reload the saved configuration?',
    grantRefreshError: 'Permissions saved. The Agent list could not be refreshed afterward.',
  };
  const t = useTranslations('chat.agentEdit');
  const tCreate = useTranslations('settings.agentPanel.createDialog');
  const nameId = useId();
  const deleteConfirmationId = useId();
  const loadSequenceRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const submitTokenRef = useRef<symbol | null>(null);
  const scopedContext = useMemo<AgentExtensionEditorContext>(() => ({ actorId: context?.actorId ?? null,
    workspaceId: context?.workspaceId ?? null, organizationId: context?.organizationId ?? null,
    projectId: context?.projectId ?? null }), [context?.actorId, context?.workspaceId, context?.organizationId, context?.projectId]);
  const scopeKey = JSON.stringify([scopedContext, agent?.agentId ?? null, open]);
  const activeScopeRef = useRef(scopeKey);
  useLayoutEffect(() => { activeScopeRef.current = scopeKey; }, [scopeKey]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);

  const [currentAgent, setCurrentAgent] = useState<AgentProfile | null>(null);
  const [name, setName] = useState('');
  const [iconId, setIconId] = useState<AgentIconId>('bot');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [savedAgent, setSavedAgent] = useState<AgentProfile | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [extensionDraft, setExtensionDraft] = useState<AgentExtensionEditorDraft>({ intent: 'keep', configuration: null });
  const [bindingSummaries, setBindingSummaries] = useState<AgentExtensionEditorProps['bindingSummaries']>();
  const [standaloneSummaries, setStandaloneSummaries] = useState<AgentExtensionEditorProps['standaloneSummaries']>();
  const [extensionValidation, setExtensionValidation] = useState<AgentExtensionEditorValidation & { key?: string }>({ pending: false,
    blocked: false, preview: null, error: null });
  const [workflowRevision, setWorkflowRevision] = useState<number | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const [retentionPending, setRetentionPending] = useState(false), [retentionError, setRetentionError] = useState(false);
  const [retentionConflict, setRetentionConflict] = useState(false);
  const [confirmRetentionReload, setConfirmRetentionReload] = useState(false);
  const extensionDraftRef = useRef(extensionDraft);
  const extensionBaseline = useRef<{ agentId: string; revision: number; workflowRevision: number; configuration: AgentExtensionConfigurationInput | null } | null>(null);
  const retentionController = useRef<AbortController | null>(null), retentionGeneration = useRef(0);
  const retentionRetry = useRef<AgentProfile | null>(null);
  useLayoutEffect(() => { extensionDraftRef.current = extensionDraft; }, [extensionDraft]);

  const [modelOverrideEnabled, setModelOverrideEnabled] = useState(false);
  const [modelOpen, setModelOpen] = useState(true);
  const [modelCatalog, setModelCatalog] = useState<AiAppRuntimeCatalog | null>(null);
  const [modelDraft, setModelDraft] = useState<AgentCatalogModelSelection | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelTouched, setModelTouched] = useState(false);

  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [customEnabledTools, setCustomEnabledTools] = useState<string[] | null>(null);
  const [effectiveEnabledTools, setEffectiveEnabledTools] = useState<string[] | null>(null);
  const [toolsOverrideEnabled, setToolsOverrideEnabled] = useState(false);
  const [toolsTouched, setToolsTouched] = useState(false);
  const [initialToolsDraft, setInitialToolsDraft] = useState<{ enabled: boolean; tools: string[] | null }>({ enabled: false, tools: null });
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [openToolRows, setOpenToolRows] = useState<Record<string, boolean>>({});
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [activeToolGroups, setActiveToolGroups] = useState<Set<string>>(new Set());

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

  const formDraftScope = useMemo(() => currentAgent && workflowRevision !== null ? { ...scopedContext,
    target: { kind: 'existing' as const, agentId: currentAgent.agentId, expectedRevision: currentAgent.revision ?? 1,
      expectedWorkflowRevision: workflowRevision } } : null,
  [currentAgent, scopedContext, workflowRevision]);

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
    loadAbortRef.current?.abort();
    retentionController.current?.abort(); retentionGeneration.current += 1; retentionRetry.current = null;
    extensionBaseline.current = null; setRetentionPending(false); setRetentionError(false); setRetentionConflict(false); setConfirmRetentionReload(false);
    submitTokenRef.current = null;
    setLoadedScope(null);
    setCurrentAgent(null);
    setName('');
    setIconId('bot');
    setIconPickerOpen(false);
    setLoading(false);
    setLoadError(null);
    setError(null);
    setIsSubmitting(false);
    setSavedAgent(null);
    setRefreshError(false);
    setExtensionDraft({ intent: 'keep', configuration: null });
    setBindingSummaries(undefined);
    setStandaloneSummaries(undefined);
    setExtensionValidation({ pending: false, blocked: false, preview: null, error: null });
    setWorkflowRevision(null);
    setDraftConflict(false);
    setModelOverrideEnabled(false);
    setModelOpen(true);
    setModelCatalog(null);
    setModelDraft(null);
    setModelLoading(false);
    setModelError(null);
    setModelTouched(false);
    setAvailableTools([]);
    setCustomEnabledTools(null);
    setEffectiveEnabledTools(null);
    setToolsOverrideEnabled(false);
    setToolsTouched(false);
    setInitialToolsDraft({ enabled: false, tools: null });
    setToolsOpen(false);
    setToolsLoading(false);
    setToolsError(null);
    setOpenToolRows({});
    setToolSearchQuery('');
    setActiveToolGroups(new Set());
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
    retentionController.current?.abort(); retentionGeneration.current += 1;
    const requestSequence = ++loadSequenceRef.current;
    const requestedScope = scopeKey;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && requestSequence === loadSequenceRef.current
      && requestedScope === activeScopeRef.current;
    setLoading(true);
    submitTokenRef.current = null;
    setIsSubmitting(false);
    setDeleting(false);
    setLoadError(null);
    setError(null);
    setToolsLoading(true);
    setToolsError(null);
    setModelLoading(canManageAgentDefaults);
    setModelError(null);

    try {
      const params = {
        agentId: agent.agentId,
        includeFiles: 'true',
        includeAccess: 'true',
      };
      const [inspection, toolsPayload, catalogResult] = await Promise.all([
        fetchAgentFormJson<AgentInspection>(agentProfileEditUrl('/api/agents', scopedContext, params), { signal: controller.signal }),
        fetchAgentFormJson<AgentToolsPayload>(agentProfileEditUrl('/api/agents/tools', scopedContext, { agentId: agent.agentId }), { signal: controller.signal }),
        canManageAgentDefaults
          ? readAdminRuntimeCatalog()
              .then((payload) => ({ payload, error: null }))
              .catch((catalogError: unknown) => ({
                payload: null,
                error: catalogError instanceof Error ? catalogError.message : tCreate('model.loadError'),
              }))
          : Promise.resolve({ payload: null, error: null }),
      ]);
      if (!isCurrent()) return;

      const inspectedAgent: AgentProfile = {
        ...inspection.agent,
        access: inspection.access,
      };
      const storedModelSelection = selectionFromAgent(inspectedAgent);
      const hasStoredModel = Object.values(agentProfileModelFields(inspectedAgent)).some(value => value !== null);
      const nextFiles = filesFromInspection(inspection.files);
      const storedTools = Array.isArray(inspectedAgent.enabledTools) ? inspectedAgent.enabledTools : null;
      const actualWorkflowRevision = inspection.extensions?.workflowRevision ?? inspectedAgent.workflowRevision ?? null;
      const restored = actualWorkflowRevision !== null ? readAgentFormDraft({ ...scopedContext,
        target: { kind: 'existing', agentId: inspectedAgent.agentId, expectedRevision: inspectedAgent.revision ?? 1,
          expectedWorkflowRevision: actualWorkflowRevision } }) : { state: 'none' as const };
      const restoredFields = restored.state === 'ready' ? restored.fields : undefined;
      const restoredModel = restoredFields && (Object.hasOwn(restoredFields, 'modelOverrideEnabled') || Object.hasOwn(restoredFields, 'modelDraft'));
      const restoredTools = restoredFields && (Object.hasOwn(restoredFields, 'toolsOverrideEnabled') || Object.hasOwn(restoredFields, 'customEnabledTools'));
      setCurrentAgent(inspectedAgent);
      setLoadedScope(requestedScope);
      setSavedAgent(null);
      setRefreshError(false);
      const configured = inspection.extensions?.configuration ?? null;
      extensionBaseline.current = Number.isSafeInteger(inspectedAgent.revision) && actualWorkflowRevision !== null
        ? { agentId: inspectedAgent.agentId, revision: inspectedAgent.revision!, workflowRevision: actualWorkflowRevision, configuration: configured } : null;
      extensionDraftRef.current = { intent: 'keep', configuration: configured };
      setExtensionDraft(extensionDraftRef.current);
      setRetentionError(false); setRetentionPending(false); setRetentionConflict(false); retentionRetry.current = null;
      setBindingSummaries(inspection.extensions?.bindingSummaries);
      setStandaloneSummaries(inspection.extensions?.standaloneSummaries);
      setWorkflowRevision(actualWorkflowRevision);
      setDraftConflict(restored.state === 'conflict');
      setName(restoredFields?.name ?? inspectedAgent.name);
      setIconId(normalizeAgentIconId(restoredFields?.iconId ?? inspectedAgent.iconId));
      setModelOverrideEnabled(restoredFields?.modelOverrideEnabled ?? hasStoredModel);
      setModelTouched(Boolean(restoredModel));
      setModelCatalog(catalogResult.payload?.catalog ?? null);
      setModelError(catalogResult.error);
      setModelDraft(restoredModel ? restoredFields?.modelDraft ?? null
        : storedModelSelection || (!hasStoredModel && catalogResult.payload?.catalog
        ? initialAgentCatalogSelection(catalogResult.payload.catalog)
        : null));
      setAvailableTools(toolsPayload.tools || []);
      setEffectiveEnabledTools(toolsPayload.config?.enabledTools ?? []);
      setToolsOverrideEnabled(restoredFields?.toolsOverrideEnabled ?? Array.isArray(inspectedAgent.enabledTools));
      const explicitTools = getExplicitEnabledToolsFromConfig(
        toolsPayload.tools || [],
        storedTools ?? toolsPayload.config?.enabledTools ?? [],
      );
      setCustomEnabledTools(restoredTools ? restoredFields?.customEnabledTools ?? null : explicitTools);
      setToolsTouched(Boolean(restoredTools));
      setInitialToolsDraft({ enabled: Array.isArray(inspectedAgent.enabledTools), tools: explicitTools });
      setToolsOpen(Array.isArray(inspectedAgent.enabledTools));
      setFiles(nextFiles);
      setFileDrafts({ ...nextFiles, ...restoredFields?.fileDrafts });
    } catch (loadFailure) {
      if (!isCurrent()) return;
      setLoadError(loadFailure instanceof Error ? loadFailure.message : t('errors.loadFailed'));
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setToolsLoading(false);
        setModelLoading(false);
      }
    }
  }, [agent, canManageAgentDefaults, scopeKey, scopedContext, t, tCreate]);

  const loadModelOptions = useCallback(async () => {
    if (!canManageAgentDefaults) return;
    const requestSequence = loadSequenceRef.current;
    const requestedScope = scopeKey;
    const isCurrent = () => requestSequence === loadSequenceRef.current && requestedScope === activeScopeRef.current;
    setModelLoading(true);
    setModelError(null);
    try {
      const payload = await readAdminRuntimeCatalog();
      if (!isCurrent()) return;
      setModelCatalog(payload.catalog);
      setModelDraft((current) => current || (modelTouched ? initialAgentCatalogSelection(payload.catalog) : null));
    } catch (catalogError) {
      if (!isCurrent()) return;
      setModelError(catalogError instanceof Error ? catalogError.message : tCreate('model.loadError'));
    } finally {
      if (isCurrent()) setModelLoading(false);
    }
  }, [canManageAgentDefaults, modelTouched, scopeKey, tCreate]);

  useEffect(() => {
    if (!open || !agent) return;
    queueMicrotask(() => void loadConfiguration());
    return () => {
      loadSequenceRef.current += 1;
      loadAbortRef.current?.abort(); retentionController.current?.abort(); retentionGeneration.current += 1;
    };
  }, [agent, loadConfiguration, open]);

  const renewRetentionHints = async (acknowledged: AgentProfile, sequence: number, requestedScope: string): Promise<AgentProfile | null> => {
    const baseline = extensionBaseline.current;
    const isCurrent = () => sequence === loadSequenceRef.current && requestedScope === activeScopeRef.current;
    if (!isCurrent()) return null;
    retentionController.current?.abort();
    const controller = new AbortController(), generation = ++retentionGeneration.current;
    retentionController.current = controller; retentionRetry.current = acknowledged;
    setRetentionPending(true); setRetentionError(false);
    try {
      const fresh = await readAgentExtensionManagement({ ...scopedContext, agentId: acknowledged.agentId }, controller.signal);
      if (!isCurrent() || controller.signal.aborted || generation !== retentionGeneration.current) return null;
      if (!baseline || baseline.agentId !== acknowledged.agentId || fresh.agent.agentId !== baseline.agentId
        || fresh.agent.revision !== acknowledged.revision || !fresh.access.canEdit
        || fresh.extensions.workflowRevision !== baseline.workflowRevision || fresh.extensions.configurationState === 'blocked') {
        throw new Error(labels.retentionError);
      }
      const next = rebaseAgentExtensionRetentions({ draft: extensionDraftRef.current, before: baseline.configuration,
        current: fresh.extensions.configuration });
      extensionDraftRef.current = next; setExtensionDraft(next);
      extensionBaseline.current = { agentId: fresh.agent.agentId, revision: fresh.agent.revision!,
        workflowRevision: fresh.extensions.workflowRevision, configuration: fresh.extensions.configuration };
      const profile = { ...fresh.agent, access: fresh.access };
      setCurrentAgent(profile); setWorkflowRevision(fresh.extensions.workflowRevision);
      setBindingSummaries(fresh.extensions.bindingSummaries); setStandaloneSummaries(fresh.extensions.standaloneSummaries);
      setExtensionValidation({ pending: true, blocked: true, preview: null, error: null });
      retentionRetry.current = null;
      return profile;
    } catch (failure) {
      if (isCurrent() && !controller.signal.aborted && generation === retentionGeneration.current) setRetentionError(true);
      throw failure;
    } finally {
      if (isCurrent() && !controller.signal.aborted && generation === retentionGeneration.current) setRetentionPending(false);
    }
  };

  const handleGrantChanged = async (updated: { agentId: string; organizationId: string | null; revision: number }, mutation: { expectedRevision: number }) => {
    if (!currentAgent || updated.agentId !== currentAgent.agentId) return;
    const sequence = loadSequenceRef.current, requestedScope = scopeKey;
    if (requestedScope !== activeScopeRef.current) return;
    const acknowledged = { ...currentAgent, ...updated };
    let refreshed: AgentProfile | null = null;
    if (mutation.expectedRevision !== extensionBaseline.current?.revision || mutation.expectedRevision !== currentAgent.revision
      || updated.revision !== mutation.expectedRevision + 1) {
      // A child grants reload must not silently adopt somebody else's profile changes.
      retentionController.current?.abort(); retentionGeneration.current += 1; retentionRetry.current = null;
      setRetentionPending(false); setRetentionError(true); setRetentionConflict(true);
    } else {
      try { refreshed = await renewRetentionHints(acknowledged, sequence, requestedScope); }
      catch { /* The grant was acknowledged; only metadata recovery remains. Never repeat its write. */ }
    }
    if (sequence !== loadSequenceRef.current || requestedScope !== activeScopeRef.current) return;
    try { await onChanged(refreshed ?? acknowledged); }
    catch { if (sequence === loadSequenceRef.current && requestedScope === activeScopeRef.current) setError(labels.grantRefreshError); }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (isSubmitting || deleting || retentionPending)) return;
    if (!nextOpen) {
      if (formDraftScope && loadedScope === scopeKey) {
        clearAgentFormDraft(formDraftScope);
        clearAgentExtensionEditorDraft(scopedContext, formDraftScope.target);
      }
      resetDialogState();
    }
    onOpenChange(nextOpen);
  };

  const isToolEnabled = useCallback((toolName: string): boolean => {
    const allNames = availableTools.map((tool) => tool.name);
    return resolveAgentFormToolDraft(allNames, customEnabledTools).has(toolName);
  }, [availableTools, customEnabledTools]);

  const setToolsOverride = useCallback((enabled: boolean) => {
    setToolsTouched(true);
    setExtensionValidation({ pending: true, blocked: false, preview: null, error: null });
    setToolsOverrideEnabled(enabled);
    if (enabled && customEnabledTools === null) {
      setCustomEnabledTools(getExplicitEnabledToolsFromConfig(availableTools, effectiveEnabledTools));
    }
  }, [availableTools, customEnabledTools, effectiveEnabledTools]);

  const handleToolToggle = useCallback((toolName: string, enabled: boolean) => {
    setToolsTouched(true);
    setExtensionValidation({ pending: true, blocked: false, preview: null, error: null });
    const currentEnabled = customEnabledTools ?? [];
    const allNames = availableTools.map((tool) => tool.name);
    setCustomEnabledTools(toggleAgentFormToolDraft(toolName, enabled, currentEnabled, allNames));
  }, [availableTools, customEnabledTools]);

  const handleEnableAllTools = useCallback(() => {
    setToolsTouched(true);
    setExtensionValidation({ pending: true, blocked: false, preview: null, error: null });
    const allNames = availableTools.map((tool) => tool.name);
    setCustomEnabledTools(toggleAgentFormToolsDraft(filteredTools.filter(tool => tool.availability?.available !== false)
      .map(tool => tool.name), true, customEnabledTools ?? [], allNames));
  }, [availableTools, customEnabledTools, filteredTools]);

  const handleDisableAllTools = useCallback(() => {
    setToolsTouched(true);
    setExtensionValidation({ pending: true, blocked: false, preview: null, error: null });
    const allNames = availableTools.map((tool) => tool.name);
    setCustomEnabledTools(toggleAgentFormToolsDraft(filteredTools.map(tool => tool.name), false, customEnabledTools ?? [], allNames));
  }, [availableTools, customEnabledTools, filteredTools]);

  const toggleToolGroup = useCallback((group: string) => {
    setActiveToolGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const proposedModel: AgentProfileModelPatch = modelOverrideEnabled ? {
    defaultProviderInstallationId: modelDraft?.providerInstallationId ?? null,
    defaultProvider: modelDraft?.providerId ?? null,
    defaultModel: modelDraft?.modelId ?? null,
    defaultThinking: modelDraft?.thinkingLevel ?? null,
    expectedCatalogRevision: modelCatalog?.revision,
  } : { defaultProviderInstallationId: null, defaultProvider: null, defaultModel: null, defaultThinking: null };
  const modelChanged = Boolean(modelTouched && currentAgent
    && !sameAgentProfileModelFields(proposedModel, agentProfileModelFields(currentAgent)));
  const toolsChanged = toolsTouched && (toolsOverrideEnabled !== initialToolsDraft.enabled
    || toolsOverrideEnabled && JSON.stringify(customEnabledTools) !== JSON.stringify(initialToolsDraft.tools));
  const proposedEnabledTools = toolsOverrideEnabled ? customEnabledTools ?? [] : null;
  const changesContext = extensionDraft.intent === 'replace' || modelChanged || toolsChanged;

  const hasParentChanges = Boolean(currentAgent && (name !== currentAgent.name || iconId !== (currentAgent.iconId || 'bot')
    || modelChanged || toolsChanged || EDIT_AGENT_FILE_NAMES.some(file => fileDrafts[file] !== (files?.[file] ?? ''))));
  useEffect(() => {
    if (!open || loadedScope !== scopeKey || !formDraftScope || loading || isSubmitting || savedAgent || draftConflict) return;
    if (!hasParentChanges) {
      clearAgentFormDraft(formDraftScope);
      return;
    }
    writeAgentFormDraft(formDraftScope, { name, iconId,
      ...(modelTouched ? { modelOverrideEnabled, modelDraft } : {}),
      ...(toolsTouched ? { toolsOverrideEnabled, customEnabledTools } : {}),
      fileDrafts: Object.fromEntries(EDIT_AGENT_FILE_NAMES.map(file => [file, fileDrafts[file]])),
    });
  }, [open, loadedScope, scopeKey, formDraftScope, loading, isSubmitting, savedAgent, draftConflict,
    hasParentChanges, name, iconId, modelTouched, modelOverrideEnabled, modelDraft, toolsTouched,
    toolsOverrideEnabled, customEnabledTools, fileDrafts]);
  const extensionValidationKey = JSON.stringify([scopeKey, currentAgent?.revision ?? null, workflowRevision,
    extensionDraft, toolsChanged ? proposedEnabledTools : undefined, modelChanged ? proposedModel : undefined]);
  const handleExtensionValidation = useCallback((validation: AgentExtensionEditorValidation) => {
    setExtensionValidation({ ...validation, key: extensionValidationKey });
  }, [extensionValidationKey]);

  const modelSelectionReady = !modelChanged || !canManageAgentDefaults || !modelOverrideEnabled || (
    canManageAgentDefaults
    && !modelLoading
    && !modelError
    && isAgentCatalogSelectionValid(modelCatalog, modelDraft)
  );
  const canSave = Boolean(
    currentAgent
    && loadedScope === scopeKey
    && open
    && !loading
    && !isSubmitting
    && !retentionPending
    && !retentionError
    && !savedAgent
    && !draftConflict
    && name.trim()
    && name.trim().length <= 80
    && modelSelectionReady
    && (!changesContext || (extensionValidation.key === extensionValidationKey && !extensionValidation.pending && !extensionValidation.blocked))
    && (!toolsOverrideEnabled || (!toolsLoading && customEnabledTools !== null)),
  );

  const finishRefresh = async (updated: AgentProfile, sequence: number, requestedScope: string) => {
    const isCurrent = () => sequence === loadSequenceRef.current && requestedScope === activeScopeRef.current;
    if (!isCurrent()) return;
    try {
      await onChanged(updated);
      if (!isCurrent()) return;
      resetDialogState();
      onOpenChange(false);
    } catch {
      if (isCurrent()) setRefreshError(true);
    }
  };

  const submit = async () => {
    if (!currentAgent || !canSave || submitTokenRef.current !== null) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('errors.nameRequired'));
      return;
    }
    if (trimmedName.length > 80) {
      setError(t('errors.nameTooLong'));
      return;
    }
    const sequence = loadSequenceRef.current;
    const token = Symbol('agent-profile-save');
    submitTokenRef.current = token;
    const requestedScope = scopeKey;
    const isCurrent = () => sequence === loadSequenceRef.current && requestedScope === activeScopeRef.current;
    setIsSubmitting(true);
    setError(null);
    let lastFileAcknowledgement: AgentProfile | null = null;
    try {
      const patchPayload = buildAgentProfileEditPatch({ agent: currentAgent, name: trimmedName, iconId,
        extensions: extensionDraft, workflowRevision,
        ...(toolsChanged ? { enabledTools: proposedEnabledTools } : {}),
        ...(canManageAgentDefaults && modelChanged ? { model: proposedModel } : {}) });
      let latestAgent = currentAgent;
      if (Object.keys(patchPayload).length > 2) {
        const patched = await fetchAgentFormJson<AgentInspection>(agentProfileEditUrl('/api/agents', scopedContext), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patchPayload),
        });
        if (!isCurrent()) return;
        if (formDraftScope) {
          // This exact revision has been acknowledged even if a later file write fails.
          clearAgentExtensionEditorDraft(scopedContext, formDraftScope.target);
        }
        latestAgent = { ...patched.agent, access: patched.agent.access ?? currentAgent.access };
        setCurrentAgent(latestAgent);
        setBindingSummaries(patched.extensions?.bindingSummaries);
        setStandaloneSummaries(patched.extensions?.standaloneSummaries);
        setWorkflowRevision(patched.extensions?.workflowRevision ?? latestAgent.workflowRevision ?? workflowRevision);
        const savedConfiguration = patched.extensions?.configuration ?? null;
        extensionDraftRef.current = { intent: 'keep', configuration: savedConfiguration };
        setExtensionDraft(extensionDraftRef.current);
        const savedWorkflowRevision = patched.extensions?.workflowRevision ?? latestAgent.workflowRevision ?? workflowRevision;
        extensionBaseline.current = savedWorkflowRevision !== null && Number.isSafeInteger(latestAgent.revision)
          ? { agentId: latestAgent.agentId, revision: latestAgent.revision!, workflowRevision: savedWorkflowRevision, configuration: savedConfiguration } : null;
        setToolsTouched(false);
        setInitialToolsDraft({ enabled: toolsOverrideEnabled, tools: customEnabledTools });
        setModelTouched(false);
      }
      for (const fileName of EDIT_AGENT_FILE_NAMES) {
        const nextContent = fileDrafts[fileName] ?? '';
        if (nextContent === (files?.[fileName] ?? '')) continue;
        const updatedFile = await fetchAgentFormJson<{ agent: AgentProfile }>(agentProfileEditUrl('/api/agents/files', scopedContext), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            agentId: latestAgent.agentId, expectedRevision: latestAgent.revision ?? 1, fileName, content: nextContent,
          }),
        });
        if (!isCurrent()) return;
        latestAgent = { ...updatedFile.agent, access: updatedFile.agent.access ?? currentAgent.access };
        setCurrentAgent(latestAgent); lastFileAcknowledgement = latestAgent;
        setFiles(previous => ({ ...EMPTY_FILES, ...previous, [fileName]: nextContent }));
      }
      if (!isCurrent()) return;
      if (formDraftScope) {
        clearAgentFormDraft(formDraftScope);
        clearAgentExtensionEditorDraft(scopedContext, formDraftScope.target);
      }
      setSavedAgent(latestAgent);
      await finishRefresh(latestAgent, sequence, requestedScope);
    } catch (saveError) {
      if (isCurrent()) {
        setError(saveError instanceof Error ? saveError.message : t('errors.saveFailed'));
        if (lastFileAcknowledgement) {
          try { await renewRetentionHints(lastFileAcknowledgement, sequence, requestedScope); }
          catch { /* Preserve every remaining form draft and require metadata recovery before another save. */ }
        }
      }
    } finally {
      if (submitTokenRef.current === token) submitTokenRef.current = null;
      if (isCurrent()) setIsSubmitting(false);
    }
  };

  const requestDeletion = async () => {
    if (!currentAgent || !canDelete || loadedScope !== scopeKey) return;
    const sequence = loadSequenceRef.current, requestedScope = scopeKey;
    const isCurrent = () => sequence === loadSequenceRef.current && requestedScope === activeScopeRef.current;
    setDeletePreviewLoading(true);
    setDeleteError(null);
    try {
      const preview = await fetchAgentFormJson<AgentDeletionPreview>(agentProfileEditUrl('/api/agents/delete-preview', scopedContext), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: currentAgent.agentId }),
      });
      if (!isCurrent()) return;
      setDeletePreview(preview);
      setDeleteConfirmation('');
      setDeleteDialogOpen(true);
    } catch (previewError) {
      if (isCurrent()) setDeleteError(previewError instanceof Error ? previewError.message : t('errors.deleteFailed'));
    } finally {
      if (isCurrent()) setDeletePreviewLoading(false);
    }
  };

  const confirmDeletion = async () => {
    if (!deletePreview || !isExactAgentDeleteConfirmation(deleteConfirmation, deletePreview.agent.name)) return;
    const sequence = loadSequenceRef.current, requestedScope = scopeKey;
    const isCurrent = () => sequence === loadSequenceRef.current && requestedScope === activeScopeRef.current;
    setDeleting(true);
    setDeleteError(null);
    try {
      await fetchAgentFormJson<{ deleted: true; agentId: string }>(agentProfileEditUrl('/api/agents', scopedContext), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: deletePreview.agent.agentId,
          expectedRevision: deletePreview.agent.revision,
          confirmationToken: deletePreview.confirmationToken,
        }),
      });
      if (!isCurrent()) return;
      const deletedAgentId = deletePreview.agent.agentId;
      setDeleteDialogOpen(false);
      resetDialogState();
      await onDeleted(deletedAgentId);
      onOpenChange(false);
    } catch (deleteFailure) {
      if (isCurrent()) setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : t('errors.deleteFailed'));
    } finally {
      if (isCurrent()) setDeleting(false);
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
                {loadedScope === scopeKey && currentAgent || agent
                  ? t('description', { name: loadedScope === scopeKey ? currentAgent?.name || agent?.name || '' : agent?.name || '' })
                  : t('descriptionFallback')}
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="h-full min-h-0 max-w-full overflow-x-hidden">
              <div className="mx-auto box-border flex w-[100dvw] max-w-[100dvw] min-w-0 flex-col gap-4 overflow-x-hidden p-3 pr-[calc(0.75rem+0.625rem)] sm:gap-5 sm:p-5 sm:pr-[calc(1.25rem+0.625rem)] md:w-full md:max-w-4xl">
                {loading && loadedScope !== scopeKey ? (
                  <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/15 text-sm text-muted-foreground" role="status">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {t('loading')}
                  </div>
                ) : null}

                {loadError && loadedScope !== scopeKey ? (
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

                {currentAgent && loadedScope === scopeKey ? (
                  <>
                    {draftConflict ? (
                      <div className="space-y-2 rounded-md border border-amber-400/40 p-3 text-sm" role="alert" data-testid="edit-agent-draft-conflict">
                        <p>{labels.draftConflict}</p>
                        <Button type="button" variant="outline" onClick={() => {
                          if (formDraftScope) {
                            clearAgentFormDraft(formDraftScope);
                            clearAgentExtensionEditorDraft(scopedContext, formDraftScope.target);
                          }
                          void loadConfiguration();
                        }}>{labels.discardDraft}</Button>
                      </div>
                    ) : null}
                    <fieldset disabled={isSubmitting || Boolean(savedAgent) || draftConflict || retentionPending || retentionError} className="contents">
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
                        onEnabledChange={(enabled) => {
                          setModelTouched(true);
                          setModelOverrideEnabled(enabled);
                          setExtensionValidation({ pending: true, blocked: false, preview: null, error: null });
                        }}
                      >
                        {!modelTouched && currentAgent && !selectionFromAgent(currentAgent)
                          && Object.values(agentProfileModelFields(currentAgent)).some(value => value !== null) ? (
                            <p className="mb-3 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                              {labels.historicalModel}
                            </p>
                          ) : null}
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
                          disabled={!modelOverrideEnabled || isSubmitting || Boolean(savedAgent)}
                          onSelectionChange={(selection) => {
                            setModelTouched(true);
                            setModelDraft(selection);
                            setExtensionValidation({ pending: true, blocked: false, preview: null, error: null });
                          }}
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

                    {workflowRevision !== null ? (
                      <AgentExtensionEditor
                        target={{ kind: 'existing', agentId: currentAgent.agentId,
                          expectedRevision: currentAgent.revision ?? 1, expectedWorkflowRevision: workflowRevision }}
                        context={scopedContext}
                        bindingSummaries={bindingSummaries} standaloneSummaries={standaloneSummaries}
                        value={extensionDraft}
                        onChange={(value) => {
                          setExtensionDraft(value);
                          setExtensionValidation({ pending: true, blocked: false, preview: null, error: null });
                        }}
                        enabledTools={toolsChanged ? proposedEnabledTools : undefined}
                        model={canManageAgentDefaults && modelChanged ? proposedModel : undefined}
                        onValidationChange={handleExtensionValidation}
                        disabled={isSubmitting || Boolean(savedAgent) || draftConflict || retentionPending || retentionError}
                      />
                    ) : null}

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
                            onChanged={handleGrantChanged}
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

                    {savedAgent && refreshError ? (
                      <div className="rounded-md border border-amber-400/40 bg-amber-50/30 px-3 py-2 text-sm dark:bg-amber-950/20"
                        role="status" data-testid="edit-agent-saved-refresh-error">
                        {labels.savedRefresh}
                      </div>
                    ) : null}

                    {error ? (
                      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                        {error}
                      </p>
                    ) : null}
                    </fieldset>
                    {retentionPending ? <p role="status" data-testid="edit-agent-retention-pending" className="text-sm text-muted-foreground">{labels.retentionPending}</p> : null}
                    {retentionError ? <div role="alert" data-testid="edit-agent-retention-error" className="space-y-2 rounded-md border border-amber-400/40 p-3 text-sm">
                      <p>{labels.retentionError}</p>
                      <Button type="button" variant="outline" disabled={retentionConflict} onClick={() => { const acknowledged = retentionRetry.current;
                        if (acknowledged) void renewRetentionHints(acknowledged, loadSequenceRef.current, scopeKey).catch(() => {});
                      }}>{labels.retryRetention}</Button>
                      <Button type="button" variant="outline" onClick={() => setConfirmRetentionReload(true)}>{labels.reloadConfiguration}</Button>
                    </div> : null}
                  </>
                ) : null}
              </div>
            </ScrollArea>

            <DialogFooter className="shrink-0 border-t bg-background/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-4">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isSubmitting || deleting || retentionPending} className="w-full sm:w-auto">
                {tCreate('cancel')}
              </Button>
              {savedAgent && refreshError ? (
                <Button type="button" variant="outline" data-testid="edit-agent-refresh"
                  onClick={() => void finishRefresh(savedAgent, loadSequenceRef.current, scopeKey)}>
                  {labels.refresh}
                </Button>
              ) : null}
              <Button type="button" onClick={() => void submit()} disabled={!canSave} data-testid="edit-agent-save" className="w-full sm:w-auto">
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

      <AlertDialog open={confirmRetentionReload} onOpenChange={setConfirmRetentionReload}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{labels.reloadConfiguration}</AlertDialogTitle>
          <AlertDialogDescription>{labels.discardUnsaved}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>{tCreate('cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => {
            setConfirmRetentionReload(false);
            if (formDraftScope) { clearAgentFormDraft(formDraftScope); clearAgentExtensionEditorDraft(scopedContext, formDraftScope.target); }
            void loadConfiguration();
          }}>{labels.reloadConfiguration}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteDialogOpen && loadedScope === scopeKey}
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
