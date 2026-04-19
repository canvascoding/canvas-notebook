'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ChevronDown, MessageSquare, Terminal, Wrench } from 'lucide-react';
import { Settings } from 'lucide-react';

interface MoreToolsLink {
  labelKey: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const MORE_TOOLS_LINKS: MoreToolsLink[] = [
  { labelKey: 'chat', href: '/chat', icon: MessageSquare },
  { labelKey: 'terminal', href: '/terminal', icon: Terminal },
  { labelKey: 'skills', href: '/skills', icon: Wrench },
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
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {MORE_TOOLS_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.labelKey}
                href={link.href}
                className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icon className="h-3.5 w-3.5" />
                {tApps(link.labelKey)}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}