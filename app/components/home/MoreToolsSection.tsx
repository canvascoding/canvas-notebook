'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ChevronDown, Terminal, Settings, MessageSquare, FolderOpen, ImageIcon, Clapperboard } from 'lucide-react';

interface MoreToolsLink {
  labelKey: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const MORE_TOOLS_LINKS: MoreToolsLink[] = [
  { labelKey: 'chat', href: '/chat', icon: MessageSquare },
  { labelKey: 'files', href: '/files', icon: FolderOpen },
  { labelKey: 'imageGeneration', href: '/image-generation', icon: ImageIcon },
  { labelKey: 'veo', href: '/veo', icon: Clapperboard },
  { labelKey: 'terminal', href: '/terminal', icon: Terminal },
  { labelKey: 'settings', href: '/settings', icon: Settings },
];

export function MoreToolsSection() {
  const t = useTranslations('home');
  const tApps = useTranslations('home.apps');
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 border-t border-border pt-4 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        {t('sections.moreTools')}
      </button>
      {isExpanded && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {MORE_TOOLS_LINKS.map((link, index) => {
            const Icon = link.icon;
            return (
              <React.Fragment key={link.labelKey}>
                <Link
                  href={link.href}
                  className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tApps(`${link.labelKey}.title`)}
                </Link>
                {index < MORE_TOOLS_LINKS.length - 1 ? (
                  <span className="text-xs text-muted-foreground/60" aria-hidden="true">
                    ·
                  </span>
                ) : null}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
