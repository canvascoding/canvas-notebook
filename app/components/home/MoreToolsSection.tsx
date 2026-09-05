'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ChevronDown, Terminal, Settings, MessageSquare, FolderOpen, MonitorUp } from 'lucide-react';
import { NOTEBOOK_CHAT_HREF } from '@/app/lib/chat/chat-navigation-intent';

interface MoreToolsLink {
  labelKey: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const MORE_TOOLS_LINKS: MoreToolsLink[] = [
  { labelKey: 'browserLab', href: '/browser/lab', icon: MonitorUp },
  { labelKey: 'chat', href: NOTEBOOK_CHAT_HREF, icon: MessageSquare },
  { labelKey: 'files', href: '/files', icon: FolderOpen },
  { labelKey: 'terminal', href: '/terminal', icon: Terminal },
  { labelKey: 'settings', href: '/settings', icon: Settings },
];

export function MoreToolsSection({ showBrowserLab = false }: { showBrowserLab?: boolean }) {
  const t = useTranslations('home');
  const tApps = useTranslations('home.apps');
  const [isExpanded, setIsExpanded] = useState(false);
  const links = showBrowserLab ? MORE_TOOLS_LINKS : MORE_TOOLS_LINKS.slice(1);

  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls="home-more-tools"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 border-t border-border pt-4 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        {t('sections.moreTools')}
      </button>
      {isExpanded && (
        <div id="home-more-tools" className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          {links.map((link) => {
            const Icon = link.icon;
            return (
              <React.Fragment key={link.labelKey}>
                <Link
                  href={link.href}
                  className="inline-flex h-10 min-w-0 items-center gap-2 rounded-full border border-border/70 bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground"
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="truncate">{tApps(`${link.labelKey}.title`)}</span>
                </Link>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
