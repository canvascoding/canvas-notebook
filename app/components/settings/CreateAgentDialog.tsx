'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plug, Search, Sparkles } from 'lucide-react';
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
import { ScrollArea } from '@/components/ui/scroll-area';
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
  'IDENTITY.md': '',
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

function hasSkill(skills: SkillOption[], name: string): boolean {
  return skills.some((skill) => skill.name === name);
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
  const [fileDrafts, setFileDrafts] = useState<Record<ManagedFileName, string>>(() => mergeFileDrafts(AGENT_TEMPLATES[0]));
  const [activeFile, setActiveFile] = useState<ManagedFileName>('AGENTS.md');
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [selectedConnections, setSelectedConnections] = useState<Set<string>>(new Set());

  const selectedTemplate = useMemo(
    () => AGENT_TEMPLATES.find((template) => template.id === selectedTemplateId) || AGENT_TEMPLATES[0],
    [selectedTemplateId],
  );

  const applyTemplate = useCallback((template: CreateAgentTemplate) => {
    setSelectedTemplateId(template.id);
    setName(t(`templates.${template.id}.name`));
    setIconId(template.iconId);
    setFileDrafts(mergeFileDrafts(template));
    setActiveFile('AGENTS.md');
    setSelectedSkills(template.relevantSkills);
  }, [t]);

  const resetDialog = useCallback(() => {
    applyTemplate(AGENT_TEMPLATES[0]);
    setSelectedConnections(new Set());
  }, [applyTemplate]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      resetDialog();
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, resetDialog]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function loadSkills() {
      setSkillsLoading(true);
      try {
        const response = await fetch('/api/skills', { credentials: 'include', cache: 'no-store' });
        const payload = (await response.json().catch(() => ({}))) as { success?: boolean; skills?: SkillOption[] };
        if (!cancelled && response.ok && payload.success && Array.isArray(payload.skills)) {
          setSkills(payload.skills.filter((skill) => skill.enabled !== false));
        }
      } catch {
        if (!cancelled) setSkills([]);
      } finally {
        if (!cancelled) setSkillsLoading(false);
      }
    }

    async function loadConnections() {
      setConnectionsLoading(true);
      try {
        const [mcpResponse, composioResponse] = await Promise.all([
          fetch('/api/integrations/mcp-status', { credentials: 'include', cache: 'no-store' }),
          fetch('/api/composio/toolkits', { credentials: 'include', cache: 'no-store' }),
        ]);
        const nextConnections: ConnectionOption[] = [];
        const mcpPayload = (await mcpResponse.json().catch(() => ({}))) as {
          success?: boolean;
          data?: { servers?: Array<{ name?: string; connected?: boolean; enabled?: boolean; cachedToolCount?: number }> };
        };
        if (mcpResponse.ok && mcpPayload.success && Array.isArray(mcpPayload.data?.servers)) {
          for (const server of mcpPayload.data.servers) {
            if (!server.name || !server.enabled) continue;
            nextConnections.push({
              id: `mcp:${server.name}`,
              kind: 'mcp',
              label: server.name,
              detail: t('connections.mcpDetail', { count: server.cachedToolCount || 0 }),
            });
          }
        }

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
              detail: t('connections.composioDetail', { count: toolkit.toolsCount || 0 }),
            });
          }
        }

        if (!cancelled) setConnections(nextConnections);
      } catch {
        if (!cancelled) setConnections([]);
      } finally {
        if (!cancelled) setConnectionsLoading(false);
      }
    }

    void loadSkills();
    void loadConnections();
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const enabledSelectedSkills = selectedSkills.filter((skillName) => hasSkill(skills, skillName));
  const canCreate = name.trim().length > 0 && !creating;

  async function submit() {
    if (!canCreate) return;
    const success = await onCreate({
      name: name.trim(),
      iconId,
      files: Object.fromEntries(
        CREATE_AGENT_FILE_NAMES.map((fileName) => [fileName, fileDrafts[fileName] || '']),
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
        <DialogContent layout="viewport" className="bg-background p-0">
          <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader className="border-b px-5 py-4 pr-14">
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('description')}</DialogDescription>
            </DialogHeader>

            <div className="grid min-h-0 grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]">
              <aside className="border-b bg-muted/40 p-3 md:border-b-0 md:border-r">
                <ScrollArea className="h-52 md:h-full">
                  <div className="space-y-2 pr-2">
                    {AGENT_TEMPLATES.map((template) => {
                      const selected = template.id === selectedTemplate.id;
                      return (
                        <button
                          key={template.id}
                          type="button"
                          onClick={() => applyTemplate(template)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md border p-3 text-left transition',
                            selected ? 'border-primary bg-background shadow-sm' : 'border-transparent hover:border-border hover:bg-background/70',
                          )}
                        >
                          <AgentAvatar iconId={template.iconId} className="h-9 w-9" iconClassName="h-4.5 w-4.5" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{t(`templates.${template.id}.name`)}</span>
                            <span className="line-clamp-2 text-xs text-muted-foreground">{t(`templates.${template.id}.description`)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              </aside>

              <ScrollArea className="min-h-0">
                <div className="mx-auto flex max-w-5xl flex-col gap-5 p-5">
                  <section className="rounded-md border bg-muted/15 p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                      <button
                        type="button"
                        onClick={() => setIconPickerOpen(true)}
                        className="group self-start rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                        title={t('changeIcon')}
                      >
                        <AgentAvatar
                          iconId={iconId}
                          className="h-20 w-20 border-primary/30 bg-background group-hover:bg-muted"
                          iconClassName="h-10 w-10"
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

                  <section className="rounded-md border bg-muted/15 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-base font-semibold">{t('connections.title')}</h3>
                        <p className="text-sm text-muted-foreground">{t('connections.description')}</p>
                      </div>
                      <Plug className="h-5 w-5 text-muted-foreground" />
                    </div>
                    {connectionsLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('connections.loading')}
                      </div>
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
                  </section>

                  <section className="rounded-md border bg-muted/15 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-base font-semibold">{t('skills.title')}</h3>
                        <p className="text-sm text-muted-foreground">{t('skills.description')}</p>
                      </div>
                      <Search className="h-5 w-5 text-muted-foreground" />
                    </div>
                    {skillsLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('skills.loading')}
                      </div>
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
                  </section>

                  <section className="rounded-md border bg-muted/15 p-4">
                    <div id="onboarding-settings-managedFiles" className="space-y-3">
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold">{t('files.title')}</h3>
                        <p className="text-sm text-muted-foreground">{t('files.description')}</p>
                      </div>
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
                        editorClassName="h-[300px]"
                      />
                    </div>
                  </section>

                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              </ScrollArea>
            </div>

            <DialogFooter className="border-t px-5 py-4">
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
