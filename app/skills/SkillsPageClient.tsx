'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Wrench, BookOpen, Power, CheckCircle2, XCircle } from 'lucide-react';

import { LogoutButton } from '@/app/components/LogoutButton';
import { NotebookNavButton } from '@/app/components/NotebookNavButton';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { SkillDetailDialog } from '@/app/components/skills/SkillDetailDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { AnthropicSkill } from '@/app/lib/skills/skill-manifest-anthropic';

interface SkillsPageProps {
  skills: AnthropicSkill[];
  stats: {
    total: number;
    enabled: number;
    disabled: number;
  };
  username: string;
}

export default function SkillsPageClient({ skills: initialSkills, stats: initialStats, username }: SkillsPageProps) {
  const [skills, setSkills] = useState<AnthropicSkill[]>(initialSkills);
  const [stats, setStats] = useState(initialStats);
  const [selectedSkill, setSelectedSkill] = useState<AnthropicSkill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [, setEnabledSkills] = useState<Set<string>>(
    new Set(initialSkills.filter(s => s.enabled).map(s => s.name))
  );

  // Sync with server state on mount (in case config changed since page load)
  useEffect(() => {
    fetch('/api/skills/status')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          const apiEnabledSkills = data.enabledSkills || [];
          const allEnabled = data.allEnabled || apiEnabledSkills.length === 0;
          
          // Only update if server state differs from client state
          const serverEnabledSet = allEnabled 
            ? new Set<string>(skills.map(s => s.name))
            : new Set<string>(apiEnabledSkills);
          
          const clientEnabledSet = new Set<string>(skills.filter(s => s.enabled).map(s => s.name));
          
          // Check if sets are different
          const setsEqual = serverEnabledSet.size === clientEnabledSet.size && 
            [...serverEnabledSet].every((name: string) => clientEnabledSet.has(name));
          
          if (!setsEqual) {
            // Update to match server state
            setEnabledSkills(serverEnabledSet);
            setSkills(prev => prev.map(skill => ({
              ...skill,
              enabled: allEnabled || apiEnabledSkills.includes(skill.name)
            })));
            const enabledCount = allEnabled ? skills.length : apiEnabledSkills.length;
            setStats({
              total: skills.length,
              enabled: enabledCount,
              disabled: skills.length - enabledCount
            });
          }
        }
      })
      .catch(err => console.error('Failed to sync skill status:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Update local state
        setEnabledSkills(prev => {
          const newSet = new Set(prev);
          if (enabled) {
            newSet.add(skillName);
          } else {
            newSet.delete(skillName);
          }
          return newSet;
        });
        
        // Update skills array
        setSkills(prev => prev.map(skill => 
          skill.name === skillName ? { ...skill, enabled } : skill
        ));
        
        // Update stats
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
        // Enable all skills in local state
        const allSkillNames = new Set(skills.map(s => s.name));
        setEnabledSkills(allSkillNames);
        
        // Update all skills to enabled
        setSkills(prev => prev.map(skill => ({ ...skill, enabled: true })));
        
        // Update stats
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
        // Clear all enabled skills
        setEnabledSkills(new Set());
        
        // Update all skills to disabled
        setSkills(prev => prev.map(skill => ({ ...skill, enabled: false })));
        
        // Update stats
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

  return (
    <div className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Suite</span>
              </Link>
            </Button>
            <Image src="/logo.jpg" alt="Canvas Notebook logo" width={32} height={32} className="shrink-0 border border-border" />
            <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">SKILL GALLERY</h1>
          </div>
          <div className="flex items-center gap-1.5 md:gap-4">
            <NotebookNavButton />
            <ThemeToggle />
            <div className="hidden lg:flex flex-col items-end shrink-0">
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">User</span>
              <span className="text-xs text-foreground/90">{username}</span>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Skills</CardDescription>
                <CardTitle className="text-3xl">{stats.total}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Enabled</CardDescription>
                <CardTitle className="text-3xl text-green-600">{stats.enabled}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Disabled</CardDescription>
                <CardTitle className="text-3xl text-muted-foreground">{stats.disabled}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          {/* Bulk Actions */}
          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={enableAllSkills}
              disabled={stats.enabled === stats.total}
              className="flex items-center gap-2"
            >
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Enable All
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={disableAllSkills}
              disabled={stats.disabled === stats.total}
              className="flex items-center gap-2"
            >
              <XCircle className="h-4 w-4 text-muted-foreground" />
              Disable All
            </Button>
          </div>

          {/* Info Boxes: Integrations & Skill Creation */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Integrations Hint */}
            <Card className="border-dashed border-muted-foreground/30 bg-muted/30">
              <CardContent className="py-4 px-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium">Hinweis:</span> Wenn Skills Env-Variablen benötigen, müssen diese im Integrations-Tab gespeichert werden.
                  </p>
                  <Button asChild variant="outline" size="sm">
                    <Link href="/settings?tab=integrations">Integrations öffnen</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Skill Creation Info */}
            <Card className="border-dashed border-blue-500/30 bg-blue-50/30 dark:bg-blue-950/20">
              <CardContent className="py-4 px-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <p className="text-sm text-foreground">
                      <span className="font-medium">Neuen Skill erstellen:</span> Sag dem Agenten, dass du einen neuen Skill erstellen möchtest. Du kannst dann gemeinsam ausarbeiten, was der Skill genau machen soll. Verwende dafür den <span className="font-semibold text-blue-600 dark:text-blue-400">Creator Skill</span>.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Skills Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {skills.map((skill) => (
              <Card key={skill.name} className={`flex flex-col ${!skill.enabled ? 'opacity-60' : ''}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Power className={`h-5 w-5 ${skill.enabled ? 'text-green-500' : 'text-muted-foreground'}`} />
                      <CardTitle className="text-lg">{skill.title}</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) => toggleSkill(skill.name, checked)}
                        aria-label={`Toggle ${skill.name}`}
                      />
                    </div>
                  </div>
                  <CardDescription className="line-clamp-2">
                    {skill.description}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-end space-y-3">
                  {skill.license && (
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium">License:</span> {skill.license}
                    </div>
                  )}
                  <div className="flex gap-2 pt-2">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="flex-1"
                      onClick={() => handleOpenSkill(skill)}
                    >
                      <BookOpen className="h-4 w-4 mr-1" />
                      Docs
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {skills.length === 0 && (
            <div className="text-center py-12">
              <Wrench className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Skills Found</h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                Skills will appear here once they are added to the /data/skills/ directory.
              </p>
            </div>
          )}
        </div>
      </main>

      <SkillDetailDialog 
        skill={selectedSkill} 
        open={dialogOpen} 
        onOpenChange={setDialogOpen} 
      />
    </div>
  );
}
