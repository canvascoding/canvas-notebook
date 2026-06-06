import 'server-only';

import type { TodoWithRelations } from '@/app/lib/todos/store';

import { escapeHtml, renderAppEmailTemplate } from './base';

function appBaseUrl(): string {
  return (process.env.BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/u, '');
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(date);
}

function todoHref(todo: TodoWithRelations): string {
  const url = new URL('/todos', appBaseUrl());
  url.searchParams.set('todo', todo.id);
  if (todo.sourceSessionId) {
    url.searchParams.set('session', todo.sourceSessionId);
    url.searchParams.set('chat', 'open');
  }
  return url.toString();
}

function priorityLabel(value: TodoWithRelations['priority']): string {
  if (value === 'high') return 'Hoch';
  if (value === 'low') return 'Niedrig';
  return 'Normal';
}

export function renderTodoNotificationEmail(todo: TodoWithRelations): { subject: string; html: string } {
  const dueAt = formatDate(todo.dueAt);
  const createdAt = formatDate(todo.createdAt);
  const description = todo.description
    ? `<p class="value">${escapeHtml(todo.description).replace(/\n/g, '<br>')}</p>`
    : '<p class="value muted">Keine Beschreibung hinterlegt.</p>';
  const fileLinks = todo.fileLinks.length > 0
    ? `
      <tr>
        <td>Dateien</td>
        <td>${todo.fileLinks.map((link) => escapeHtml(link.label || link.workspacePath)).join('<br>')}</td>
      </tr>
    `
    : '';

  const bodyHtml = `
    <div class="panel">
      <p class="label">To-do</p>
      <p class="value"><strong>${escapeHtml(todo.title)}</strong></p>
      ${description}
      <table class="meta" role="presentation">
        <tr>
          <td>Kategorie</td>
          <td>${escapeHtml(todo.category?.name ?? 'To-do')}</td>
        </tr>
        <tr>
          <td>Prioritaet</td>
          <td>${escapeHtml(priorityLabel(todo.priority))}</td>
        </tr>
        <tr>
          <td>Faellig</td>
          <td>${escapeHtml(dueAt ?? 'Nicht gesetzt')}</td>
        </tr>
        <tr>
          <td>Erstellt</td>
          <td>${escapeHtml(createdAt ?? 'Gerade eben')}</td>
        </tr>
        ${fileLinks}
      </table>
    </div>
  `;

  return {
    subject: `Neues Canvas To-do: ${todo.title}`.slice(0, 120),
    html: renderAppEmailTemplate({
      title: 'Neues To-do',
      preheader: todo.title,
      intro: 'Dein Canvas Agent hat ein neues To-do fuer dich angelegt.',
      bodyHtml,
      action: {
        label: 'To-do oeffnen',
        href: todoHref(todo),
      },
      footerHtml: 'Diese Benachrichtigung wurde automatisch von Canvas Notebook gesendet, weil ein Agent ein To-do erstellt hat.',
    }),
  };
}
