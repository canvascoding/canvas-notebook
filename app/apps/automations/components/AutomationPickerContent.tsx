'use client';

import type { ComponentProps } from 'react';
import { Popover } from 'radix-ui';
import { cn } from '@/lib/utils';

/** Use the Radix bundle that shares focus and dismissal layers with the editor dialog. */
export function AutomationPickerContent({ className, ...props }: ComponentProps<typeof Popover.Content>) {
  return (
    <Popover.Portal>
      <Popover.Content
        align="start"
        sideOffset={6}
        data-automation-picker="true"
        className={cn(
          'z-[60] w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg outline-none',
          className,
        )}
        {...props}
      />
    </Popover.Portal>
  );
}
