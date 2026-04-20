'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Wrench, BookOpen, Power, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

import { SkillDetailDialog } from '@/app/components/skills/SkillDetailDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';

export function SkillsPanel() {
  const t = useTranslations('skills');
  const [skills, setSkills] = useState<AnthropicSkill[]>([]);
  const [stats, setStats] = useState({ total: 0, enabled: 0, disabled: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<AnthropicSkill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    async function loadSkills() {
      try {
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

    loadSkills();
  }, []);

  function handleOpenSkill(skill: AnthropicSkill) {
    setSelectedSkill(skill);
    setDialogOpen(true);
  }

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
        setStats(prev => ({
          ...prev,
          enabled: prev.total,
          disabled: 0
        }));
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
        setStats(prev => ({
          ...prev,
          enabled: 0,
          disabled: prev.total
        }));
      }
    } catch (error) {
      console.error('Failed to disable all skills:', error);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-5 sm:space-y-6">
        <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-3">
          <Card>
            <CardHeader className="px-4 pb-2 sm:px-6">
              <CardDescription>{t('stats.total')}</CardDescription>
              <CardTitle className="text-3xl">{stats.total}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="px-4 pb-2 sm:px-6">
              <CardDescription>{t('stats.enabled')}</CardDescription>
              <CardTitle className="text-3xl text-green-600">{stats.enabled}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="px-4 pb-2 sm:px-6">
              <CardDescription>{t('stats.disabled')}</CardDescription>
              <CardTitle className="text-3xl text-muted-foreground">{stats.disabled}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            variant="outline"
            size="sm"
            onClick={enableAllSkills}
            disabled={stats.enabled === stats.total}
            className="w-full gap-2 sm:w-auto"
          >
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            {t('actions.enableAll')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={disableAllSkills}
            disabled={stats.disabled === stats.total}
            className="w-full gap-2 sm:w-auto"
          >
            <XCircle className="h-4 w-4 text-muted-foreground" />
            {t('actions.disableAll')}
          </Button>
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

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => (
            <Card key={skill.name} className={`flex flex-col ${!skill.enabled ? 'opacity-60' : ''}`}>
              <CardHeader className="px-4 pb-3 sm:px-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <Power className={`h-5 w-5 ${skill.enabled ? 'text-green-500' : 'text-muted-foreground'}`} />
                    <CardTitle className="text-lg leading-tight">{skill.title}</CardTitle>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={skill.enabled}
                      onCheckedChange={(checked) => toggleSkill(skill.name, checked)}
                      aria-label={t('toggleSkill', { name: skill.name })}
                    />
                  </div>
                </div>
                <CardDescription className="line-clamp-2">
                  {skill.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-end space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
                {skill.license && (
                  <div className="text-sm text-muted-foreground">
                    <span className="font-medium">{t('licenseLabel')}</span> {skill.license}
                  </div>
                )}
                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => handleOpenSkill(skill)}
                  >
                    <BookOpen className="h-4 w-4 mr-1" />
                    {t('docsButton')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {skills.length === 0 && (
          <div className="py-12 text-center">
            <Wrench className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-semibold">{t('emptyState.title')}</h3>
            <p className="mx-auto max-w-md text-sm text-muted-foreground sm:text-base">
              {t('emptyState.description')}
            </p>
          </div>
        )}
      </div>

      <SkillDetailDialog
        skill={selectedSkill}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}