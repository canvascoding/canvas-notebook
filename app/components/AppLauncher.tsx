'use client';

import { useCallback, useState } from 'react';
import { usePathname, Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import {
  NotebookPen,
  Sparkles,
  FolderOpen,
  MessageSquare,
  Workflow,
  Terminal,
  Settings,
  HelpCircle,
  LayoutGrid,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { AppContextMenu } from '@/app/components/AppContextMenu';

interface AppItem {
  id: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  hasQuickActions: boolean;
}

const APPS: AppItem[] = [
  { id: 'notebook', href: '/notebook', icon: NotebookPen, hasQuickActions: false },
  { id: 'studio', href: '/studio', icon: Sparkles, hasQuickActions: true },
  { id: 'files', href: '/files', icon: FolderOpen, hasQuickActions: false },
  { id: 'chat', href: '/chat', icon: MessageSquare, hasQuickActions: false },
  { id: 'automations', href: '/automationen', icon: Workflow, hasQuickActions: false },
  { id: 'terminal', href: '/terminal', icon: Terminal, hasQuickActions: false },
  { id: 'settings', href: '/settings', icon: Settings, hasQuickActions: true },
  { id: 'help', href: '/help', icon: HelpCircle, hasQuickActions: false },
];

function isPathActive(pathname: string | null, appHref: string): boolean {
  if (!pathname) return false;
  if (appHref === '/') return pathname === '/';
  return pathname === appHref || pathname.startsWith(appHref + '/');
}

export function AppLauncher() {
  const tApps = useTranslations('home.apps');
  const tNav = useTranslations('navigation');
  const pathname = usePathname();

  const [contextTarget, setContextTarget] = useState<{
    app: AppItem;
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback((event: React.MouseEvent, app: AppItem) => {
    if (!app.hasQuickActions) return;
    event.preventDefault();
    event.stopPropagation();
    setContextTarget({ app, position: { x: event.clientX, y: event.clientY } });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextTarget(null);
  }, []);

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={tNav('openAppLauncher')}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          className="w-[280px] p-3"
        >
          <div className="grid grid-cols-4 gap-1">
            {APPS.map((app) => {
              const Icon = app.icon;
              const active = isPathActive(pathname, app.href);
              const label = tApps(`${app.id}.title` as Parameters<typeof tApps>[0]);
              return (
                <Link
                  key={app.id}
                  href={app.href}
                  className={cn(
                    'flex flex-col items-center gap-1.5 p-2.5 text-center transition-colors',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                  onContextMenu={(e) => handleContextMenu(e, app)}
                >
                  <div className={cn(
                    'flex h-9 w-9 items-center justify-center',
                    active && 'bg-primary/15'
                  )}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <span className="text-[11px] leading-tight font-medium truncate w-full">
                    {label}
                  </span>
                </Link>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {contextTarget && (
        <AppContextMenu
          app={contextTarget.app}
          position={contextTarget.position}
          isOpen={!!contextTarget}
          onClose={closeContextMenu}
        />
      )}
    </>
  );
}