'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Brain, ChevronDown, FileText, Loader2, Menu, Plug, Search, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { AgentIconPickerDialog } from '@/app/components/agents/AgentIconPickerDialog';
import { AgentManagedFilesEditor, type ManagedFileName } from './AgentManagedFilesCard';
import { AgentConnectionsPicker, AgentRelevantSkillsPicker } from './AgentCapabilityPickers';
import {
  CreateAgentModelOverrideEditor,
  getInitialCreateAgentModelDraft,
  type CreateAgentModelDiscovery,
  type CreateAgentModelDraft,
} from './CreateAgentModelOverrideEditor';
import { AgentToolsEditor, type ToolMetadata } from './AgentToolsCard';
import { type AgentIconId } from '@/app/lib/agents/icons';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import {
  disableToolInConfig,
  enableToolInConfig,
  getDefaultEnabledToolNames,
  isDefaultToolsConfig,
  resolveEnabledToolNames,
  serializeEnabledToolNames,
} from '@/app/lib/pi/enabled-tools';
import type { PiRuntimeConfig, PiThinkingLevel } from '@/app/lib/pi/config';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const CREATE_AGENT_FILE_NAMES = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const satisfies readonly ManagedFileName[];

type CreateAgentTemplateId = 'custom' | 'research' | 'coding' | 'marketing' | 'studio' | 'automation' | 'support';

type CreateAgentTemplate = {
  id: CreateAgentTemplateId;
  iconId: AgentIconId;
  files: Partial<Record<ManagedFileName, string>>;
  relevantSkills: string[];
};

const EMPTY_FILE_DRAFTS: Record<ManagedFileName, string> = {
  'AGENTS.md': '',
  'USER.md': '',
  'MEMORY.md': '',
  'SOUL.md': '',
  'TOOLS.md': '',
  'HEARTBEAT.md': '',
};

const AGENT_TEMPLATES: CreateAgentTemplate[] = [
  {
    id: 'custom',
    iconId: 'bot',
    relevantSkills: [],
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
    relevantSkills: ['youtube-transcript'],
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
    relevantSkills: ['context7-mcp', 'code-structure'],
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
    relevantSkills: ['frontend-design'],
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
    relevantSkills: ['imagegen'],
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
    relevantSkills: [],
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
    relevantSkills: [],
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
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinking: PiThinkingLevel | null;
  files: Partial<Record<ManagedFileName, string>>;
  enabledTools: string[] | null;
  relevantSkills: string[] | null;
  relevantConnections: string[] | null;
};

type PiConfigData = PiRuntimeConfig;

type CreateAgentDialogProps = {
  open: boolean;
  creating: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateAgentInput) => Promise<boolean>;
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

type CreateAgentSectionProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  children: ReactNode;
};

function CreateAgentSection({
  title,
  description,
  icon: Icon,
  open,
  onOpenChange,
  enabled = true,
  onEnabledChange,
  children,
}: CreateAgentSectionProps) {
  const contentAvailable = enabled;

  return (
    <section className="min-w-0 overflow-hidden rounded-md border bg-muted/10">
      <div className="flex min-w-0 items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/30 sm:gap-4 sm:px-4">
        <button
          type="button"
          onClick={() => contentAvailable && onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left disabled:cursor-default"
          aria-expanded={contentAvailable && open}
          disabled={!contentAvailable}
        >
          <span className="flex min-w-0 flex-1 gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-base font-semibold">{title}</span>
              <span className="line-clamp-2 text-sm text-muted-foreground">{description}</span>
            </span>
          </span>
          {contentAvailable && (
            <ChevronDown className={cn('mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
          )}
        </button>
        {onEnabledChange && (
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              onEnabledChange(checked);
              if (checked) onOpenChange(true);
            }}
            aria-label={title}
            className="mt-1 shrink-0"
          />
        )}
      </div>
      {contentAvailable && open && (
        <div className="min-w-0 border-t px-3 py-3 sm:px-4">
          {children}
        </div>
      )}
    </section>
  );
}

async function fetchCreateAgentJson<T>(input: string): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: T;
  };
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload.data as T;
}

function getExplicitEnabledToolsFromConfig(tools: ToolMetadata[], piConfig: PiConfigData | null): string[] | null {
  if (!piConfig) return null;
  const allNames = tools.map((tool) => tool.name);
  const activeProvider = piConfig.providers[piConfig.activeProvider];
  const enabledTools = activeProvider?.enabledTools ?? [];
  const enabledSet = isDefaultToolsConfig(enabledTools)
    ? getDefaultEnabledToolNames(allNames)
    : resolveEnabledToolNames(allNames, enabledTools);
  return serializeEnabledToolNames(enabledSet, allNames);
}

export function CreateAgentDialog({
  open,
  creating,
  error,
  onOpenChange,
  onCreate,
}: CreateAgentDialogProps) {
  const t = useTranslations('settings.agentPanel.createDialog');
  const [selectedTemplateId, setSelectedTemplateId] = useState<CreateAgentTemplateId>('custom');
  const [name, setName] = useState('');
  const [iconId, setIconId] = useState<AgentIconId>('bot');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [fileDrafts, setFileDrafts] = useState<Record<ManagedFileName, string>>(() => mergeFileDrafts(AGENT_TEMPLATES[0]));
  const [activeFile, setActiveFile] = useState<ManagedFileName>('AGENTS.md');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillsOverrideEnabled, setSkillsOverrideEnabled] = useState(false);
  const [selectedConnections, setSelectedConnections] = useState<string[]>([]);
  const [connectionsOverrideEnabled, setConnectionsOverrideEnabled] = useState(false);
  const [modelOverrideEnabled, setModelOverrideEnabled] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelPiConfig, setModelPiConfig] = useState<PiConfigData | null>(null);
  const [modelDiscovery, setModelDiscovery] = useState<CreateAgentModelDiscovery>({});
  const [modelDraft, setModelDraft] = useState<CreateAgentModelDraft>({ provider: '', model: '', thinking: 'off' });
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [toolsOverrideEnabled, setToolsOverrideEnabled] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [availableTools, setAvailableTools] = useState<ToolMetadata[]>([]);
  const [toolsPiConfig, setToolsPiConfig] = useState<PiConfigData | null>(null);
  const [customEnabledTools, setCustomEnabledTools] = useState<string[] | null>(null);
  const [openToolRows, setOpenToolRows] = useState<Record<string, boolean>>({});
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [activeToolGroups, setActiveToolGroups] = useState<Set<string>>(new Set());
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);
  const modelLoadRequestedRef = useRef(false);
  const toolsLoadRequestedRef = useRef(false);

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
    setToolsLoading(true);
    setToolsError(null);
    try {
      const [toolsPayload, configPayload] = await Promise.all([
        fetchCreateAgentJson<{ tools: ToolMetadata[] }>(`/api/agents/tools?${new URLSearchParams({ agentId: DEFAULT_AGENT_ID }).toString()}`),
        fetchCreateAgentJson<{ piConfig: PiConfigData }>(`/api/agents/config?${new URLSearchParams({ agentId: DEFAULT_AGENT_ID }).toString()}`),
      ]);
      const nextTools = toolsPayload.tools || [];
      const nextConfig = configPayload.piConfig;
      setAvailableTools(nextTools);
      setToolsPiConfig(nextConfig);
      setCustomEnabledTools((current) => current ?? getExplicitEnabledToolsFromConfig(nextTools, nextConfig));
    } catch (loadError) {
      setToolsError(loadError instanceof Error ? loadError.message : t('tools.loadError'));
    } finally {
      setToolsLoading(false);
    }
  }, [t]);

  const loadModelOptions = useCallback(async () => {
    setModelLoading(true);
    setModelError(null);
    try {
      const payload = await fetchCreateAgentJson<{ piConfig: PiConfigData; discovery: CreateAgentModelDiscovery }>(
        `/api/agents/config?${new URLSearchParams({ agentId: DEFAULT_AGENT_ID, readiness: 'false' }).toString()}`,
      );
      const nextConfig = payload.piConfig;
      const nextDiscovery = payload.discovery || {};
      setModelPiConfig(nextConfig);
      setModelDiscovery(nextDiscovery);
      setModelDraft((current) => (
        current.provider && current.model
          ? current
          : getInitialCreateAgentModelDraft(nextConfig, nextDiscovery)
      ));
    } catch (loadError) {
      setModelError(loadError instanceof Error ? loadError.message : t('model.loadError'));
    } finally {
      setModelLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open || !modelOverrideEnabled || modelLoadRequestedRef.current) return;
    modelLoadRequestedRef.current = true;
    void loadModelOptions();
  }, [loadModelOptions, modelOverrideEnabled, open]);

  useEffect(() => {
    if (!open || !toolsOverrideEnabled || toolsLoadRequestedRef.current) return;
    toolsLoadRequestedRef.current = true;
    void loadToolOptions();
  }, [loadToolOptions, open, toolsOverrideEnabled]);

  useEffect(() => {
    if (!toolsOverrideEnabled || customEnabledTools !== null || availableTools.length === 0 || !toolsPiConfig) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setCustomEnabledTools(getExplicitEnabledToolsFromConfig(availableTools, toolsPiConfig));
    });
    return () => {
      cancelled = true;
    };
  }, [availableTools, customEnabledTools, toolsOverrideEnabled, toolsPiConfig]);

  const isCreateToolEnabled = useCallback((toolName: string): boolean => {
    const allNames = availableTools.map((tool) => tool.name);
    const enabledTools = customEnabledTools ?? [];
    if (isDefaultToolsConfig(enabledTools)) {
      return getDefaultEnabledToolNames(allNames).has(toolName);
    }
    return resolveEnabledToolNames(allNames, enabledTools).has(toolName);
  }, [availableTools, customEnabledTools]);

  const saveCreateToolsConfig = useCallback((nextEnabledTools: string[]) => {
    setCustomEnabledTools(nextEnabledTools);
  }, []);

  const handleToolToggle = useCallback((toolName: string, enabled: boolean) => {
    const currentEnabled = customEnabledTools ?? [];
    const allNames = availableTools.map((tool) => tool.name);
    saveCreateToolsConfig(
      enabled
        ? enableToolInConfig(toolName, currentEnabled, allNames)
        : disableToolInConfig(toolName, currentEnabled, allNames),
    );
  }, [availableTools, customEnabledTools, saveCreateToolsConfig]);

  const handleEnableAllTools = useCallback(() => {
    const allNames = availableTools.map((tool) => tool.name);
    const enabledNames = availableTools
      .filter((tool) => tool.availability?.available !== false)
      .map((tool) => tool.name);
    saveCreateToolsConfig(serializeEnabledToolNames(enabledNames, allNames));
  }, [availableTools, saveCreateToolsConfig]);

  const handleDisableAllTools = useCallback(() => {
    saveCreateToolsConfig(['__none__']);
  }, [saveCreateToolsConfig]);

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
    setSelectedSkills(template.relevantSkills);
    setSkillsOverrideEnabled(template.relevantSkills.length > 0);
    setSkillsOpen(template.relevantSkills.length > 0);
    setTemplatePickerOpen(false);
  }, [t]);

  const resetDialog = useCallback(() => {
    applyTemplate(AGENT_TEMPLATES[0]);
    setSelectedConnections([]);
    setConnectionsOverrideEnabled(false);
    setConnectionsOpen(false);
    setModelOverrideEnabled(false);
    setModelOpen(false);
    setModelDraft({ provider: '', model: '', thinking: 'off' });
    setModelError(null);
    setToolsOverrideEnabled(false);
    setToolsOpen(false);
    setCustomEnabledTools(null);
    setOpenToolRows({});
    setToolSearchQuery('');
    setActiveToolGroups(new Set());
    setSkillsOpen(false);
    setFilesOpen(true);
    modelLoadRequestedRef.current = false;
    toolsLoadRequestedRef.current = false;
  }, [applyTemplate]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      resetDialog();
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, resetDialog]);

  const canCreate = name.trim().length > 0
    && !creating
    && !(modelOverrideEnabled && (modelLoading || Boolean(modelError) || !modelDraft.provider.trim() || !modelDraft.model.trim()))
    && !(toolsOverrideEnabled && (toolsLoading || customEnabledTools === null));

  async function submit() {
    if (!canCreate) return;
    const success = await onCreate({
      name: name.trim(),
      iconId,
      defaultProvider: modelOverrideEnabled ? modelDraft.provider.trim() : null,
      defaultModel: modelOverrideEnabled ? modelDraft.model.trim() : null,
      defaultThinking: modelOverrideEnabled ? modelDraft.thinking : null,
      files: Object.fromEntries(
        CREATE_AGENT_FILE_NAMES.map((fileName) => [fileName, fileDrafts[fileName] || '']),
      ) as Partial<Record<ManagedFileName, string>>,
      enabledTools: toolsOverrideEnabled ? customEnabledTools ?? [] : null,
      relevantSkills: skillsOverrideEnabled ? selectedSkills : null,
      relevantConnections: connectionsOverrideEnabled ? selectedConnections : null,
    });
    if (success) {
      resetDialog();
      onOpenChange(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          layout="viewport"
          className="h-[100dvh] w-full max-w-full bg-background p-0 sm:h-[calc(100dvh-2rem)] md:h-[calc(100dvh-3rem)] lg:h-[calc(100dvh-4rem)]"
        >
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
                    <Popover open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="outline" className="h-auto min-w-0 w-full justify-between gap-3 px-3 py-2 text-left">
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <Menu className="h-4 w-4 shrink-0" />
                            <span className="min-w-0 flex-1 overflow-hidden">
                              <span className="block truncate text-sm font-medium">{t(`templates.${selectedTemplate.id}.name`)}</span>
                              <span className="block truncate text-xs text-muted-foreground">{t(`templates.${selectedTemplate.id}.description`)}</span>
                            </span>
                          </span>
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="max-h-[min(28rem,calc(100dvh-8rem))] w-[calc(100vw-1.5rem)] overflow-y-auto p-2">
                        <TemplateList selectedTemplate={selectedTemplate} onSelectTemplate={applyTemplate} compact />
                      </PopoverContent>
                    </Popover>
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
                      </div>
                    </div>
                  </section>

                  <CreateAgentSection
                    title={t('model.title')}
                    description={t('model.description')}
                    icon={Brain}
                    open={modelOpen}
                    onOpenChange={setModelOpen}
                    enabled={modelOverrideEnabled}
                    onEnabledChange={setModelOverrideEnabled}
                  >
                    <CreateAgentModelOverrideEditor
                      piConfig={modelPiConfig}
                      discovery={modelDiscovery}
                      draft={modelDraft}
                      loading={modelLoading}
                      error={modelError}
                      onDraftChange={setModelDraft}
                      onRetry={loadModelOptions}
                    />
                  </CreateAgentSection>

                  <CreateAgentSection
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
                  </CreateAgentSection>

                  <CreateAgentSection
                    title={t('connections.title')}
                    description={t('connections.description')}
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
                  </CreateAgentSection>

                  <CreateAgentSection
                    title={t('skills.title')}
                    description={t('skills.description')}
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
                  </CreateAgentSection>

                  <CreateAgentSection
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
                  </CreateAgentSection>

                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              </ScrollArea>
            </div>

            <DialogFooter className="shrink-0 border-t bg-background/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-4">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={creating} className="w-full sm:w-auto">
                {t('cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canCreate} className="w-full sm:w-auto">
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                {creating ? t('creating') : t('create')}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <AgentIconPickerDialog
        open={iconPickerOpen}
        value={iconId}
        onOpenChange={setIconPickerOpen}
        onValueChange={setIconId}
      />
    </>
  );
}
