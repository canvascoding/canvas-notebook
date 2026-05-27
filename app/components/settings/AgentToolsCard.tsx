'use client';

import { ChevronDown, Loader2, Search, Wrench, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

export type ToolMetadata = {
  name: string;
  label: string;
  description: string;
  group?: string;
  parameters?: string[];
  planningModeAllowed?: boolean;
  defaultEnabled?: boolean;
  notes?: string[];
};

type AgentToolsCardProps = {
  availableTools: ToolMetadata[];
  filteredTools: ToolMetadata[];
  toolGroups: string[];
  activeToolGroups: Set<string>;
  openToolRows: Record<string, boolean>;
  toolsLoading: boolean;
  toolsSaving: boolean;
  toolsError: string | null;
  toolSearchQuery: string;
  isToolEnabled: (toolName: string) => boolean;
  onToolSearchQueryChange: (value: string) => void;
  onToggleToolGroup: (group: string) => void;
  onClearToolGroups: () => void;
  onToolRowOpenChange: (toolName: string, open: boolean) => void;
  onToolToggle: (toolName: string, enabled: boolean) => void;
  onEnableAll: () => void;
  onDisableAll: () => void;
};

export function AgentToolsCard({
  availableTools,
  filteredTools,
  toolGroups,
  activeToolGroups,
  openToolRows,
  toolsLoading,
  toolsSaving,
  toolsError,
  toolSearchQuery,
  isToolEnabled,
  onToolSearchQueryChange,
  onToggleToolGroup,
  onClearToolGroups,
  onToolRowOpenChange,
  onToolToggle,
  onEnableAll,
  onDisableAll,
}: AgentToolsCardProps) {
  const t = useTranslations('settings');

  return (
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
                onChange={(e) => onToolSearchQueryChange(e.target.value)}
              />
              {toolSearchQuery && (
                <button
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => onToolSearchQueryChange('')}
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
                  onClick={() => onToggleToolGroup(group)}
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
                  onClick={onClearToolGroups}
                >
                  {t('agentPanel.tools.allGroups')}
                </Button>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {t('agentPanel.tools.showingCount', { shown: filteredTools.length, total: availableTools.length })}
              </span>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onEnableAll} disabled={toolsSaving}>
                {t('agentPanel.tools.enableAll')}
              </Button>
              <Button size="sm" variant="outline" onClick={onDisableAll} disabled={toolsSaving}>
                {t('agentPanel.tools.disableAll')}
              </Button>
            </div>
            <div className="max-h-[400px] space-y-2 overflow-y-auto">
              {filteredTools.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">{t('agentPanel.tools.noMatchingTools')}</p>
              ) : (
                filteredTools.map((tool) => {
                  const isOpen = openToolRows[tool.name] ?? false;
                  return (
                    <Collapsible
                      key={tool.name}
                      open={isOpen}
                      onOpenChange={(open) => onToolRowOpenChange(tool.name, open)}
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
                          onCheckedChange={(checked) => onToolToggle(tool.name, checked)}
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
        {toolsError && <p className="mt-2 text-sm text-destructive">{toolsError}</p>}
      </CardContent>
    </Card>
  );
}
