'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ChevronDown, FileText, Loader2, Menu, Sparkles, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { AgentFormSection } from '@/app/components/agents/AgentFormSection';
import { AgentIconPickerDialog } from '@/app/components/agents/AgentIconPickerDialog';
import { AgentExtensionEditor, clearAgentExtensionEditorDraft, type AgentExtensionEditorContext } from '@/app/components/agents/AgentExtensionEditor';
import { readAgentFormDraft, writeAgentFormDraft, clearAgentFormDraft,
  type AgentFormDraftFields } from '@/app/components/agents/agent-form-draft-storage';
import { resolveAgentFormToolDraft, toggleAgentFormToolDraft, toggleAgentFormToolsDraft } from '@/app/components/agents/agent-profile-edit-client';
import type { AgentExtensionConfigurationInput } from '@/app/lib/capabilities/extensions/contracts';
import {
  fetchAgentFormJson,
  getExplicitEnabledToolsFromConfig,
} from '@/app/components/agents/agent-form-client';
import { AgentGrantsEditor } from '@/app/components/agents/AgentGrantsEditor';
import { AgentManagedFilesEditor, type ManagedFileName } from './AgentManagedFilesCard';
import {
  AgentCatalogModelOverrideEditor,
  initialAgentCatalogSelection,
  isAgentCatalogSelectionValid,
  type AgentCatalogModelSelection,
} from './AgentCatalogModelOverrideEditor';
import { readAdminRuntimeCatalog } from './ai-runtime/catalog-client';
import { AgentToolsEditor, type ToolMetadata } from './AgentToolsCard';
import type { AiAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/types';
import { normalizeAgentIconId, type AgentIconId } from '@/app/lib/agents/icons';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const CREATE_AGENT_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const satisfies readonly ManagedFileName[];

type CreateAgentTemplateId = 'custom' | 'research' | 'coding' | 'marketing' | 'studio' | 'automation' | 'support';

type CreateAgentTemplate = {
  id: CreateAgentTemplateId;
  iconId: AgentIconId;
  files: Partial<Record<ManagedFileName, string>>;
  suggestedSkillNames: string[];
};

const EMPTY_FILE_DRAFTS: Record<ManagedFileName, string> = {
  'AGENTS.md': '',
  'USER.md': '',
  'MEMORY.md': '',
  'SOUL.md': '',
  'TOOLS.md': '',
};

const AGENT_TEMPLATES: CreateAgentTemplate[] = [
  {
    id: 'custom',
    iconId: 'bot',
    suggestedSkillNames: [],
    files: {
      'AGENTS.md': 'You are a focused Canvas Notebook agent. Clarify the goal, work step by step, and keep outputs practical.',
      'MEMORY.md': 'No agent-specific memory yet.',
      'SOUL.md': 'Calm, direct, and useful.',
      'TOOLS.md': 'Choose tools based on the task. Prefer precise reads before changing files.',
    },
  },
  {
    id: 'research',
    iconId: 'search',
    suggestedSkillNames: ['youtube-transcript'],
    files: {
      'AGENTS.md': 'You are a research agent. Gather reliable context, compare sources, and return concise findings with clear next steps.',
      'MEMORY.md': 'Track durable research preferences, source choices, and recurring topics here.',
      'SOUL.md': 'Curious, skeptical, and concise.',
      'TOOLS.md': 'Prefer search, document reading, and citation-friendly summaries when they are relevant.',
    },
  },
  {
    id: 'coding',
    iconId: 'code',
    suggestedSkillNames: ['context7-mcp', 'code-structure'],
    files: {
      'AGENTS.md': 'You are a coding agent. Read the relevant code first, make scoped changes, and verify with focused tests.',
      'MEMORY.md': 'Remember repo conventions, architectural decisions, and recurring implementation preferences.',
      'SOUL.md': 'Pragmatic, careful, and direct.',
      'TOOLS.md': 'Use fast search, structured edits, and targeted tests before broader verification.',
    },
  },
  {
    id: 'marketing',
    iconId: 'briefcase',
    suggestedSkillNames: ['frontend-design'],
    files: {
      'AGENTS.md': 'You are a marketing agent. Turn messy goals into concrete campaign, positioning, and content outputs.',
      'MEMORY.md': 'Keep brand, audience, offer, and channel preferences here.',
      'SOUL.md': 'Sharp, commercially aware, and brand-safe.',
      'TOOLS.md': 'Use workspace context and generation tools when they improve the final asset.',
    },
  },
  {
    id: 'studio',
    iconId: 'palette',
    suggestedSkillNames: ['imagegen'],
    files: {
      'AGENTS.md': 'You are a studio agent. Help create, refine, and organize visual production work.',
      'MEMORY.md': 'Track visual style, product details, recurring prompts, and output preferences.',
      'SOUL.md': 'Visual, precise, and production-minded.',
      'TOOLS.md': 'Prefer media, image, and workspace tools when producing or reviewing assets.',
    },
  },
  {
    id: 'automation',
    iconId: 'calendar',
    suggestedSkillNames: [],
    files: {
      'AGENTS.md': 'You are an automation agent. Convert repeated work into reliable scheduled or triggered workflows.',
      'MEMORY.md': 'Remember recurring schedules, delivery preferences, and automation constraints.',
      'SOUL.md': 'Systematic, cautious, and clear.',
      'TOOLS.md': 'Use automation, channel, and workspace tools only after the workflow is explicit.',
    },
  },
  {
    id: 'support',
    iconId: 'messages',
    suggestedSkillNames: [],
    files: {
      'AGENTS.md': 'You are a support agent. Diagnose issues from user context, ask only necessary questions, and provide actionable fixes.',
      'MEMORY.md': 'Remember product context, repeated incidents, and escalation preferences.',
      'SOUL.md': 'Patient, clear, and solution-oriented.',
      'TOOLS.md': 'Use logs, docs, and connected app context to ground answers in current state.',
    },
  },
];

export type CreateAgentInput = {
  name: string;
  iconId: AgentIconId;
  scopeType: 'user' | 'organization';
  defaultProviderInstallationId: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinking: PiThinkingLevel | null;
  expectedCatalogRevision?: number;
  files: Partial<Record<ManagedFileName, string>>;
  enabledTools: string[] | null;
  extensions: AgentExtensionConfigurationInput;
};

export type CreatedAgent = {
  agentId: string;
  name: string;
  scopeType: 'user' | 'organization' | 'system';
  revision: number;
};

type CreateAgentDialogProps = {
  open: boolean;
  creating: boolean;
  error: string | null;
  canManageAgentDefaults: boolean;
  context?: AgentExtensionEditorContext;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateAgentInput) => Promise<CreatedAgent | null>;
};

function mergeFileDrafts(template: CreateAgentTemplate): Record<ManagedFileName, string> {
  return {
    ...EMPTY_FILE_DRAFTS,
    ...template.files,
  };
}

type TemplateListProps = {
  selectedTemplate: CreateAgentTemplate;
  onSelectTemplate: (template: CreateAgentTemplate) => void;
  compact?: boolean;
};

function TemplateList({ selectedTemplate, onSelectTemplate, compact = false }: TemplateListProps) {
  const t = useTranslations('settings.agentPanel.createDialog');

  return (
    <div className="min-w-0 space-y-2">
      {AGENT_TEMPLATES.map((template) => {
        const selected = template.id === selectedTemplate.id;
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelectTemplate(template)}
            className={cn(
              'flex min-w-0 w-full items-center gap-3 rounded-md border text-left transition',
              compact ? 'p-2.5' : 'p-3',
              selected ? 'border-primary bg-background shadow-sm' : 'border-transparent hover:border-border hover:bg-background/70',
            )}
          >
            <AgentAvatar iconId={template.iconId} className={cn('shrink-0', compact ? 'h-8 w-8' : 'h-9 w-9')} iconClassName="h-4 w-4" />
            <span className="min-w-0 flex-1 overflow-hidden">
              <span className="block truncate text-sm font-medium">{t(`templates.${template.id}.name`)}</span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{t(`templates.${template.id}.description`)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Changing the actor or workspace starts an independent, empty creation draft. */
export function CreateAgentDialog(props: CreateAgentDialogProps) {
  const key = JSON.stringify([props.context?.actorId ?? null, props.context?.workspaceId ?? null,
    props.context?.organizationId ?? null, props.context?.projectId ?? null, props.open]);
  return <CreateAgentDialogSession key={key} {...props} />;
}

function emptyExtensionConfiguration(): AgentExtensionConfigurationInput {
  return { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] };
}

function readCreateFormDraft(context: AgentExtensionEditorContext, canManageAgentDefaults: boolean):
  { scopeType: 'user' | 'organization'; fields: AgentFormDraftFields } | null {
  const scopes: Array<'user' | 'organization'> = canManageAgentDefaults ? ['user', 'organization'] : ['user'];
  const available = scopes.flatMap(scopeType => {
    const draft = readAgentFormDraft({ ...context, target: { kind: 'prospective', scopeType } });
    return draft.state === 'ready' ? [{ scopeType, fields: draft.fields, savedAt: draft.savedAt }] : [];
  }).sort((left, right) => right.savedAt - left.savedAt);
  return available[0] ?? null;
}

function CreateAgentDialogSession({
  open,
  creating,
  error,
  canManageAgentDefaults,
  context,
  onOpenChange,
  onCreate,
}: CreateAgentDialogProps) {
  const t = useTranslations('settings.agentPanel.createDialog');
  const editorContext = useMemo<AgentExtensionEditorContext>(() => ({ workspaceId: context?.workspaceId ?? null,
    actorId: context?.actorId ?? null, organizationId: context?.organizationId ?? null, projectId: context?.projectId ?? null }),
  [context?.actorId, context?.organizationId, context?.projectId, context?.workspaceId]);
  const [initialFormDraft] = useState(() => readCreateFormDraft(editorContext, canManageAgentDefaults));
  const [selectedTemplateId, setSelectedTemplateId] = useState<CreateAgentTemplateId>(() =>
    AGENT_TEMPLATES.find(template => template.id === initialFormDraft?.fields.selectedTemplateId)?.id ?? 'custom');
  const [name, setName] = useState(initialFormDraft?.fields.name ?? '');
  const [iconId, setIconId] = useState<AgentIconId>(() => normalizeAgentIconId(initialFormDraft?.fields.iconId));
  const [scopeType, setScopeType] = useState<'user' | 'organization'>(initialFormDraft?.scopeType ?? 'user');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [fileDrafts, setFileDrafts] = useState<Record<ManagedFileName, string>>(() => ({
    ...mergeFileDrafts(AGENT_TEMPLATES.find(template => template.id === initialFormDraft?.fields.selectedTemplateId) ?? AGENT_TEMPLATES[0]),
    ...initialFormDraft?.fields.fileDrafts,
  }));
  const [activeFile, setActiveFile] = useState<ManagedFileName>('AGENTS.md');
  const [extensionDraft, setExtensionDraft] = useState<{ intent: 'keep' | 'replace'; configuration: AgentExtensionConfigurationInput | null }>(
    () => ({ intent: 'replace', configuration: emptyExtensionConfiguration() }));
  const [extensionValidation, setExtensionValidation] = useState<{ key: string; pending: boolean; blocked: boolean } | null>(null);
  const [modelOverrideEnabled, setModelOverrideEnabled] = useState(initialFormDraft?.fields.modelOverrideEnabled ?? false);
  const [modelOpen, setModelOpen] = useState(initialFormDraft?.fields.modelOverrideEnabled ?? false);
  const [modelCatalog, setModelCatalog] = useState<AiAppRuntimeCatalog | null>(null);
  const [modelDraft, setModelDraft] = useState<AgentCatalogModelSelection | null>(initialFormDraft?.fields.modelDraft ?? null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [toolsOverrideEnabled, setToolsOverrideEnabled] = useState(initialFormDraft?.fields.toolsOverrideEnabled ?? false);
  const [toolsOpen, setToolsOpen] = useState(initialFormDraft?.fields.toolsOverrideEnabled ?? false);
  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [inheritedEnabledTools, setInheritedEnabledTools] = useState<string[] | null>(null);
  const [customEnabledTools, setCustomEnabledTools] = useState<string[] | null>(initialFormDraft?.fields.customEnabledTools ?? null);
  const [openToolRows, setOpenToolRows] = useState<Record<string, boolean>>({});
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [activeToolGroups, setActiveToolGroups] = useState<Set<string>>(new Set());
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [createdAgent, setCreatedAgent] = useState<CreatedAgent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submissionRef = useRef(false);
  const draftSettledRef = useRef(false);
  const mountedRef = useRef(true);
  const modelRequestRef = useRef(0);
  const toolsRequestRef = useRef(0);
  const modelLoadRequestedRef = useRef(false);
  const toolsLoadRequestedRef = useRef(false);
  const formDraftScope = useMemo(() => ({ ...editorContext, target: { kind: 'prospective' as const, scopeType } }), [editorContext, scopeType]);
  const usesModelOverride = canManageAgentDefaults && modelOverrideEnabled;
  const previewModel = useMemo(() => ({
    defaultProviderInstallationId: usesModelOverride ? modelDraft?.providerInstallationId ?? null : null,
    defaultProvider: usesModelOverride ? modelDraft?.providerId ?? null : null,
    defaultModel: usesModelOverride ? modelDraft?.modelId ?? null : null,
    defaultThinking: usesModelOverride ? modelDraft?.thinkingLevel ?? null : null,
    ...(usesModelOverride ? { expectedCatalogRevision: modelCatalog?.revision } : {}),
  }), [modelCatalog?.revision, modelDraft, usesModelOverride]);
  const extensionTools = toolsOverrideEnabled ? customEnabledTools ?? [] : null;
  const validationKey = JSON.stringify([scopeType, extensionDraft, extensionTools, previewModel]);
  const handleExtensionValidation = useCallback((validation: { pending: boolean; blocked: boolean }) => {
    if (mountedRef.current) setExtensionValidation({ key: validationKey, pending: validation.pending, blocked: validation.blocked });
  }, [validationKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; modelRequestRef.current += 1; toolsRequestRef.current += 1; };
  }, []);

  useEffect(() => {
    if (!open || createdAgent || draftSettledRef.current) return;
    writeAgentFormDraft(formDraftScope, { name, iconId, selectedTemplateId, fileDrafts,
      modelOverrideEnabled, modelDraft, toolsOverrideEnabled, customEnabledTools });
  }, [createdAgent, customEnabledTools, fileDrafts, formDraftScope, iconId, modelDraft, modelOverrideEnabled,
    name, open, selectedTemplateId, toolsOverrideEnabled]);

  const selectedTemplate = useMemo(
    () => AGENT_TEMPLATES.find((template) => template.id === selectedTemplateId) || AGENT_TEMPLATES[0],
    [selectedTemplateId],
  );

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
        tool.name.toLowerCase().includes(query) ||
        tool.label.toLowerCase().includes(query) ||
        tool.description.toLowerCase().includes(query) ||
        (tool.group && tool.group.toLowerCase().includes(query))
      ));
    }
    return result;
  }, [activeToolGroups, availableTools, toolSearchQuery]);

  const loadToolOptions = useCallback(async () => {
    const request = ++toolsRequestRef.current;
    const isCurrent = () => mountedRef.current && toolsRequestRef.current === request;
    setToolsLoading(true);
    setToolsError(null);
    try {
      const query = new URLSearchParams({ agentId: DEFAULT_AGENT_ID });
      for (const [key, value] of [['workspaceId', editorContext.workspaceId], ['organizationId', editorContext.organizationId], ['projectId', editorContext.projectId]] as const) {
        if (value) query.set(key, value);
      }
      const toolsPayload = await fetchAgentFormJson<{
        tools: ToolMetadata[];
        config: { enabledTools: string[] };
      }>(`/api/agents/tools?${query}`);
      if (!isCurrent()) return;
      const nextTools = toolsPayload.tools || [];
      const nextEnabledTools = toolsPayload.config?.enabledTools ?? [];
      setAvailableTools(nextTools);
      setInheritedEnabledTools(nextEnabledTools);
      setCustomEnabledTools((current) => current ?? getExplicitEnabledToolsFromConfig(nextTools, nextEnabledTools));
    } catch (loadError) {
      if (isCurrent()) setToolsError(loadError instanceof Error ? loadError.message : t('tools.loadError'));
    } finally {
      if (isCurrent()) setToolsLoading(false);
    }
  }, [editorContext, t]);

  const loadModelOptions = useCallback(async () => {
    if (!canManageAgentDefaults) return;
    const request = ++modelRequestRef.current;
    const isCurrent = () => mountedRef.current && modelRequestRef.current === request;
    setModelLoading(true);
    setModelError(null);
    try {
      const payload = await readAdminRuntimeCatalog();
      if (!isCurrent()) return;
      setModelCatalog(payload.catalog);
      setModelDraft((current) => initialAgentCatalogSelection(payload.catalog, current));
    } catch (loadError) {
      if (isCurrent()) setModelError(loadError instanceof Error ? loadError.message : t('model.loadError'));
    } finally {
      if (isCurrent()) setModelLoading(false);
    }
  }, [canManageAgentDefaults, t]);

  useEffect(() => {
    if (!canManageAgentDefaults || !open || (!modelOverrideEnabled && !modelOpen) || modelLoadRequestedRef.current) return;
    modelLoadRequestedRef.current = true;
    void loadModelOptions();
  }, [canManageAgentDefaults, loadModelOptions, modelOpen, modelOverrideEnabled, open]);

  useEffect(() => {
    if (!open || !toolsOverrideEnabled || toolsLoadRequestedRef.current) return;
    toolsLoadRequestedRef.current = true;
    void loadToolOptions();
  }, [loadToolOptions, open, toolsOverrideEnabled]);

  useEffect(() => {
    if (!toolsOverrideEnabled || customEnabledTools !== null || availableTools.length === 0 || !inheritedEnabledTools) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setCustomEnabledTools(getExplicitEnabledToolsFromConfig(availableTools, inheritedEnabledTools));
    });
    return () => {
      cancelled = true;
    };
  }, [availableTools, customEnabledTools, inheritedEnabledTools, toolsOverrideEnabled]);

  const isCreateToolEnabled = useCallback((toolName: string): boolean => {
    const allNames = availableTools.map((tool) => tool.name);
    return resolveAgentFormToolDraft(allNames, customEnabledTools).has(toolName);
  }, [availableTools, customEnabledTools]);

  const saveCreateToolsConfig = useCallback((nextEnabledTools: string[]) => {
    setCustomEnabledTools(nextEnabledTools);
  }, []);

  const handleToolToggle = useCallback((toolName: string, enabled: boolean) => {
    const currentEnabled = customEnabledTools ?? [];
    const allNames = availableTools.map((tool) => tool.name);
    saveCreateToolsConfig(toggleAgentFormToolDraft(toolName, enabled, currentEnabled, allNames));
  }, [availableTools, customEnabledTools, saveCreateToolsConfig]);

  const handleEnableAllTools = useCallback(() => {
    const allNames = availableTools.map((tool) => tool.name);
    saveCreateToolsConfig(toggleAgentFormToolsDraft(filteredTools.filter(tool => tool.availability?.available !== false)
      .map(tool => tool.name), true, customEnabledTools ?? [], allNames));
  }, [availableTools, customEnabledTools, filteredTools, saveCreateToolsConfig]);

  const handleDisableAllTools = useCallback(() => {
    const allNames = availableTools.map((tool) => tool.name);
    saveCreateToolsConfig(toggleAgentFormToolsDraft(filteredTools.map(tool => tool.name), false, customEnabledTools ?? [], allNames));
  }, [availableTools, customEnabledTools, filteredTools, saveCreateToolsConfig]);

  const toggleToolGroup = useCallback((group: string) => {
    setActiveToolGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const applyTemplate = useCallback((template: CreateAgentTemplate) => {
    setSelectedTemplateId(template.id);
    setName(t(`templates.${template.id}.name`));
    setIconId(template.iconId);
    setFileDrafts(mergeFileDrafts(template));
    setActiveFile('AGENTS.md');
    setTemplatePickerOpen(false);
  }, [t]);

  const resetDialog = useCallback(() => {
    applyTemplate(AGENT_TEMPLATES[0]);
    setExtensionDraft({ intent: 'replace', configuration: emptyExtensionConfiguration() });
    setExtensionValidation(null);
    setScopeType('user');
    setModelOverrideEnabled(false);
    setModelOpen(false);
    setModelCatalog(null);
    setModelDraft(null);
    setModelError(null);
    setToolsOverrideEnabled(false);
    setToolsOpen(false);
    setCustomEnabledTools(null);
    setOpenToolRows({});
    setToolSearchQuery('');
    setActiveToolGroups(new Set());
    setFilesOpen(false);
    setCreatedAgent(null);
    setSubmitError(null);
    modelLoadRequestedRef.current = false;
    toolsLoadRequestedRef.current = false;
  }, [applyTemplate]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (creating || submissionRef.current) return;
    onOpenChange(nextOpen);
  }, [creating, onOpenChange]);

  const discardDraft = () => {
    if (creating || submissionRef.current) return;
    draftSettledRef.current = true;
    clearAgentFormDraft(formDraftScope);
    clearAgentExtensionEditorDraft(editorContext, formDraftScope.target);
    resetDialog();
    onOpenChange(false);
  };

  const changeScope = (next: 'user' | 'organization') => {
    if (creating || submissionRef.current || next === scopeType || next === 'organization' && !canManageAgentDefaults) return;
    clearAgentFormDraft(formDraftScope);
    clearAgentExtensionEditorDraft(editorContext, formDraftScope.target);
    setScopeType(next);
    setExtensionDraft({ intent: 'replace', configuration: emptyExtensionConfiguration() });
    setExtensionValidation(null);
  };
  const canCreate = name.trim().length > 0
    && !creating
    && !submitting
    && extensionDraft.intent === 'replace' && extensionDraft.configuration !== null
    && extensionValidation?.key === validationKey && !extensionValidation.pending && !extensionValidation.blocked
    && !(usesModelOverride && (
      modelLoading
      || Boolean(modelError)
      || !isAgentCatalogSelectionValid(modelCatalog, modelDraft)
    ))
    && !(toolsOverrideEnabled && (toolsLoading || customEnabledTools === null));

  async function submit() {
    if (!canCreate || submissionRef.current || extensionDraft.configuration === null) return;
    submissionRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const agent = await onCreate({
      name: name.trim(),
      iconId,
      scopeType,
      defaultProviderInstallationId: usesModelOverride ? modelDraft?.providerInstallationId ?? null : null,
      defaultProvider: usesModelOverride ? modelDraft?.providerId ?? null : null,
      defaultModel: usesModelOverride ? modelDraft?.modelId ?? null : null,
      defaultThinking: usesModelOverride ? modelDraft?.thinkingLevel ?? null : null,
      expectedCatalogRevision: usesModelOverride ? modelCatalog?.revision : undefined,
      files: Object.fromEntries(
        CREATE_AGENT_FILE_NAMES.map((fileName) => [fileName, fileDrafts[fileName] || '']),
      ) as Partial<Record<ManagedFileName, string>>,
      enabledTools: toolsOverrideEnabled ? customEnabledTools ?? [] : null,
      extensions: structuredClone(extensionDraft.configuration),
    });
      if (agent) {
        draftSettledRef.current = true;
        clearAgentFormDraft(formDraftScope);
        clearAgentExtensionEditorDraft(editorContext, formDraftScope.target);
        if (mountedRef.current) setCreatedAgent(agent);
      }
    } catch (failure) {
      if (mountedRef.current) setSubmitError(failure instanceof Error ? failure.message : t('description'));
    } finally {
      submissionRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        layout="viewport"
        className="h-[100dvh] min-w-0 bg-background p-0 sm:h-[calc(100dvh-2rem)] md:h-[calc(100dvh-3rem)] lg:h-[calc(100dvh-4rem)]"
      >
        {createdAgent ? (
          <div className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader className="shrink-0 border-b px-4 py-3 pr-14 sm:px-5 sm:py-4">
              <DialogTitle>{t('accessTitle', { name: createdAgent.name })}</DialogTitle>
              <DialogDescription>{t('accessDescription')}</DialogDescription>
            </DialogHeader>
            <ScrollArea className="h-full min-h-0">
              <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
                {createdAgent.scopeType === 'organization' ? (
                  <AgentGrantsEditor
                    key={createdAgent.agentId}
                    active={open}
                    agentId={createdAgent.agentId}
                    revision={createdAgent.revision}
                  />
                ) : (
                  <div className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground" data-testid="personal-agent-created">
                    {t('personalCreatedDescription')}
                  </div>
                )}
              </div>
            </ScrollArea>
            <DialogFooter className="shrink-0 border-t bg-background/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-4">
              <Button type="button" onClick={() => handleOpenChange(false)} className="w-full sm:w-auto">
                {t('done')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader className="shrink-0 border-b px-4 py-3 pr-14 sm:px-5 sm:py-4">
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('description')}</DialogDescription>
            </DialogHeader>

            <div className="grid min-h-0 overflow-hidden md:grid-cols-[17rem_minmax(0,1fr)]">
              <aside className="hidden min-h-0 border-r bg-muted/35 p-3 md:block">
                <ScrollArea className="h-full">
                  <div className="space-y-2 pr-2">
                    <TemplateList selectedTemplate={selectedTemplate} onSelectTemplate={applyTemplate} />
                  </div>
                </ScrollArea>
              </aside>

              <ScrollArea className="h-full min-h-0 max-w-full overflow-x-hidden">
                <div className="mx-auto box-border flex w-[100dvw] max-w-[100dvw] min-w-0 flex-col gap-4 overflow-x-hidden p-3 pr-[calc(0.75rem+0.625rem)] sm:gap-5 sm:p-5 sm:pr-[calc(1.25rem+0.625rem)] md:w-full md:max-w-4xl">
                  <div className="md:hidden">
                    <div className="min-w-0 overflow-hidden rounded-md border bg-background">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto min-w-0 w-full justify-between gap-3 rounded-md border-0 px-3 py-2 text-left shadow-none"
                        aria-expanded={templatePickerOpen}
                        aria-controls="create-agent-template-list"
                        onClick={() => setTemplatePickerOpen((current) => !current)}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <Menu className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1 overflow-hidden">
                            <span className="block truncate text-sm font-medium">{t(`templates.${selectedTemplate.id}.name`)}</span>
                            <span className="block truncate text-xs text-muted-foreground">{t(`templates.${selectedTemplate.id}.description`)}</span>
                          </span>
                        </span>
                        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', templatePickerOpen && 'rotate-180')} />
                      </Button>
                      {templatePickerOpen && (
                        <div id="create-agent-template-list" className="max-h-[min(28rem,calc(100dvh-12rem))] overflow-y-auto border-t p-2">
                          <TemplateList selectedTemplate={selectedTemplate} onSelectTemplate={applyTemplate} compact />
                        </div>
                      )}
                    </div>
                  </div>

                  <section className="min-w-0 overflow-hidden rounded-md border bg-muted/10 p-3 sm:p-4">
                    <div className="flex min-w-0 flex-col gap-3 min-[420px]:flex-row min-[420px]:items-center sm:gap-4">
                      <button
                        type="button"
                        onClick={() => setIconPickerOpen(true)}
                        className="group shrink-0 self-start rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                        title={t('changeIcon')}
                      >
                        <AgentAvatar
                          iconId={iconId}
                          className="h-16 w-16 border-primary/30 bg-background group-hover:bg-muted sm:h-20 sm:w-20"
                          iconClassName="h-8 w-8 sm:h-10 sm:w-10"
                        />
                      </button>
                      <div className="min-w-0 flex-1 space-y-2">
                        <label className="text-xs font-medium uppercase text-muted-foreground" htmlFor="create-agent-name">
                          {t('nameLabel')}
                        </label>
                        <Input
                          id="create-agent-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          className="h-12 min-w-0 text-base font-semibold sm:text-lg"
                          placeholder={t('namePlaceholder')}
                        />
                        <div className="space-y-2 pt-1" data-testid="agent-scope-picker">
                          <span className="block text-xs font-medium uppercase text-muted-foreground">{t('scope.label')}</span>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <button
                              type="button"
                              onClick={() => changeScope('user')}
                              disabled={creating || submitting}
                              aria-pressed={scopeType === 'user'}
                              className={cn(
                                'rounded-md border px-3 py-2 text-left text-sm transition-colors',
                                scopeType === 'user' ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
                              )}
                            >
                              <span className="block font-medium">{t('scope.personal')}</span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">{t('scope.personalDescription')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => changeScope('organization')}
                              aria-pressed={scopeType === 'organization'}
                              disabled={!canManageAgentDefaults || creating || submitting}
                              className={cn(
                                'rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                                scopeType === 'organization' ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
                              )}
                            >
                              <span className="block font-medium">{t('scope.organization')}</span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {canManageAgentDefaults ? t('scope.organizationDescription') : t('scope.organizationAdminOnly')}
                              </span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  <AgentExtensionEditor
                    key={scopeType}
                    context={editorContext}
                    target={{ kind: 'prospective', scopeType }}
                    value={extensionDraft}
                    onChange={setExtensionDraft}
                    enabledTools={extensionTools}
                    model={previewModel}
                    disabled={creating || submitting}
                    onValidationChange={handleExtensionValidation}
                    suggestedSkillNames={selectedTemplate.suggestedSkillNames}
                  />

                  <details className="min-w-0 rounded-md border bg-muted/10" data-testid="create-agent-advanced"
                    open={Boolean(initialFormDraft?.fields.modelOverrideEnabled || initialFormDraft?.fields.toolsOverrideEnabled)}>
                    <summary className="cursor-pointer px-3 py-3 text-sm font-medium sm:px-4">{t('advanced')}</summary>
                    <div className="min-w-0 space-y-4 border-t p-3 sm:p-4">
                  {canManageAgentDefaults ? (
                    <AgentFormSection
                      title={t('model.title')}
                      description={t('model.description')}
                      icon={Brain}
                      open={modelOpen}
                      onOpenChange={setModelOpen}
                      enabled={modelOverrideEnabled}
                      showWhenDisabled
                      onEnabledChange={setModelOverrideEnabled}
                    >
                      {!modelOverrideEnabled && (
                        <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm leading-relaxed text-muted-foreground">
                          {t('model.inheritedDefault')}
                        </p>
                      )}
                      <AgentCatalogModelOverrideEditor
                        catalog={modelCatalog}
                        selection={modelDraft}
                        loading={modelLoading}
                        error={modelError}
                        disabled={!modelOverrideEnabled}
                        onSelectionChange={setModelDraft}
                        onRetry={loadModelOptions}
                      />
                    </AgentFormSection>
                  ) : (
                    <section className="flex min-w-0 items-start gap-3 rounded-md border bg-muted/10 p-3 sm:gap-4 sm:p-4">
                      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                        <Brain className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 space-y-1">
                        <span className="block text-base font-semibold">{t('model.title')}</span>
                        <span className="block text-sm leading-relaxed text-muted-foreground">
                          {t('model.adminOnlyDescription')}
                        </span>
                      </span>
                    </section>
                  )}

                  <AgentFormSection
                    title={t('tools.title')}
                    description={t('tools.description')}
                    icon={Wrench}
                    open={toolsOpen}
                    onOpenChange={setToolsOpen}
                    enabled={toolsOverrideEnabled}
                    onEnabledChange={setToolsOverrideEnabled}
                  >
                    <AgentToolsEditor
                      availableTools={availableTools}
                      filteredTools={filteredTools}
                      toolGroups={toolGroups}
                      activeToolGroups={activeToolGroups}
                      openToolRows={openToolRows}
                      toolsLoading={toolsLoading}
                      toolsSaving={false}
                      toolsError={toolsError}
                      toolSearchQuery={toolSearchQuery}
                      isToolEnabled={isCreateToolEnabled}
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
                    title={t('files.title')}
                    description={t('files.description')}
                    icon={FileText}
                    open={filesOpen}
                    onOpenChange={setFilesOpen}
                  >
                    <div id="onboarding-settings-managedFiles" className="min-w-0 space-y-3">
                      <AgentManagedFilesEditor
                        isMainAgent={false}
                        files={fileDrafts}
                        fileDrafts={fileDrafts}
                        activeFile={activeFile}
                        filesLoading={false}
                        onActiveFileChange={setActiveFile}
                        onDraftChange={(fileName, value) => setFileDrafts((current) => ({ ...current, [fileName]: value }))}
                        visibleFileNames={CREATE_AGENT_FILE_NAMES}
                        showInheritedFiles={false}
                        editorClassName="h-[clamp(220px,34dvh,360px)]"
                      />
                    </div>
                  </AgentFormSection>
                    </div>
                  </details>

                  {(error || submitError) && <p role="alert" className="text-sm text-destructive">{error || submitError}</p>}
                </div>
              </ScrollArea>
            </div>

            <DialogFooter className="shrink-0 border-t bg-background/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-4">
              <Button type="button" variant="ghost" onClick={discardDraft} disabled={creating || submitting} className="w-full sm:mr-auto sm:w-auto">
                {t('discardDraft')}
              </Button>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={creating || submitting} className="w-full sm:w-auto">
                {t('cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canCreate} className="w-full sm:w-auto">
                {creating || submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                {creating || submitting ? t('creating') : t('create')}
              </Button>
            </DialogFooter>
          </div>
        )}

        <AgentIconPickerDialog
          open={iconPickerOpen}
          value={iconId}
          onOpenChange={setIconPickerOpen}
          onValueChange={setIconId}
        />
      </DialogContent>
    </Dialog>
  );
}
