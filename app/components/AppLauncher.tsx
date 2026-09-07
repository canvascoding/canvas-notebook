'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  ArrowLeft,
  Inbox,
  ShieldCheck,
  Network,
  MonitorUp,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { NOTEBOOK_CHAT_HREF } from '@/app/lib/chat/chat-navigation-intent';
import { cn } from '@/lib/utils';

interface AppItem {
  id: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  hasQuickActions: boolean;
}

const APPS: AppItem[] = [
  { id: 'notebook', href: '/notebook', icon: NotebookPen, hasQuickActions: false },
  { id: 'files', href: '/files', icon: FolderOpen, hasQuickActions: false },
  { id: 'todos', href: '/todos', icon: ListTodo, hasQuickActions: false },
  { id: 'emails', href: '/emails', icon: Inbox, hasQuickActions: false },
  { id: 'studio', href: '/studio', icon: Sparkles, hasQuickActions: true },
];

const MORE_APPS: AppItem[] = [
  { id: 'automations', href: '/automations', icon: Workflow, hasQuickActions: false },
  {
    id: 'chat',
    href: NOTEBOOK_CHAT_HREF,
    icon: MessageSquare,
    hasQuickActions: false,
  },
  { id: 'knowledgeGraph', href: '/knowledge-graph', icon: Network, hasQuickActions: false },
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

export function AppLauncher({ showBrowserLab = false }: { showBrowserLab?: boolean }) {
  const [showMoreApps, setShowMoreApps] = useState(false);
  const moreApps: AppItem[] = showBrowserLab
    ? [...MORE_APPS, { id: 'browserLab', href: '/browser/lab', icon: MonitorUp, hasQuickActions: false }]
    : MORE_APPS;
  const apps = showMoreApps ? moreApps : APPS;
  const tApps = useTranslations('home.apps');
  const tNav = useTranslations('navigation');
  const tStudio = useTranslations('studio');
  const tSettings = useTranslations('settings');
  const pathname = usePathname();
  const locale = useLocale();
  const isMobile = useIsMobileLauncher();

  const triggerRef = useRef<HTMLButtonElement>(null);
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
  }, [isMobile, setMobileActionsApp, setActiveActionsApp]);

  const closeLauncher = useCallback(() => {
    setLauncherOpen(false);
    setActiveActionsApp(null);
  }, [setActiveActionsApp]);

  const activeActions = useMemo(() => {
    if (!activeActionsApp) return [];
    return getQuickActions(activeActionsApp, tStudio, tSettings);
  }, [activeActionsApp, tSettings, tStudio]);

  const mobileActions = useMemo(() => {
    if (!mobileActionsApp) return [];
    return getQuickActions(mobileActionsApp, tStudio, tSettings);
  }, [mobileActionsApp, tSettings, tStudio]);

  const getLocalizedHref = useCallback((href: string) => getPathname({ href, locale }), [locale]);

  const renderActionRows = (app: AppItem, actions: QuickAction[], close: () => void, inMenu = false) => {
    const ActionRow = inMenu ? DropdownMenuItem : Button;
    const label = tApps(`${app.id}.title` as Parameters<typeof tApps>[0]);
    const appHref = getLocalizedHref(app.href);

    return (
      <div className="space-y-1">
        <ActionRow asChild className="min-h-10 w-full justify-start bg-transparent px-3 text-foreground shadow-none hover:bg-accent">
          <Link href={app.href} onClick={close}>
            <ArrowRight className="h-4 w-4" />
            {tNav('openApp', { app: label })}
          </Link>
        </ActionRow>
        <ActionRow asChild className="min-h-10 w-full justify-start bg-transparent px-3 text-foreground shadow-none hover:bg-accent">
          <a href={appHref} target="_blank" rel="noopener noreferrer" onClick={close}>
            <ExternalLink className="h-4 w-4" />
            {tNav('openInNewTab')}
          </a>
        </ActionRow>
        {actions.length > 0 && (
          <div className="pt-1">
            {actions.map((action) => (
              <ActionRow key={action.href} asChild className="min-h-10 w-full justify-start bg-transparent px-3 text-foreground shadow-none hover:bg-accent">
                <Link href={action.href} onClick={close}>
                  {action.label}
                </Link>
              </ActionRow>
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
          setShowMoreApps(false);
          if (!open) setActiveActionsApp(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
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
          aria-label={tNav('openAppLauncher')}
          className="w-[280px] max-w-[calc(100vw-24px)] rounded-xl p-2"
        >
          <div className="px-3 pb-2 pt-2 text-xs font-medium text-muted-foreground">
            {tNav(showMoreApps ? 'moreApps' : 'quickAccess')}
          </div>
          <div className="space-y-1">
            {apps.map((app) => {
              const Icon = app.icon;
              const active = isPathActive(pathname, app.href);
              const label = tApps(`${app.id}.title` as Parameters<typeof tApps>[0]);
              return (
                <div key={app.id} className="group relative">
                  <DropdownMenuItem asChild textValue={label}>
                    <Link
                      href={app.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 pr-12 transition-colors',
                        active
                          ? 'bg-primary/10 text-primary'
                          : 'text-foreground hover:bg-accent'
                      )}
                      onClick={closeLauncher}
                      onContextMenu={(e) => handleOpenActions(e, app)}
                    >
                      <div className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
                        active && 'bg-primary/15'
                      )}>
                        <Icon className="size-4" />
                      </div>
                      <span className="text-sm font-medium leading-snug">
                        {label}
                      </span>
                    </Link>
                  </DropdownMenuItem>
                  {app.hasQuickActions && (
                    <DropdownMenuItem
                      asChild
                      onSelect={(event) => event.preventDefault()}
                      className="absolute right-1 top-0.5 inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                    >
                      <button
                        type="button"
                        aria-label={tNav('openAppActions', { app: label })}
                        onClick={(event) => handleOpenActions(event, app)}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuItem>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-2 border-t border-border pt-2">
            <DropdownMenuItem
              className="min-h-11 cursor-pointer rounded-lg px-3 text-muted-foreground"
              onSelect={(event) => {
                event.preventDefault();
                setShowMoreApps((current) => !current);
                setActiveActionsApp(null);
              }}
            >
              {showMoreApps ? <ArrowLeft className="size-4" /> : <LayoutGrid className="size-4" />}
              {tNav(showMoreApps ? 'backToQuickAccess' : 'moreApps')}
              {!showMoreApps && <ArrowRight className="ml-auto size-4" />}
            </DropdownMenuItem>
          </div>
          {activeActionsApp && (
            <div className="mt-3 border-t border-border pt-2">
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                {tNav('appActions', {
                  app: tApps(`${activeActionsApp.id}.title` as Parameters<typeof tApps>[0]),
                })}
              </div>
              {renderActionRows(activeActionsApp, activeActions, closeLauncher, true)}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {mobileActionsApp && (
        <Sheet open={!!mobileActionsApp} onOpenChange={(open) => {
          if (!open) setMobileActionsApp(null);
        }}>
          <SheetContent
            side="bottom"
            className="max-h-[85dvh] overflow-y-auto rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus();
            }}
          >
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
