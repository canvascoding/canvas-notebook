'use client';

import { Map } from 'lucide-react';
import { usePlanModeStore } from '@/app/store/plan-mode-store';
import { cn } from '@/lib/utils';

export function PlanModeToggle() {
  const { planningMode, togglePlanningMode } = usePlanModeStore();

  return (
    <button
      type="button"
      onClick={togglePlanningMode}
      title={planningMode ? 'Planning Mode active — Shift+Tab to switch back' : 'Enable Planning Mode (Shift+Tab)'}
      className={cn(
        'inline-flex items-center gap-1 border px-2 py-1 text-[10px] transition-all',
        planningMode
          ? 'border-amber-500 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400'
          : 'border-border/60 bg-muted/30 text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Map className="h-3 w-3" />
      {planningMode ? 'Planning Mode' : 'Standard Mode'}
    </button>
  );
}
