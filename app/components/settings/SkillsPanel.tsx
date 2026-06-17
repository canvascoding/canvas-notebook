'use client';

import { useState, useEffect, useCallback, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  Upload,
  Package,
  RefreshCw,
  Trash2,
  FolderOpen,
  Folder,
  FileText,
  FileCode,
  File,
  ChevronRight,
  Info,
  Plug,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SkillDetailDialog } from '@/app/components/skills/SkillDetailDialog';
import { SkillUploadDialog } from '@/app/components/skills/SkillUploadDialog';
import { CanvasPluginIcon } from '@/app/lib/plugins/plugin-icons';
import { CanvasSkillIcon } from '@/app/lib/skills/skill-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';

interface SkillFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: SkillFileNode[];
}

type RightPanelView = 'info' | 'preview';
type SkillsPanelTab = 'plugins' | 'skills';

type CanvasPluginSettingsRecord = {
  name: string;
  version: string;
  description: string;
  license?: string;
  enabled: boolean;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    category?: string;
    brandColor?: string;
    icon?: string;
    logo?: string;
  };
  connectors?: {
    mcpServers?: string;
    composioToolkits?: string[];
  };
  skills: Array<{
    name: string;
    title: string;
    description: string;
  }>;
};

function CanvasPluginsSection({ onPluginsChanged }: { onPluginsChanged: () => void }) {
  const t = useTranslations('skills.plugins');
  const [plugins, setPlugins] = useState<CanvasPluginSettingsRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sourcePath, setSourcePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [pendingPluginName, setPendingPluginName] = useState<string | null>(null);

  const loadPlugins = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/plugins', { credentials: 'include', cache: 'no-store' });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('errors.load'));
      }
      setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    startTransition(() => {
      void loadPlugins();
    });
  }, [loadPlugins]);

  async function installPlugin() {
    const trimmedPath = sourcePath.trim();
    if (!trimmedPath) {
      setError(t('errors.sourcePathRequired'));
      return;
    }

    setIsInstalling(true);
    setError(null);
    try {
      const response = await fetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: trimmedPath, enable: true, replace: true }),
      });
      const data = await response.json();
      if (!data.success) {
        const details = data.validation?.errors?.length ? ` ${data.validation.errors.join(' ')}` : '';
        throw new Error(`${data.error || t('errors.install')}${details}`);
      }
      setSourcePath('');
      await loadPlugins();
      onPluginsChanged();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : t('errors.install'));
    } finally {
      setIsInstalling(false);
    }
  }

  async function setPluginEnabled(pluginName: string, enabled: boolean) {
    setPendingPluginName(pluginName);
    setError(null);
    try {
      const response = await fetch(`/api/plugins/${pluginName}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('errors.toggle'));
      }
      await loadPlugins();
      onPluginsChanged();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : t('errors.toggle'));
    } finally {
      setPendingPluginName(null);
    }
  }

  async function deletePlugin(pluginName: string) {
    if (!window.confirm(t('deleteConfirm', { name: pluginName }))) {
      return;
    }

    setPendingPluginName(pluginName);
    setError(null);
    try {
      const response = await fetch(`/api/plugins/${pluginName}`, { method: 'DELETE' });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || t('errors.delete'));
      }
      await loadPlugins();
      onPluginsChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('errors.delete'));
    } finally {
      setPendingPluginName(null);
    }
  }

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Package className="h-4 w-4" />
            {t('title')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="shrink-0">
            {t('stats', { enabled: enabledCount, total: plugins.length })}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => void loadPlugins()} disabled={isLoading} className="gap-1.5">
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t('reload')}
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          value={sourcePath}
          onChange={(event) => setSourcePath(event.target.value)}
          placeholder={t('sourcePathPlaceholder')}
          disabled={isInstalling}
        />
        <Button onClick={() => void installPlugin()} disabled={isInstalling || !sourcePath.trim()} className="gap-1.5">
          {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {t('install')}
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : plugins.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
          {t('empty')}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {plugins.map((plugin) => {
            const displayName = plugin.interface?.displayName || plugin.name;
            const description = plugin.interface?.shortDescription || plugin.description;
            const connectorLabels = [
              plugin.connectors?.mcpServers ? 'MCP' : null,
              plugin.connectors?.composioToolkits?.length ? `Composio: ${plugin.connectors.composioToolkits.join(', ')}` : null,
            ].filter(Boolean);
            const isPending = pendingPluginName === plugin.name;

            return (
              <div key={plugin.name} className="rounded-lg border bg-background p-4">
                <div className="flex items-start gap-3">
                  <CanvasPluginIcon plugin={plugin} className="h-10 w-10 text-sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold">{displayName}</h3>
                      <Badge variant={plugin.enabled ? 'default' : 'secondary'} className="text-[10px]">
                        {plugin.enabled ? t('enabled') : t('disabled')}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">v{plugin.version}</Badge>
                      {plugin.license ? <Badge variant="outline" className="text-[10px]">{plugin.license}</Badge> : null}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">/{plugin.name}</div>
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{description}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {plugin.skills.map((skill) => (
                        <Badge key={skill.name} variant="secondary" className="max-w-full text-[10px]">
                          <span className="truncate">/{skill.name}</span>
                        </Badge>
                      ))}
                    </div>
                    {connectorLabels.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                        {connectorLabels.map((label) => (
                          <span key={label} className="rounded-full border px-2 py-0.5">{label}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Switch
                      checked={plugin.enabled}
                      disabled={isPending}
                      onCheckedChange={(checked) => void setPluginEnabled(plugin.name, checked)}
                      aria-label={t('toggle', { name: plugin.name })}
                    />
                    {plugin.enabled ? t('enabled') : t('disabled')}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isPending}
                    onClick={() => void deletePlugin(plugin.name)}
                    className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    {t('delete')}
                  </Button>
                </div>
                {(plugin.connectors?.mcpServers || plugin.connectors?.composioToolkits?.length) ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {plugin.connectors?.mcpServers ? (
                      <Button asChild variant="outline" size="sm" className="gap-1.5">
                        <Link href="/settings?tab=integrations&section=mcp">
                          <Plug className="h-3.5 w-3.5" />
                          {t('openMcp')}
                        </Link>
                      </Button>
                    ) : null}
                    {plugin.connectors?.composioToolkits?.length ? (
                      <Button asChild variant="outline" size="sm" className="gap-1.5">
                        <Link href="/settings?tab=integrations&section=composio">
                          <Plug className="h-3.5 w-3.5" />
                          {t('openComposio')}
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function SkillsPanel() {
  const t = useTranslations('skills');
  const [skills, setSkills] = useState<CanvasSkill[]>([]);
  const [stats, setStats] = useState({ total: 0, enabled: 0, disabled: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<CanvasSkill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<SkillsPanelTab>('plugins');
  const [skillTree, setSkillTree] = useState<SkillFileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [rightView, setRightView] = useState<RightPanelView>('info');
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function loadSkills() {
    try {
      setIsLoading(true);
      const [skillsRes, statusRes] = await Promise.all([
        fetch('/api/skills'),
        fetch('/api/skills/status'),
      ]);
      const skillsData = await skillsRes.json();
      const statusData = await statusRes.json();

      if (skillsData.success) {
        const allSkills: CanvasSkill[] = skillsData.skills;
        const enabledNames: string[] = statusData.success ? (statusData.enabledSkills || []) : [];
        const allEnabled = statusData.success && statusData.allEnabled === true;

        const merged = allSkills.map((skill: CanvasSkill) => ({
          ...skill,
          enabled: allEnabled || enabledNames.includes(skill.name),
        }));

        const enabledCount = merged.filter((s: CanvasSkill) => s.enabled).length;
        setSkills(merged);
        setStats({
          total: merged.length,
          enabled: enabledCount,
          disabled: merged.length - enabledCount,
        });
      }
    } catch (error) {
      console.error('Failed to load skills:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadSkillTree() {
    try {
      const res = await fetch('/api/skills/tree?depth=4');
      const data = await res.json();
      if (data.success) {
        setSkillTree(data.data || []);
      }
    } catch (error) {
      console.error('Failed to load skill tree:', error);
    }
  }

  useEffect(() => {
    startTransition(() => {
      loadSkills();
      loadSkillTree();
    });
  }, []);

  const toggleDirectory = useCallback((dirPath: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const handleSkillClick = useCallback((skillName: string) => {
    const skill = skills.find(s => s.name === skillName);
    if (skill) {
      setSelectedSkill(skill);
      setRightView('info');
      setSelectedPath(skillName);
    }
  }, [skills]);

  const handleFileClick = useCallback(async (filePath: string) => {
    setSelectedPath(filePath);
    setRightView('preview');
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/skills/file?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.success) {
        setPreviewContent(data.content || '');
      } else {
        setPreviewError(data.error || 'Failed to load file');
      }
    } catch {
      setPreviewError('Failed to load file');
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  async function toggleSkill(skillName: string, enabled: boolean) {
    try {
      const endpoint = enabled ? `/api/skills/${skillName}/enable` : `/api/skills/${skillName}/disable`;
      const response = await fetch(endpoint, { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        setSkills(prev => prev.map(skill =>
          skill.name === skillName ? { ...skill, enabled } : skill
        ));
        setStats(prev => ({
          ...prev,
          enabled: enabled ? prev.enabled + 1 : prev.enabled - 1,
          disabled: enabled ? prev.disabled - 1 : prev.disabled + 1
        }));
      }
    } catch (error) {
      console.error('Failed to toggle skill:', error);
    }
  }

  async function enableAllSkills() {
    try {
      const response = await fetch('/api/skills/enable-all', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setSkills(prev => prev.map(skill => ({ ...skill, enabled: true })));
        setStats(prev => ({ ...prev, enabled: prev.total, disabled: 0 }));
      }
    } catch (error) {
      console.error('Failed to enable all skills:', error);
    }
  }

  async function disableAllSkills() {
    try {
      const response = await fetch('/api/skills/disable-all', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setSkills(prev => prev.map(skill => ({ ...skill, enabled: false })));
        setStats(prev => ({ ...prev, enabled: 0, disabled: prev.total }));
      }
    } catch (error) {
      console.error('Failed to disable all skills:', error);
    }
  }

  function getFileIcon(node: SkillFileNode, skill?: CanvasSkill | null) {
    if (skill) {
      return <CanvasSkillIcon skill={skill} className="h-5 w-5 text-[10px]" />;
    }

    if (node.type === 'directory') {
      return expandedDirs.has(node.path) ? (
        <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
      ) : (
        <Folder className="h-4 w-4 text-amber-500 shrink-0" />
      );
    }
    const ext = node.name.split('.').pop()?.toLowerCase();
    if (ext === 'md') return <FileText className="h-4 w-4 text-blue-500 shrink-0" />;
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'yaml', 'yml', 'html', 'css'].includes(ext || '')) {
      return <FileCode className="h-4 w-4 text-green-500 shrink-0" />;
    }
    return <File className="h-4 w-4 text-muted-foreground shrink-0" />;
  }

  function renderTree(nodes: SkillFileNode[], depth: number = 0): React.ReactNode {
    return nodes.map(node => {
      const isSkillDir = node.type === 'directory' && depth === 0;
      const skill = isSkillDir ? skills.find(s => s.name === node.name) : null;
      const isExpanded = expandedDirs.has(node.path);
      const isSelected = selectedPath === node.path;

      return (
        <div key={node.path}>
          <div
            role="button"
            tabIndex={0}
            className={cn(
              'w-full flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-left cursor-pointer',
              isSelected
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-muted text-foreground',
              depth > 0 && 'text-muted-foreground'
            )}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => {
              if (node.type === 'directory') {
                if (isSkillDir && skill) {
                  handleSkillClick(skill.name);
                }
                toggleDirectory(node.path);
              } else {
                handleFileClick(node.path);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (node.type === 'directory') {
                  if (isSkillDir && skill) handleSkillClick(skill.name);
                  toggleDirectory(node.path);
                } else {
                  handleFileClick(node.path);
                }
              }
            }}
          >
            {node.type === 'directory' && (
              <ChevronRight className={cn(
                'h-3 w-3 shrink-0 transition-transform',
                isExpanded && 'rotate-90'
              )} />
            )}
            {node.type === 'file' && <span className="w-3 shrink-0" />}
            {getFileIcon(node, skill)}
            <span className="truncate flex-1">{node.name}</span>
            {isSkillDir && skill && (
              <Switch
                checked={skill.enabled}
                onCheckedChange={(checked) => {
                  toggleSkill(skill.name, checked);
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className="scale-75 shrink-0"
                aria-label={t('toggleSkill', { name: skill.name })}
              />
            )}
          </div>
          {node.type === 'directory' && isExpanded && node.children && (
            <div>{renderTree(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const selectedSkillData = selectedPath
    ? skills.find(s => s.name === selectedPath)
    : null;

  return (
    <>
      <Tabs
        value={panelTab}
        onValueChange={(value) => {
          if (value === 'plugins' || value === 'skills') {
            setPanelTab(value);
          }
        }}
        className="space-y-4"
      >
        <TabsList className="bg-transparent p-0">
          <TabsTrigger value="plugins" className="rounded-full px-4 data-[state=active]:bg-muted">
            {t('tabs.plugins')}
          </TabsTrigger>
          <TabsTrigger value="skills" className="rounded-full px-4 data-[state=active]:bg-muted">
            {t('tabs.skills')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="plugins" className="space-y-4">
          <CanvasPluginsSection
            onPluginsChanged={() => {
              void loadSkills();
              void loadSkillTree();
            }}
          />
        </TabsContent>

        <TabsContent value="skills" className="space-y-4">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span>{stats.total} {t('stats.total').toLowerCase()}</span>
                <span className="text-green-600">{stats.enabled} {t('stats.enabled').toLowerCase()}</span>
                <span>{stats.disabled} {t('stats.disabled').toLowerCase()}</span>
              </div>
              <div className="flex-1" />
              <Button variant="outline" size="sm" onClick={enableAllSkills} disabled={stats.enabled === stats.total} className="gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                {t('actions.enableAll')}
              </Button>
              <Button variant="outline" size="sm" onClick={disableAllSkills} disabled={stats.disabled === stats.total} className="gap-1.5">
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                {t('actions.disableAll')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)} className="gap-1.5">
                <Upload className="h-3.5 w-3.5" />
                {t('upload.button')}
              </Button>
            </div>

            <div
              className="grid h-[calc(100dvh-16rem)] min-h-[420px] grid-cols-1 grid-rows-[minmax(12rem,35%)_minmax(0,1fr)] overflow-hidden rounded-lg border lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] lg:grid-rows-1"
              data-testid="skills-browser"
            >
              {/* Left: File Tree */}
              <div className="flex min-h-0 flex-col border-b bg-muted/30 lg:border-b-0 lg:border-r">
                <div className="shrink-0 border-b bg-muted/50 p-2">
                  <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {t('stats.total')}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1 text-sm" data-testid="skills-tree-scroll">
                  {skillTree.length === 0 ? (
                    <div className="px-3 py-8 text-center text-muted-foreground text-sm">
                      <Wrench className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      {t('emptyState.title')}
                    </div>
                  ) : (
                    renderTree(skillTree)
                  )}
                </div>
              </div>

              {/* Right: Info Panel or Preview */}
              <div className="min-h-0 overflow-y-auto" data-testid="skills-detail-scroll">
                {rightView === 'info' && selectedSkillData ? (
                  <div className="p-5 space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <CanvasSkillIcon skill={selectedSkillData} className="h-12 w-12 text-sm" />
                        <div className="min-w-0">
                          <h2 className="text-xl font-bold">{selectedSkillData.title}</h2>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-sm font-mono text-muted-foreground">{selectedSkillData.name}</span>
                            <Badge variant={selectedSkillData.enabled ? 'default' : 'secondary'} className="text-xs">
                              {selectedSkillData.enabled ? t('detail.enabled') : t('detail.disabled')}
                            </Badge>
                          </div>
                        </div>
                      </div>
                      <Switch
                        checked={selectedSkillData.enabled}
                        onCheckedChange={(checked) => toggleSkill(selectedSkillData.name, checked)}
                        aria-label={t('toggleSkill', { name: selectedSkillData.name })}
                      />
                    </div>

                    <div className="bg-muted/30 rounded-lg p-4">
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                        {selectedSkillData.description}
                      </p>
                    </div>

                    {(selectedSkillData.compatibility || selectedSkillData.license) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        {selectedSkillData.compatibility && (
                          <div>
                            <span className="font-medium text-foreground">{t('detail.compatibility')}</span>
                            <p className="text-muted-foreground mt-0.5">{selectedSkillData.compatibility}</p>
                          </div>
                        )}
                        {selectedSkillData.license && (
                          <div>
                            <span className="font-medium text-foreground">{t('detail.license')}</span>
                            <p className="text-muted-foreground mt-0.5">{selectedSkillData.license}</p>
                          </div>
                        )}
                      </div>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSelectedSkill(selectedSkillData);
                        setDialogOpen(true);
                      }}
                      className="gap-1.5"
                    >
                      <Info className="h-4 w-4" />
                      {t('detail.viewDocumentation')}
                    </Button>
                  </div>
                ) : rightView === 'preview' && selectedPath ? (
                  <div className="p-4">
                    <div className="flex items-center gap-2 mb-3 text-sm font-mono text-muted-foreground">
                      <FileText className="h-4 w-4" />
                      {selectedPath.split('/').pop()}
                    </div>
                    {previewLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : previewError ? (
                      <div className="text-sm text-destructive bg-destructive/10 p-4 rounded-lg">
                        {previewError}
                      </div>
                    ) : (
                      <pre className="overflow-x-auto rounded-lg bg-muted/30 p-4 font-mono text-sm whitespace-pre-wrap break-words">
                        {previewContent}
                      </pre>
                    )}
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center py-16 text-muted-foreground">
                    <FolderOpen className="h-10 w-10 mb-3 opacity-50" />
                    <p className="text-sm">{t('detail.selectPrompt')}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Card className="border-dashed border-muted-foreground/30 bg-muted/30">
                <CardContent className="px-4 py-4 sm:px-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium">{t('integrationsHint.label')}</span> {t('integrationsHint.body')}
                    </p>
                    <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                      <Link href="/settings?tab=integrations">{t('integrationsHint.openSettings')}</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-dashed border-blue-500/30 bg-blue-50/30 dark:bg-blue-950/20">
                <CardContent className="px-4 py-4 sm:px-6">
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <p className="text-sm text-foreground">
                        <span className="font-medium">{t('creationHint.label')}</span> {t('creationHint.bodyBefore')}{' '}
                        <span className="font-semibold text-blue-600 dark:text-blue-400">{t('creationHint.creatorSkill')}</span>
                        {t('creationHint.bodyAfter')}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <SkillDetailDialog
        skill={selectedSkill}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onDeleted={() => {
          setSelectedSkill(null);
          setSelectedPath(null);
          loadSkills();
          loadSkillTree();
        }}
      />

      <SkillUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={() => { loadSkills(); loadSkillTree(); }}
      />
    </>
  );
}
