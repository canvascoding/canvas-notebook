'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCheck, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { bulkActionAllowsStatus, type TodoBulkAction } from '@/app/lib/todos/bulk-policy';
import type { useTodoBulkSelection } from './todo-bulk-selection';

export function TodoSelectionCheckbox({ label, checked, mixed = false, disabled = false, onChange }: {
  label: string; checked: boolean; mixed?: boolean; disabled?: boolean; onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" aria-label={label} aria-checked={mixed ? 'mixed' : checked} checked={checked} disabled={disabled} onChange={onChange}
    className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-border accent-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40" />;
}

export function TodoBulkToolbar({ selection, disabled, categories, assignees }: {
  selection: ReturnType<typeof useTodoBulkSelection>;
  disabled: boolean;
  categories: Array<{ id: string; name: string }>;
  assignees: Array<{ id: string; name: string | null; email: string | null }>;
}) {
  const t = useTranslations('todos');
  const [action, setAction] = useState<TodoBulkAction['type'] | ''>('');
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const count = selection.items.size;
  const locked = disabled || selection.selecting || selection.busy;
  const allowed = (type: TodoBulkAction['type']) => count > 0 && [...selection.items.values()].every((item) => bulkActionAllowsStatus(type, item.status));
  const actions = ['complete', 'reopen', 'category', 'priority', 'assign', 'archive', 'restore'] as const;
  const needsValue = action === 'category' || action === 'priority' || action === 'assign';
  const valid = action && allowed(action) && (!needsValue || value !== '');

  const apply = async () => {
    if (!valid) return;
    const command: TodoBulkAction = action === 'category' ? { type: action, categoryId: value === '__none__' ? null : value }
      : action === 'priority' ? { type: action, priority: value as 'low' | 'normal' | 'high' }
        : action === 'assign' ? { type: action, assigneeUserId: value === '__none__' ? null : value }
          : { type: action };
    if (await selection.run(command)) { setConfirming(false); setAction(''); setValue(''); }
    else setConfirming(false);
  };

  return (
    <div data-testid="todo-bulk-toolbar" className="sticky top-0 z-10 space-y-2 rounded-md border border-border bg-background/95 p-3 shadow-sm backdrop-blur" aria-busy={selection.busy || selection.selecting}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <TodoSelectionCheckbox label={t('bulk.selectAll')} checked={selection.all} mixed={count > 0 && !selection.all} disabled={disabled || selection.busy}
            onChange={() => {
              if (selection.selecting) return;
              if (selection.all) selection.clear();
              else void selection.selectAll();
            }} />
          {t('bulk.selectAll')}
        </label>
        {(selection.selecting || selection.busy) && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground" role="status">{t('bulk.selected', { count })}</span>
        {count > 0 && <Button variant="ghost" size="icon-xs" aria-label={t('bulk.clear')} disabled={selection.busy} onClick={selection.clear}><X className="h-4 w-4" /></Button>}
      </div>
      {count > 0 && <>
        <p className="text-xs text-muted-foreground">{t('bulk.snapshot')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={t('bulk.action')} className="h-9 w-full min-w-0 flex-none rounded-md border border-input bg-background px-2 text-sm sm:w-auto sm:flex-1" value={action} disabled={locked}
            onChange={(event) => { setAction(event.target.value as typeof action); setValue(''); }}>
            <option value="">{t('bulk.action')}</option>
            {actions.map((type) => <option key={type} value={type} disabled={!allowed(type)}>{t(`bulk.actions.${type}`)}</option>)}
          </select>
          {needsValue && <select aria-label={t('bulk.target')} className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm" value={value} disabled={locked} onChange={(event) => setValue(event.target.value)}>
            <option value="">{t('bulk.target')}</option>
            {action === 'priority' ? ['low', 'normal', 'high'].map((priority) => <option key={priority} value={priority}>{t(`priority.${priority}`)}</option>) : <>
              <option value="__none__">{action === 'category' ? t('filters.noCategory') : t('bulk.unassigned')}</option>
              {(action === 'category' ? categories : assignees).map((item) => <option key={item.id} value={item.id}>{item.name || ('email' in item ? item.email : '') || item.id}</option>)}
            </>}
          </select>}
          <Button size="sm" variant={action === 'archive' ? 'destructive' : 'default'} disabled={locked || !valid} onClick={() => action === 'archive' ? setConfirming(true) : void apply()}>
            <CheckCheck className="h-4 w-4" />{t('bulk.apply')}
          </Button>
        </div>
        {action === 'assign' && <p className="text-xs text-muted-foreground">{t('bulk.assignmentHint')}</p>}
        {!actions.some(allowed) && <p className="text-xs text-muted-foreground">{t('bulk.mixedArchive')}</p>}
      </>}
      {selection.excluded > 0 && <p className="text-xs text-muted-foreground">{t('bulk.excluded', { count: selection.excluded })}</p>}
      {selection.error && <p role="alert" className="text-sm text-destructive">{selection.error}</p>}
      <Dialog open={confirming && count > 0} onOpenChange={(open) => { if (!selection.busy) setConfirming(open); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('bulk.deleteTitle', { count })}</DialogTitle><DialogDescription>{t('bulk.deleteDescription')}</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={selection.busy} onClick={() => setConfirming(false)}>{t('actions.cancel')}</Button>
            <Button variant="destructive" disabled={locked || !valid} onClick={() => void apply()}>{t('bulk.actions.archive')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
