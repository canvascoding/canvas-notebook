'use client';

import { useCallback, useId } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface AppItem {
  id: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  hasQuickActions: boolean;
}

interface QuickAction {
  label: string;
  href: string;
}

function getQuickActions(app: AppItem, tStudio: ReturnType<typeof useTranslations>, tSettings: ReturnType<typeof useTranslations>): QuickAction[] {
  if (app.id === 'settings') {
    return [
      { label: tSettings('tabs.general'), href: '/settings?tab=general' },
      { label: tSettings('tabs.agentSettings'), href: '/settings?tab=agentSettings' },
      { label: tSettings('tabs.workspace'), href: '/settings?tab=workspace' },
      { label: tSettings('tabs.integrations'), href: '/settings?tab=integrations' },
      { label: tSettings('tabs.skills'), href: '/settings?tab=skills' },
    ];
  }

  if (app.id === 'studio') {
    return [
      { label: tStudio('tabs.create'), href: '/studio/create' },
      { label: tStudio('tabs.models'), href: '/studio/models' },
      { label: tStudio('tabs.presets'), href: '/studio/presets' },
      { label: tStudio('tabs.bulk'), href: '/studio/bulk' },
    ];
  }

  return [];
}

function getAppLabel(app: AppItem, tApps: ReturnType<typeof useTranslations>): string {
  return tApps(`${app.id}.title` as Parameters<typeof tApps>[0]);
}

interface AppContextMenuProps {
  app: AppItem;
  position: { x: number; y: number };
  isOpen: boolean;
  onClose: () => void;
}

export function AppContextMenu({ app, position, isOpen, onClose }: AppContextMenuProps) {
  const tApps = useTranslations('home.apps');
  const tStudio = useTranslations('studio');
  const tSettings = useTranslations('settings');
  const router = useRouter();
  const requestId = useId();

  const actions = getQuickActions(app, tStudio, tSettings);
  const label = getAppLabel(app, tApps);

  const handleSelect = useCallback((href: string) => {
    onClose();
    router.push(href);
  }, [onClose, router]);

  if (actions.length === 0) return null;

  return (
    <DropdownMenu
      key={requestId}
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-hidden="true"
          className="pointer-events-none fixed h-1 w-1 opacity-0"
          style={{ left: position.x, top: position.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-56"
      >
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.href}
            onSelect={() => handleSelect(action.href)}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}