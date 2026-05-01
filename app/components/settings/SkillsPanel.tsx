'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  Wrench,
  Power,
  CheckCircle2,
  XCircle,
  Loader2,
  Upload,
  FolderOpen,
  Folder,
  FileText,
  FileCode,
  File,
  ChevronRight,
  Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SkillDetailDialog } from '@/app/components/skills/SkillDetailDialog';
import { SkillUploadDialog } from '@/app/components/skills/SkillUploadDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';

interface SkillFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: SkillFileNode[];
}

type RightPanelView = 'info' | 'preview';

export function SkillsPanel() {
  const t = useTranslations('skills');
  const [skills, setSkills] = useState<AnthropicSkill[]>([]);
  const [stats, setStats] = useState({ total: 0, enabled: 0, disabled: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<AnthropicSkill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
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
        const allSkills: AnthropicSkill[] = skillsData.skills;
        const enabledNames: string[] = statusData.success ? (statusData.enabledSkills || []) : [];
        const allEnabled = statusData.success && statusData.allEnabled === true;

        const merged = allSkills.map((skill: AnthropicSkill) => ({
          ...skill,
          enabled: allEnabled || enabledNames.includes(skill.name),
        }));

        const enabledCount = merged.filter((s: AnthropicSkill) => s.enabled).length;
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
    loadSkills();
    loadSkillTree();
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

  function getFileIcon(node: SkillFileNode) {
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
            {getFileIcon(node)}
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

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 min-h-[500px] border rounded-lg overflow-hidden">
          {/* Left: File Tree */}
          <div className="border-b lg:border-b-0 lg:border-r bg-muted/30 overflow-y-auto max-h-[600px] lg:max-h-none">
            <div className="p-2 border-b bg-muted/50">
              <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('stats.total')}
              </div>
            </div>
            <div className="p-1 text-sm">
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
          <div className="overflow-y-auto max-h-[600px] lg:max-h-none">
            {rightView === 'info' && selectedSkillData ? (
              <div className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-xl font-bold">{selectedSkillData.title}</h2>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-sm font-mono text-muted-foreground">{selectedSkillData.name}</span>
                      <Badge variant={selectedSkillData.enabled ? 'default' : 'secondary'} className="text-xs">
                        {selectedSkillData.enabled ? t('detail.enabled') : t('detail.disabled')}
                      </Badge>
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
                  View documentation
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
                  <pre className="text-sm font-mono whitespace-pre-wrap break-words bg-muted/30 p-4 rounded-lg overflow-x-auto max-h-[500px] overflow-y-auto">
                    {previewContent}
                  </pre>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <FolderOpen className="h-10 w-10 mb-3 opacity-50" />
                <p className="text-sm">Select a skill or file to view details</p>
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

      <SkillDetailDialog
        skill={selectedSkill}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

      <SkillUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={() => { loadSkills(); loadSkillTree(); }}
      />
    </>
  );
}