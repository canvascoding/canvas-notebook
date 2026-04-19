'use client';

import React from 'react';
import { Link } from '@/i18n/navigation';
import { Card } from '@/components/ui/card';

interface ToolCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  href: string;
}

export function ToolCard({ icon: Icon, title, description, href }: ToolCardProps) {
  return (
    <Link href={href} className="block">
      <Card className="group flex h-full flex-col border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-foreground">{title}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
      </Card>
    </Link>
  );
}