'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, FolderSearch, Search, X } from 'lucide-react';
import type { WorkspaceFileReferenceEntry } from '@/app/lib/files/client';
import type { AssigneeOption, TodoCategory, TodoFormState, TodoIconKey, TodoPriority } from '@/app/lib/todos/client-types';
import { formatTodoUser, priorities, todoIconKeys } from '@/app/lib/todos/client-presentation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export type TodoEditorFieldsProps = {
  form: TodoFormState;
  onChange: (form: TodoFormState) => void;
  categories: TodoCategory[];
  assignees: AssigneeOption[];
  selectedCategory?: TodoCategory | null;
  selectedAssignee?: AssigneeOption | null;
  formatCategoryName: (category: Pick<TodoCategory, 'name' | 'icon'> | null | undefined) => string;
  fileQuery: string;
  onFileQueryChange: (query: string) => void;
  fileResults: WorkspaceFileReferenceEntry[];
  isFileSearching: boolean;
  onAddFile: (file: WorkspaceFileReferenceEntry) => void;
  onRemoveFile: (path: string) => void;
  scopeContent?: ReactNode;
  compact?: boolean;
};

export function TodoEditorFields({ form, onChange, categories, assignees, selectedCategory, selectedAssignee, formatCategoryName, fileQuery, onFileQueryChange, fileResults, isFileSearching, onAddFile, onRemoveFile, scopeContent, compact = false }: TodoEditorFieldsProps) {
  const t = useTranslations('todos');
  const categoryOptions = selectedCategory && !categories.some((entry) => entry.id === selectedCategory.id)
    ? [...categories, selectedCategory] : categories;
  const currentAssignee = selectedAssignee ?? (form.assigneeUserId ? { id: form.assigneeUserId, name: null, email: null } : null);
  const assigneeOptions = currentAssignee && !assignees.some((entry) => entry.id === currentAssignee.id)
    ? [...assignees, currentAssignee] : assignees;
  return (
    <div className={compact ? "grid min-w-0 gap-5" : "grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]"}>
      <div className="min-w-0 space-y-4">
        {scopeContent}
        <div className="space-y-2">
          <Label htmlFor="todo-title">{t('fields.title')}</Label>
          <Input
            id="todo-title"
            data-testid="todo-editor-title"
            value={form.title}
            onChange={(event) => onChange({ ...form, title: event.target.value })}
            maxLength={180}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="todo-description">{t('fields.description')}</Label>
          <Textarea
            id="todo-description"
            value={form.description}
            onChange={(event) => onChange({ ...form, description: event.target.value })}
            className="min-h-36"
            maxLength={5000}
          />
        </div>
        <div className={compact ? "grid min-w-0 gap-4 sm:grid-cols-2" : "grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4"}>
          <label className="min-w-0 space-y-2 text-sm">
            <span className="font-medium">{t('fields.category')}</span>
            <select
              className="h-9 w-full min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.categoryId}
              onChange={(event) => onChange({ ...form, categoryId: event.target.value })}
            >
              <option value="">{t('filters.noCategory')}</option>
              {categoryOptions.map((category) => (
                <option key={category.id} value={category.id}>{formatCategoryName(category)}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0 space-y-2 text-sm">
            <span className="font-medium">{t('fields.priority')}</span>
            <select
              className="h-9 w-full min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.priority}
              onChange={(event) => onChange({ ...form, priority: event.target.value as TodoPriority })}
            >
              {priorities.map((priority) => (
                <option key={priority} value={priority}>{t(`priority.${priority}`)}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0 space-y-2 text-sm">
            <span className="font-medium">{t('fields.icon')}</span>
            <select className="h-9 w-full min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm" value={form.iconKey} onChange={(event) => onChange({ ...form, iconKey: event.target.value as TodoIconKey | '' })}>
              <option value="">{t('labels.categoryIcon')}</option>
              {todoIconKeys.map((iconKey) => <option key={iconKey} value={iconKey}>{t(`icons.${iconKey}`)}</option>)}
            </select>
          </label>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="todo-due-at">{t('fields.dueAt')}</Label>
            <Input
              id="todo-due-at"
              type="date"
              value={form.dueAt}
              onChange={(event) => onChange({ ...form, dueAt: event.target.value })}
              className="block max-w-full [min-inline-size:0] [&::-webkit-date-and-time-value]:min-w-0 [&::-webkit-date-and-time-value]:text-left"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="todo-remind-at">{t('fields.remindAt')}</Label>
          <Input id="todo-remind-at" type="datetime-local" className="block w-full min-w-0 max-w-full [min-inline-size:0] [&::-webkit-date-and-time-value]:min-w-0 [&::-webkit-date-and-time-value]:text-left" value={form.remindAt} onChange={(event) => onChange({ ...form, remindAt: event.target.value })} />
        </div>
        <label className="min-w-0 space-y-2 text-sm">
          <span className="font-medium">{t('fields.assignee')}</span>
          <select
            id="todo-assignee"
            className="h-9 w-full min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm"
            value={form.assigneeUserId}
            onChange={(event) => onChange({ ...form, assigneeUserId: event.target.value })}
          >
            <option value="">{t('labels.unassigned')}</option>
            {assigneeOptions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {formatTodoUser(candidate, candidate.id)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="min-w-0 space-y-3">
        <div className="space-y-2">
          <Label htmlFor="todo-file-search">{t('fields.fileSearch')}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="todo-file-search"
              data-testid="todo-file-search"
              value={fileQuery}
              onChange={(event) => onFileQueryChange(event.target.value)}
              className="pl-9"
              placeholder={t('fields.fileSearchPlaceholder')}
            />
          </div>
        </div>

        <div className="min-w-0 max-w-full max-h-52 overflow-y-auto rounded-md border border-border">
          {isFileSearching ? (
            <div className="p-3 text-sm text-muted-foreground">{t('states.searchingFiles')}</div>
          ) : fileResults.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">{t('states.noFileResults')}</div>
          ) : (
            fileResults.map((file) => (
              <button
                key={file.path}
                type="button"
                data-testid="todo-file-result"
                className="flex min-w-0 w-full max-w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                disabled={file.type !== 'file'}
                onClick={() => onAddFile(file)}
              >
                <FolderSearch className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
              </button>
            ))
          )}
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-medium">{t('fields.linkedFiles')}</h4>
          {form.fileLinks.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
              {t('states.noFiles')}
            </p>
          ) : (
            <div className="space-y-2">
              {form.fileLinks.map((link) => (
                <div key={link.workspacePath} className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{link.label || link.workspacePath}</span>
                  <Button variant="ghost" size="icon-xs" onClick={() => onRemoveFile(link.workspacePath)} aria-label={t('actions.removeFile')}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
