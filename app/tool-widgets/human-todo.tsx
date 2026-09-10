import { createRoot } from 'react-dom/client';
import { readTodoAppData } from '../lib/tool-apps/todo-data';
import { WidgetField, WidgetShell } from './components';
import { useWidget } from './use-widget';

function TodoView() {
  const { data: todo, locale, operation, failed, t } = useWidget('Canvas Todo', readTodoAppData);
  if (!todo) return <main className="widget-shell" role="status">{t(failed ? 'invalid' : 'loading')}</main>;
  return <WidgetShell title={t(operation === 'create_human_todo' ? 'todoCreated' : operation === 'update_human_todo' ? 'todoUpdated' : 'todoInspected')}
    status={t(`todoStatus_${todo.status}`)}>
    <h1>{todo.title}</h1>
    <dl><WidgetField label={t('todoDue')}>{todo.dueAt
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(todo.dueAt)) : t('todoNoDue')}</WidgetField>
      <WidgetField label={t('todoAssignee')}>{todo.assignee || t('todoUnassigned')}</WidgetField>
      <WidgetField label={t('todoPriority')}>{t(`todoPriority_${todo.priority}`)}</WidgetField>
      <WidgetField label={t('todoCategory')}>{todo.category || t('todoNoCategory')}</WidgetField></dl>
    <p className="widget-note">{t('currentState')}</p>
  </WidgetShell>;
}
createRoot(document.body.appendChild(document.createElement('div'))).render(<TodoView />);
