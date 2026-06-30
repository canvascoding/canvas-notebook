'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getPathname, usePathname, Link } from '@/i18n/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  NotebookPen,
  ListTodo,
  Sparkles,
  FolderOpen,
  MessageSquare,
  Workflow,
  Terminal,
  Settings,
  HelpCircle,
  LayoutGrid,
  MoreHorizontal,
  ExternalLink,
  ArrowRight,
  Inbox,
  ShieldCheck,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AppItem {
  id: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  hasQuickActions: boolean;
}

const APPS: AppItem[] = [
  { id: 'notebook', href: '/notebook', icon: NotebookPen, hasQuickActions: false },
  { id: 'todos', href: '/todos', icon: ListTodo, hasQuickActions: false },
  { id: 'emails', href: '/emails', icon: Inbox, hasQuickActions: false },
  { id: 'studio', href: '/studio', icon: Sparkles, hasQuickActions: true },
  { id: 'files', href: '/files', icon: FolderOpen, hasQuickActions: false },
  { id: 'chat', href: '/chat', icon: MessageSquare, hasQuickActions: false },
  { id: 'automations', href: '/automations', icon: Workflow, hasQuickActions: false },
  { id: 'terminal', href: '/terminal', icon: Terminal, hasQuickActions: false },
  { id: 'security', href: '/security/public-shares', icon: ShieldCheck, hasQuickActions: false },
  { id: 'settings', href: '/settings', icon: Settings, hasQuickActions: true },
  { id: 'help', href: '/help', icon: HelpCircle, hasQuickActions: false },
];

interface QuickAction {
  label: string;
  href: string;
}

function isPathActive(pathname: string | null, appHref: string): boolean {
  if (!pathname) return false;
  if (appHref === '/') return pathname === '/';
  return pathname === appHref || pathname.startsWith(appHref + '/');
}

function useIsMobileLauncher() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < 768);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return isMobile;
}

function getQuickActions(
  app: AppItem,
  tStudio: ReturnType<typeof useTranslations>,
  tSettings: ReturnType<typeof useTranslations>
): QuickAction[] {
  if (app.id === 'settings') {
    return [
      { label: tSettings('tabs.general'), href: '/settings?tab=general' },
      { label: tSettings('tabs.agentSettings'), href: '/settings?tab=agentSettings' },
      { label: tSettings('tabs.browser'), href: '/settings?tab=browser' },
      { label: tSettings('tabs.workspace'), href: '/settings?tab=workspace' },
      { label: tSettings('tabs.integrations'), href: '/settings?tab=integrations' },
      { label: tSettings('tabs.skills'), href: '/settings?tab=plugins' },
    ];
  }

  if (app.id === 'studio') {
    return [
      { label: tStudio('tabs.create'), href: '/studio' },
      { label: tStudio('tabs.models'), href: '/studio/models' },
      { label: tStudio('tabs.presets'), href: '/studio/presets' },
      { label: tStudio('tabs.bulk'), href: '/studio/bulk' },
      { label: tStudio('tabs.resize'), href: '/studio/aspect-ratio' },
    ];
  }

  return [];
}

export function AppLauncher() {
  const tApps = useTranslations('home.apps');
  const tNav = useTranslations('navigation');
  const tStudio = useTranslations('studio');
  const tSettings = useTranslations('settings');
  const pathname = usePathname();
  const locale = useLocale();
  const isMobile = useIsMobileLauncher();

  const [launcherOpen, setLauncherOpen] = useState(false);
  const [activeActionsApp, setActiveActionsApp] = useState<AppItem | null>(null);
  const [mobileActionsApp, setMobileActionsApp] = useState<AppItem | null>(null);

  const handleOpenActions = useCallback((event: React.MouseEvent, app: AppItem) => {
    if (!app.hasQuickActions) return;
    event.preventDefault();
    event.stopPropagation();

    if (isMobile) {
      setLauncherOpen(false);
      setActiveActionsApp(null);
      setMobileActionsApp(app);
      return;
    }

    setActiveActionsApp((current) => (current?.id === app.id ? null : app));
  }, [isMobile]);

  const closeLauncher = useCallback(() => {
    setLauncherOpen(false);
    setActiveActionsApp(null);
  }, []);

  const activeActions = useMemo(() => {
    if (!activeActionsApp) return [];
    return getQuickActions(activeActionsApp, tStudio, tSettings);
  }, [activeActionsApp, tSettings, tStudio]);

  const mobileActions = useMemo(() => {
    if (!mobileActionsApp) return [];
    return getQuickActions(mobileActionsApp, tStudio, tSettings);
  }, [mobileActionsApp, tSettings, tStudio]);

  const getLocalizedHref = useCallback((href: string) => getPathname({ href, locale }), [locale]);

  const renderActionRows = (app: AppItem, actions: QuickAction[], close: () => void) => {
    const label = tApps(`${app.id}.title` as Parameters<typeof tApps>[0]);
    const appHref = getLocalizedHref(app.href);

    return (
      <div className="space-y-1">
        <Button asChild variant="ghost" className="h-10 w-full justify-start px-3">
          <Link href={app.href} onClick={close}>
            <ArrowRight className="h-4 w-4" />
            {tNav('openApp', { app: label })}
          </Link>
        </Button>
        <Button asChild variant="ghost" className="h-10 w-full justify-start px-3">
          <a href={appHref} target="_blank" rel="noopener noreferrer" onClick={close}>
            <ExternalLink className="h-4 w-4" />
            {tNav('openInNewTab')}
          </a>
        </Button>
        {actions.length > 0 && (
          <div className="pt-1">
            {actions.map((action) => (
              <Button key={action.href} asChild variant="ghost" className="h-10 w-full justify-start px-3">
                <Link href={action.href} onClick={close}>
                  {action.label}
                </Link>
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <DropdownMenu
        modal={false}
        open={launcherOpen}
        onOpenChange={(open) => {
          setLauncherOpen(open);
          if (!open) setActiveActionsApp(null);
        }}
      >
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
          align="center"
          sideOffset={8}
          className="w-[258px] p-2 sm:w-[304px] sm:p-3"
        >
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-4">
            {APPS.map((app) => {
              const Icon = app.icon;
              const active = isPathActive(pathname, app.href);
              const label = tApps(`${app.id}.title` as Parameters<typeof tApps>[0]);
              return (
                <div key={app.id} className="group relative">
                  <Link
                    href={app.href}
                    className={cn(
                      'flex min-h-[74px] flex-col items-center gap-1.5 p-2.5 text-center transition-colors sm:min-h-[70px] sm:p-2',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                    onClick={closeLauncher}
                    onContextMenu={(e) => handleOpenActions(e, app)}
                  >
                    <div className={cn(
                      'flex h-10 w-10 items-center justify-center sm:h-9 sm:w-9',
                      active && 'bg-primary/15'
                    )}>
                      <Icon className="h-6 w-6 sm:h-5 sm:w-5" />
                    </div>
                    <span className="w-full truncate text-[11px] font-medium leading-tight">
                      {label}
                    </span>
                  </Link>
                  {app.hasQuickActions && (
                    <button
                      type="button"
                      className="absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:w-6 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                      aria-label={tNav('openAppActions', { app: label })}
                      onClick={(event) => handleOpenActions(event, app)}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {activeActionsApp && (
            <div className="mt-3 border-t border-border pt-2">
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                {tNav('appActions', {
                  app: tApps(`${activeActionsApp.id}.title` as Parameters<typeof tApps>[0]),
                })}
              </div>
              {renderActionRows(activeActionsApp, activeActions, closeLauncher)}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {mobileActionsApp && (
        <Sheet open={!!mobileActionsApp} onOpenChange={(open) => {
          if (!open) setMobileActionsApp(null);
        }}>
          <SheetContent side="bottom" className="rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]">
            <SheetHeader className="border-b border-border px-4 py-3 text-left">
              <SheetTitle>
                {tNav('appActions', {
                  app: tApps(`${mobileActionsApp.id}.title` as Parameters<typeof tApps>[0]),
                })}
              </SheetTitle>
            </SheetHeader>
            <div className="px-2 py-2">
              {renderActionRows(mobileActionsApp, mobileActions, () => setMobileActionsApp(null))}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
