'use client';

import { useMemo, useState, type ComponentType } from 'react';
import {
  BadgeCheck,
  BarChart3,
  BrainCircuit,
  Bot,
  Cpu,
  FolderCog,
  Globe,
  HardDrive,
  Scale,
  Mail,
  Menu,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  PackageCheck,
  Plug,
  Puzzle,
  Settings2,
  Smartphone,
  UserRound,
  Users,
  Waypoints,
  type LucideProps,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type SettingsTab =
  | 'general'
  | 'mobile-app'
  | 'memory'
  | 'integrations'
  | 'secrets'
  | 'mcp'
  | 'agent-settings'
  | 'browser'
  | 'workspace'
  | 'brand-design'
  | 'user-management'
  | 'data-migration'
  | 'ai-providers'
  | 'system-email'
  | 'usage'
  | 'skills'
  | 'license'
  | 'system-updates'
  | 'legal';

export type SettingsGroup = 'account' | 'workspace' | 'agents' | 'connections' | 'system';

type SettingsIcon = ComponentType<LucideProps>;

export type SettingsNavigationItem = {
  value: SettingsTab;
  labelKey: string;
  descriptionKey: string;
  group: SettingsGroup;
  icon: SettingsIcon;
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{ id: SettingsGroup; labelKey: string }> = [
  { id: 'account', labelKey: 'navigation.groups.account' },
  { id: 'workspace', labelKey: 'navigation.groups.workspace' },
  { id: 'agents', labelKey: 'navigation.groups.agents' },
  { id: 'connections', labelKey: 'navigation.groups.connections' },
  { id: 'system', labelKey: 'navigation.groups.system' },
];

export const SETTINGS_TAB_ITEMS: ReadonlyArray<SettingsNavigationItem> = [
  {
    value: 'general',
    labelKey: 'tabs.general',
    descriptionKey: 'navigation.descriptions.general',
    group: 'account',
    icon: UserRound,
  },
  {
    value: 'mobile-app',
    labelKey: 'tabs.mobileApp',
    descriptionKey: 'navigation.descriptions.mobileApp',
    group: 'account',
    icon: Smartphone,
  },
  {
    value: 'memory',
    labelKey: 'tabs.memory',
    descriptionKey: 'navigation.descriptions.memory',
    group: 'account',
    icon: BrainCircuit,
  },
  {
    value: 'workspace',
    labelKey: 'tabs.workspace',
    descriptionKey: 'navigation.descriptions.workspace',
    group: 'workspace',
    icon: FolderCog,
  },
  {
    value: 'brand-design',
    labelKey: 'tabs.brandDesign',
    descriptionKey: 'navigation.descriptions.brandDesign',
    group: 'workspace',
    icon: Palette,
  },
  {
    value: 'agent-settings',
    labelKey: 'tabs.agentSettings',
    descriptionKey: 'navigation.descriptions.agentSettings',
    group: 'agents',
    icon: Bot,
  },
  {
    value: 'browser',
    labelKey: 'tabs.browser',
    descriptionKey: 'navigation.descriptions.browser',
    group: 'agents',
    icon: Globe,
  },
  {
    value: 'skills',
    labelKey: 'tabs.skills',
    descriptionKey: 'navigation.descriptions.skills',
    group: 'agents',
    icon: Puzzle,
  },
  {
    value: 'integrations',
    labelKey: 'tabs.integrations',
    descriptionKey: 'navigation.descriptions.integrations',
    group: 'connections',
    icon: Plug,
  },
  {
    value: 'secrets',
    labelKey: 'tabs.secrets',
    descriptionKey: 'navigation.descriptions.secrets',
    group: 'system',
    icon: KeyRound,
  },
  {
    value: 'mcp',
    labelKey: 'tabs.mcp',
    descriptionKey: 'navigation.descriptions.mcp',
    group: 'connections',
    icon: Waypoints,
  },
  {
    value: 'ai-providers',
    labelKey: 'tabs.aiProviders',
    descriptionKey: 'navigation.descriptions.aiProviders',
    group: 'system',
    icon: Cpu,
  },
  {
    value: 'system-email',
    labelKey: 'tabs.systemEmail',
    descriptionKey: 'navigation.descriptions.systemEmail',
    group: 'connections',
    icon: Mail,
  },
  {
    value: 'user-management',
    labelKey: 'tabs.userManagement',
    descriptionKey: 'navigation.descriptions.userManagement',
    group: 'system',
    icon: Users,
  },
  {
    value: 'data-migration',
    labelKey: 'tabs.dataMigration',
    descriptionKey: 'navigation.descriptions.dataMigration',
    group: 'system',
    icon: HardDrive,
  },
  {
    value: 'usage',
    labelKey: 'tabs.usage',
    descriptionKey: 'navigation.descriptions.usage',
    group: 'system',
    icon: BarChart3,
  },
  {
    value: 'license',
    labelKey: 'tabs.license',
    descriptionKey: 'navigation.descriptions.license',
    group: 'system',
    icon: BadgeCheck,
  },
  {
    value: 'system-updates',
    labelKey: 'tabs.systemUpdates',
    descriptionKey: 'navigation.descriptions.systemUpdates',
    group: 'system',
    icon: PackageCheck,
  },
  {
    value: 'legal',
    labelKey: 'tabs.legal',
    descriptionKey: 'navigation.descriptions.legal',
    group: 'system',
    icon: Scale,
  },
];

export const SETTINGS_TABS = SETTINGS_TAB_ITEMS.map((item) => item.value);

type SettingsNavigationProps = {
  activeTab: SettingsTab;
  visibleTabs: ReadonlySet<SettingsTab>;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onTabChange: (tab: SettingsTab) => void;
};

function NavigationItems({
  activeTab,
  visibleTabs,
  collapsed,
  onTabChange,
  onNavigate,
}: Pick<SettingsNavigationProps, 'activeTab' | 'visibleTabs' | 'collapsed' | 'onTabChange'> & {
  onNavigate?: () => void;
}) {
  const t = useTranslations('settings');
  const visibleGroups = useMemo(
    () => SETTINGS_NAV_GROUPS.map((group) => ({
      ...group,
      items: SETTINGS_TAB_ITEMS.filter((item) => item.group === group.id && visibleTabs.has(item.value)),
    })).filter((group) => group.items.length > 0),
    [visibleTabs],
  );

  return (
    <nav aria-label={t('navigation.ariaLabel')} className="space-y-5">
      {visibleGroups.map((group, groupIndex) => (
        <div
          key={group.id}
          className={cn(collapsed && groupIndex > 0 && 'border-t border-border/70 pt-3')}
        >
          <p
            className={cn(
              'mb-1.5 px-2 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-muted-foreground/80',
              collapsed && 'sr-only',
            )}
          >
            {t(group.labelKey)}
          </p>
          <div className="space-y-1">
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = item.value === activeTab;
              const button = (
                <button
                  key={item.value}
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={collapsed ? t(item.labelKey) : undefined}
                  onClick={() => {
                    onTabChange(item.value);
                    onNavigate?.();
                  }}
                  className={cn(
                    'group/item relative flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm font-medium text-muted-foreground outline-none transition-colors',
                    'hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted',
                    'after:absolute after:inset-y-2 after:left-0 after:w-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity',
                    isActive && 'bg-background text-foreground shadow-sm after:opacity-100',
                    collapsed && 'justify-center px-0',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4 shrink-0 transition-colors',
                      isActive ? 'text-primary' : 'text-muted-foreground group-hover/item:text-foreground',
                    )}
                    aria-hidden="true"
                  />
                  <span className={cn('min-w-0 truncate', collapsed && 'sr-only')}>{t(item.labelKey)}</span>
                </button>
              );

              if (!collapsed) return button;

              return (
                <Tooltip key={item.value}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent side="right" sideOffset={10}>{t(item.labelKey)}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function SettingsNavigation({
  activeTab,
  visibleTabs,
  collapsed,
  onCollapsedChange,
  onTabChange,
}: SettingsNavigationProps) {
  const t = useTranslations('settings');
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeItem = SETTINGS_TAB_ITEMS.find((item) => item.value === activeTab) ?? SETTINGS_TAB_ITEMS[0];
  const ActiveIcon = activeItem.icon;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="px-3 pt-4 sm:px-6 sm:pt-6 lg:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="h-12 w-full justify-between rounded-lg border-border/80 bg-card px-3 shadow-sm"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <ActiveIcon className="h-4 w-4 text-primary" aria-hidden="true" />
                </span>
                <span className="min-w-0 text-left">
                  <span className="block text-[0.65rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                    {t('navigation.areas')}
                  </span>
                  <span className="block truncate text-sm font-semibold">{t(activeItem.labelKey)}</span>
                </span>
              </span>
              <Menu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[min(21rem,88vw)] gap-0 overflow-y-auto p-0">
            <SheetHeader className="border-b border-border/70 px-5 py-5 text-left">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted/70">
                  <Settings2 className="h-4 w-4" aria-hidden="true" />
                </span>
                <div>
                  <SheetTitle>{t('title')}</SheetTitle>
                  <SheetDescription>{t('navigation.mobileDescription')}</SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <div className="px-3 py-5">
              <NavigationItems
                activeTab={activeTab}
                visibleTabs={visibleTabs}
                collapsed={false}
                onTabChange={onTabChange}
                onNavigate={() => setMobileOpen(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <aside
        className={cn(
          'sticky top-0 hidden h-[calc(100dvh_-_4rem_-_env(safe-area-inset-top))] min-h-0 self-start border-r border-border/70 bg-gradient-to-b from-muted/65 via-muted/30 to-background transition-[width] duration-200 ease-out lg:flex lg:flex-col',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <div className={cn('flex h-16 shrink-0 items-center border-b border-border/70 px-3', collapsed ? 'justify-center' : 'justify-between')}>
          <div className={cn('flex min-w-0 items-center gap-3', collapsed && 'sr-only')}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background shadow-sm">
              <Settings2 className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{t('navigation.areas')}</p>
              <p className="truncate text-xs text-muted-foreground">{t('navigation.desktopDescription')}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onCollapsedChange(!collapsed)}
            aria-label={t(collapsed ? 'navigation.expand' : 'navigation.collapse')}
            title={t(collapsed ? 'navigation.expand' : 'navigation.collapse')}
            className="shrink-0"
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto py-5', collapsed ? 'px-2' : 'px-3')}>
          <NavigationItems
            activeTab={activeTab}
            visibleTabs={visibleTabs}
            collapsed={collapsed}
            onTabChange={onTabChange}
          />
        </div>
      </aside>
    </TooltipProvider>
  );
}
