'use client';

import { useState } from 'react';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Wrench, Terminal, Globe, BookOpen } from 'lucide-react';

import { LogoutButton } from '@/app/components/LogoutButton';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { SkillDetailDialog } from '@/app/components/skills/SkillDetailDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { SkillManifest } from '@/app/lib/skills/skill-manifest';

interface SkillsPageProps {
  skills: SkillManifest[];
  stats: {
    total: number;
    cli: number;
    api: number;
    custom: number;
  };
  username: string;
}

export default function SkillsPageClient({ skills, stats, username }: SkillsPageProps) {
  const [selectedSkill, setSelectedSkill] = useState<SkillManifest | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function handleOpenSkill(skill: SkillManifest) {
    setSelectedSkill(skill);
    setDialogOpen(true);
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Skills</CardDescription>
                <CardTitle className="text-3xl">{stats.total}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>CLI Skills</CardDescription>
                <CardTitle className="text-3xl">{stats.cli}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>API Skills</CardDescription>
                <CardTitle className="text-3xl">{stats.api}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Custom Skills</CardDescription>
                <CardTitle className="text-3xl">{stats.custom}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          {/* Skills Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {skills.map((skill) => (
              <Card key={skill.name} className="flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      {skill.type === 'cli' ? (
                        <Terminal className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <Globe className="h-5 w-5 text-muted-foreground" />
                      )}
                      <CardTitle className="text-lg">{skill.title}</CardTitle>
                    </div>
                    <div className="flex gap-1">
                      <span className="inline-flex items-center rounded-full border border-transparent bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
                        {skill.type}
                      </span>
                      {!skill.author || skill.author === 'system' ? (
                        <span className="inline-flex items-center rounded-full border border-transparent bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
                          Built-in
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold text-foreground">
                          Custom
                        </span>
                      )}
                    </div>
                  </div>
                  <CardDescription className="line-clamp-2">
                    {skill.description.split('\n')[0]}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-end space-y-3">
                  <div className="text-sm text-muted-foreground">
                    <span className="font-medium">Tool:</span> {skill.tool.name}
                  </div>
                  {Object.keys(skill.tool.parameters).length > 0 && (
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium">Parameters:</span>{' '}
                      {Object.keys(skill.tool.parameters).join(', ')}
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
                Skills will appear here once they are created. Use the create_skill tool in the chat to create new skills.
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
