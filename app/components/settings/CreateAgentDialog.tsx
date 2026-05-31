'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, FileText, Loader2, Menu, Plug, Search, Sparkles, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { AgentIconPickerDialog } from '@/app/components/agents/AgentIconPickerDialog';
import { AgentManagedFilesEditor, type ManagedFileName } from './AgentManagedFilesCard';
import { type AgentIconId } from '@/app/lib/agents/icons';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
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
    relevantSkills: ['brave-search', 'youtube-transcript'],
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
  files: Partial<Record<ManagedFileName, string>>;
  relevantSkills: string[];
};

type SkillOption = {
  name: string;
  description?: string;
  enabled?: boolean;
};

type ConnectionOption = {
  id: string;
  label: string;
  detail: string;
  kind: 'mcp' | 'composio';
};

type LazyLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

type CreateAgentDialogProps = {
  open: boolean;
  creating: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateAgentInput) => Promise<boolean>;
};

const CREATE_AGENT_LAZY_CACHE_TTL_MS = 2 * 60 * 1000;
let cachedSkillOptions: { expiresAt: number; data: SkillOption[] } | null = null;
let cachedConnectionOptions: { expiresAt: number; data: ConnectionOption[] } | null = null;

function mergeFileDrafts(template: CreateAgentTemplate): Record<ManagedFileName, string> {
  return {
    ...EMPTY_FILE_DRAFTS,
    ...template.files,
  };
}

function appendSection(content: string, section: string): string {
  const trimmedContent = content.trim();
  const trimmedSection = section.trim();
  if (!trimmedSection) return trimmedContent;
  return [trimmedContent, trimmedSection].filter(Boolean).join('\n\n');
}

function buildConnectionGuidance(connections: ConnectionOption[]): string {
  if (connections.length === 0) return '';

  const mcpConnections = connections.filter((connection) => connection.kind === 'mcp');
  const composioConnections = connections.filter((connection) => connection.kind === 'composio');
  const lines = [
    '## Prioritized external connections',
    '',
    'These connections are relevant for this agent. Their full tool catalogs are not loaded into the prompt; use the gateway tools to discover and call the right action.',
  ];

  if (mcpConnections.length > 0) {
    lines.push('', '### MCP servers');
    for (const connection of mcpConnections) {
      lines.push(`- ${connection.label}: use the \`mcp\` gateway. If the exact action is unclear, run \`mcp\` with \`search_tools\`, then \`describe_tool\`, then \`call_tool\`.`);
    }
  }

  if (composioConnections.length > 0) {
    lines.push('', '### Composio toolkits');
    for (const connection of composioConnections) {
      const toolkit = connection.id.replace(/^composio:/, '');
      lines.push(`- ${connection.label}: use \`COMPOSIO_SEARCH_TOOLS\`${toolkit ? ` with toolkit filter \`${toolkit}\`` : ''}, then \`COMPOSIO_GET_TOOL_SCHEMAS\`, then \`composio_execute\`.`);
    }
  }

  return lines.join('\n');
}

function hasSkill(skills: SkillOption[], name: string): boolean {
  return skills.some((skill) => skill.name === name);
}

function readCachedValue<T>(cached: { expiresAt: number; data: T } | null): T | null {
  return cached && cached.expiresAt > Date.now() ? cached.data : null;
}

function useLazyAgentSkills(shouldLoad: boolean) {
  const requestedRef = useRef(false);
  const [status, setStatus] = useState<LazyLoadStatus>('idle');
  const [skills, setSkills] = useState<SkillOption[]>([]);

  useEffect(() => {
    if (!shouldLoad || requestedRef.current) return;
    let cancelled = false;

    const cached = readCachedValue(cachedSkillOptions);
    if (cached) {
      requestedRef.current = true;
      queueMicrotask(() => {
        if (cancelled) return;
        setSkills(cached);
        setStatus('loaded');
      });
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();
    requestedRef.current = true;
    queueMicrotask(() => setStatus('loading'));

    async function loadSkills() {
      try {
        const response = await fetch('/api/skills?summary=1', {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as { success?: boolean; skills?: SkillOption[] };
        const nextSkills = response.ok && payload.success && Array.isArray(payload.skills)
          ? payload.skills.filter((skill) => skill.enabled !== false)
          : [];
        cachedSkillOptions = {
          data: nextSkills,
          expiresAt: Date.now() + CREATE_AGENT_LAZY_CACHE_TTL_MS,
        };
        if (cancelled || controller.signal.aborted) return;
        setSkills(nextSkills);
        setStatus('loaded');
      } catch {
        if (controller.signal.aborted) {
          requestedRef.current = false;
          return;
        }
        setSkills([]);
        setStatus('error');
      }
    }

    void loadSkills();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shouldLoad]);

  return { skills, status };
}

function useLazyAgentConnections(
  shouldLoad: boolean,
  formatMcpDetail: (count: number) => string,
  formatComposioDetail: (count: number) => string,
) {
  const requestedRef = useRef(false);
  const detailFormattersRef = useRef({ formatMcpDetail, formatComposioDetail });
  const [status, setStatus] = useState<LazyLoadStatus>('idle');
  const [connections, setConnections] = useState<ConnectionOption[]>([]);

  useEffect(() => {
    detailFormattersRef.current = { formatMcpDetail, formatComposioDetail };
  }, [formatComposioDetail, formatMcpDetail]);

  useEffect(() => {
    if (!shouldLoad || requestedRef.current) return;
    let cancelled = false;

    const cached = readCachedValue(cachedConnectionOptions);
    if (cached) {
      requestedRef.current = true;
      queueMicrotask(() => {
        if (cancelled) return;
        setConnections(cached);
        setStatus('loaded');
      });
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();
    requestedRef.current = true;
    queueMicrotask(() => setStatus('loading'));

    async function loadConnections() {
      const nextConnections: ConnectionOption[] = [];

      try {
        const [mcpResult, composioResult] = await Promise.allSettled([
          fetch('/api/integrations/mcp-status?summary=1', {
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
          }),
          fetch('/api/composio/toolkits?connectedOnly=1&summary=1', {
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
          }),
        ]);

        if (cancelled || controller.signal.aborted) {
          requestedRef.current = false;
          return;
        }

        if (mcpResult.status === 'fulfilled') {
          const mcpResponse = mcpResult.value;
          const mcpPayload = (await mcpResponse.json().catch(() => ({}))) as {
            success?: boolean;
            data?: { servers?: Array<{ name?: string; enabled?: boolean; cachedToolCount?: number }> };
          };
          if (mcpResponse.ok && mcpPayload.success && Array.isArray(mcpPayload.data?.servers)) {
            for (const server of mcpPayload.data.servers) {
              if (!server.name || !server.enabled) continue;
              nextConnections.push({
                id: `mcp:${server.name}`,
                kind: 'mcp',
                label: server.name,
                detail: detailFormattersRef.current.formatMcpDetail(server.cachedToolCount || 0),
              });
            }
          }
        }

        if (composioResult.status === 'fulfilled') {
          const composioResponse = composioResult.value;
          const composioPayload = (await composioResponse.json().catch(() => ({}))) as {
            toolkits?: Array<{ slug?: string; name?: string; connected?: boolean; toolsCount?: number }>;
          };
          if (composioResponse.ok && Array.isArray(composioPayload.toolkits)) {
            for (const toolkit of composioPayload.toolkits) {
              if (!toolkit.slug || !toolkit.connected) continue;
              nextConnections.push({
                id: `composio:${toolkit.slug}`,
                kind: 'composio',
                label: toolkit.name || toolkit.slug,
                detail: detailFormattersRef.current.formatComposioDetail(toolkit.toolsCount || 0),
              });
            }
          }
        }

        cachedConnectionOptions = {
          data: nextConnections,
          expiresAt: Date.now() + CREATE_AGENT_LAZY_CACHE_TTL_MS,
        };
        if (cancelled || controller.signal.aborted) return;
        setConnections(nextConnections);
        setStatus('loaded');
      } catch {
        if (controller.signal.aborted) {
          requestedRef.current = false;
          return;
        }
        setConnections([]);
        setStatus('error');
      }
    }

    void loadConnections();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shouldLoad]);

  return { connections, status };
}

function LoadingSkeletonGrid({ rows = 4 }: { rows?: number }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="rounded-md border bg-background p-3">
          <div className="flex items-start gap-3">
            <Skeleton className="h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

type TemplateListProps = {
  selectedTemplate: CreateAgentTemplate;
  onSelectTemplate: (template: CreateAgentTemplate) => void;
  compact?: boolean;
};

function TemplateList({ selectedTemplate, onSelectTemplate, compact = false }: TemplateListProps) {
  const t = useTranslations('settings.agentPanel.createDialog');

  return (
    <div className="space-y-2">
      {AGENT_TEMPLATES.map((template) => {
        const selected = template.id === selectedTemplate.id;
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelectTemplate(template)}
            className={cn(
              'flex w-full items-center gap-3 rounded-md border text-left transition',
              compact ? 'p-2.5' : 'p-3',
              selected ? 'border-primary bg-background shadow-sm' : 'border-transparent hover:border-border hover:bg-background/70',
            )}
          >
            <AgentAvatar iconId={template.iconId} className={compact ? 'h-8 w-8' : 'h-9 w-9'} iconClassName="h-4 w-4" />
            <span className="min-w-0">
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
  children: ReactNode;
};

function CreateAgentSection({
  title,
  description,
  icon: Icon,
  open,
  onOpenChange,
  children,
}: CreateAgentSectionProps) {
  return (
    <section className="overflow-hidden rounded-md border bg-muted/10">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-start justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        <span className="flex min-w-0 gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-base font-semibold">{title}</span>
            <span className="line-clamp-2 text-sm text-muted-foreground">{description}</span>
          </span>
        </span>
        <ChevronDown className={cn('mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t px-4 py-3">
          {children}
        </div>
      )}
    </section>
  );
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
  const [selectedConnections, setSelectedConnections] = useState<Set<string>>(new Set());
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);

  const selectedTemplate = useMemo(
    () => AGENT_TEMPLATES.find((template) => template.id === selectedTemplateId) || AGENT_TEMPLATES[0],
    [selectedTemplateId],
  );
  const formatMcpConnectionDetail = useCallback((count: number) => t('connections.mcpDetail', { count }), [t]);
  const formatComposioConnectionDetail = useCallback((count: number) => t('connections.composioDetail', { count }), [t]);
  const { skills, status: skillsStatus } = useLazyAgentSkills(open && skillsOpen);
  const { connections, status: connectionsStatus } = useLazyAgentConnections(
    open && connectionsOpen,
    formatMcpConnectionDetail,
    formatComposioConnectionDetail,
  );

  const applyTemplate = useCallback((template: CreateAgentTemplate) => {
    setSelectedTemplateId(template.id);
    setName(t(`templates.${template.id}.name`));
    setIconId(template.iconId);
    setFileDrafts(mergeFileDrafts(template));
    setActiveFile('AGENTS.md');
    setSelectedSkills(template.relevantSkills);
    setTemplatePickerOpen(false);
  }, [t]);

  const resetDialog = useCallback(() => {
    applyTemplate(AGENT_TEMPLATES[0]);
    setSelectedConnections(new Set());
    setConnectionsOpen(false);
    setSkillsOpen(false);
    setFilesOpen(true);
  }, [applyTemplate]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      resetDialog();
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, resetDialog]);

  const enabledSelectedSkills = skillsStatus === 'loaded'
    ? selectedSkills.filter((skillName) => hasSkill(skills, skillName))
    : selectedSkills;
  const canCreate = name.trim().length > 0 && !creating;

  async function submit() {
    if (!canCreate) return;
    const selectedConnectionOptions = connections.filter((connection) => selectedConnections.has(connection.id));
    const connectionGuidance = buildConnectionGuidance(selectedConnectionOptions);
    const submittedFileDrafts = {
      ...fileDrafts,
      'TOOLS.md': appendSection(fileDrafts['TOOLS.md'] || '', connectionGuidance),
    };
    const success = await onCreate({
      name: name.trim(),
      iconId,
      files: Object.fromEntries(
        CREATE_AGENT_FILE_NAMES.map((fileName) => [fileName, submittedFileDrafts[fileName] || '']),
      ) as Partial<Record<ManagedFileName, string>>,
      relevantSkills: enabledSelectedSkills,
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
          className="h-[100dvh] bg-background p-0 sm:h-[calc(100dvh-2rem)] md:h-[calc(100dvh-3rem)] lg:h-[calc(100dvh-4rem)]"
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

              <ScrollArea className="h-full min-h-0">
                <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:gap-5 sm:p-5">
                  <div className="md:hidden">
                    <Popover open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="outline" className="h-auto w-full justify-between gap-3 px-3 py-2 text-left">
                          <span className="flex min-w-0 items-center gap-2">
                            <Menu className="h-4 w-4 shrink-0" />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">{t(`templates.${selectedTemplate.id}.name`)}</span>
                              <span className="block truncate text-xs text-muted-foreground">{t(`templates.${selectedTemplate.id}.description`)}</span>
                            </span>
                          </span>
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-[calc(100vw-2rem)] p-2">
                        <TemplateList selectedTemplate={selectedTemplate} onSelectTemplate={applyTemplate} compact />
                      </PopoverContent>
                    </Popover>
                  </div>

                  <section className="rounded-md border bg-muted/10 p-3 sm:p-4">
                    <div className="flex gap-3 sm:items-center sm:gap-4">
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
                          className="h-12 text-lg font-semibold"
                          placeholder={t('namePlaceholder')}
                        />
                      </div>
                    </div>
                  </section>

                  <CreateAgentSection
                    title={t('connections.title')}
                    description={t('connections.description')}
                    icon={Plug}
                    open={connectionsOpen}
                    onOpenChange={setConnectionsOpen}
                  >
                    {connectionsStatus === 'loading' || connectionsStatus === 'idle' ? (
                      <LoadingSkeletonGrid rows={2} />
                    ) : connections.length === 0 ? (
                      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t('connections.empty')}</p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {connections.map((connection) => {
                          const selected = selectedConnections.has(connection.id);
                          return (
                            <button
                              key={connection.id}
                              type="button"
                              onClick={() => {
                                setSelectedConnections((current) => {
                                  const next = new Set(current);
                                  if (next.has(connection.id)) next.delete(connection.id);
                                  else next.add(connection.id);
                                  return next;
                                });
                              }}
                              className={cn(
                                'flex items-start justify-between gap-3 rounded-md border p-3 text-left transition',
                                selected ? 'border-primary bg-primary/5' : 'border-border bg-background hover:bg-muted/40',
                              )}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">{connection.label}</span>
                                <span className="block truncate text-xs text-muted-foreground">{connection.detail}</span>
                              </span>
                              <Badge variant={connection.kind === 'mcp' ? 'secondary' : 'outline'}>{connection.kind}</Badge>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </CreateAgentSection>

                  <CreateAgentSection
                    title={t('skills.title')}
                    description={t('skills.description')}
                    icon={Search}
                    open={skillsOpen}
                    onOpenChange={setSkillsOpen}
                  >
                    {skillsStatus === 'loading' || skillsStatus === 'idle' ? (
                      <LoadingSkeletonGrid rows={4} />
                    ) : skills.length === 0 ? (
                      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t('skills.empty')}</p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {skills.slice(0, 12).map((skill) => {
                          const selected = selectedSkills.includes(skill.name);
                          return (
                            <button
                              key={skill.name}
                              type="button"
                              onClick={() => {
                                setSelectedSkills((current) => (
                                  current.includes(skill.name)
                                    ? current.filter((entry) => entry !== skill.name)
                                    : [...current, skill.name]
                                ));
                              }}
                              className={cn(
                                'flex items-start gap-3 rounded-md border p-3 text-left transition',
                                selected ? 'border-primary bg-primary/5' : 'border-border bg-background hover:bg-muted/40',
                              )}
                            >
                              <span className={cn(
                                'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                                selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                              )}>
                                {selected ? <Check className="h-3.5 w-3.5" /> : null}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">{skill.name}</span>
                                <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description || t('skills.noDescription')}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </CreateAgentSection>

                  <CreateAgentSection
                    title={t('files.title')}
                    description={t('files.description')}
                    icon={FileText}
                    open={filesOpen}
                    onOpenChange={setFilesOpen}
                  >
                    <div id="onboarding-settings-managedFiles" className="space-y-3">
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
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={creating}>
                {t('cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canCreate}>
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
