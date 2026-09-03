'use client';

import { useId } from 'react';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  WORKSPACE_COLOR_OPTIONS,
  type WorkspaceColor,
} from '@/app/lib/workspaces/colors';

type WorkspaceColorPickerProps = {
  value: WorkspaceColor;
  onChange: (color: WorkspaceColor) => void;
  disabled?: boolean;
};

export function WorkspaceColorPicker({ value, onChange, disabled = false }: WorkspaceColorPickerProps) {
  const t = useTranslations('settings.workspacePanel.management');
  const labelId = useId();

  return (
    <fieldset className="flex flex-col gap-2" aria-labelledby={labelId} disabled={disabled}>
      <Label id={labelId}>{t('fields.color')}</Label>
      <div
        className="grid grid-cols-5 gap-2 sm:grid-cols-10"
        role="radiogroup"
        aria-label={t('fields.color')}
      >
        {WORKSPACE_COLOR_OPTIONS.map((option) => {
          const selected = option.value === value;
          const label = t(`colorPicker.colors.${option.id}`);

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                'flex aspect-square items-center justify-center rounded-md border-2 border-transparent shadow-xs transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
                selected && 'border-foreground ring-2 ring-background ring-offset-1 ring-offset-foreground',
              )}
              style={{ backgroundColor: option.value }}
            >
              {selected ? <Check aria-hidden="true" className="h-4 w-4 text-white" strokeWidth={3} /> : null}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('colorPicker.hint')}</p>
    </fieldset>
  );
}
