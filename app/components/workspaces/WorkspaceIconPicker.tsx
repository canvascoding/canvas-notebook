'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { WORKSPACE_ICON_OPTIONS, type WorkspaceIcon } from '@/app/lib/workspaces/icons';
import { renderWorkspaceIconById } from '@/app/components/workspaces/workspace-utils';

type WorkspaceIconPickerProps = {
  value: WorkspaceIcon;
  onChange: (icon: WorkspaceIcon) => void;
  disabled?: boolean;
};

export function WorkspaceIconPicker({ value, onChange, disabled = false }: WorkspaceIconPickerProps) {
  const t = useTranslations('settings.workspacePanel.management');
  const labelId = useId();

  return (
    <fieldset className="flex flex-col gap-2" aria-labelledby={labelId} disabled={disabled}>
      <Label id={labelId}>{t('fields.icon')}</Label>
      <div className="grid grid-cols-5 gap-2 sm:grid-cols-8" role="radiogroup" aria-label={t('fields.icon')}>
        {WORKSPACE_ICON_OPTIONS.map((icon) => {
          const selected = icon === value;
          const label = t(`iconPicker.icons.${icon}`);

          return (
            <button
              key={icon}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={() => onChange(icon)}
              className={cn(
                'flex aspect-square items-center justify-center rounded-md border bg-background text-muted-foreground shadow-xs transition-colors hover:border-foreground/35 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
                selected && 'border-foreground bg-foreground text-background hover:bg-foreground hover:text-background',
              )}
            >
              {renderWorkspaceIconById(icon, 'h-4 w-4')}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('iconPicker.hint')}</p>
    </fieldset>
  );
}
