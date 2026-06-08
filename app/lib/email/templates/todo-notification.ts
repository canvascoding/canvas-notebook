import 'server-only';

import type { TodoWithRelations } from '@/app/lib/todos/store';

import { escapeHtml, renderAppEmailTemplate } from './base';

type TodoNotificationLocale = 'de' | 'en';

type TodoNotificationCopy = {
  intlLocale: string;
  subjectPrefix: string;
  title: string;
  intro: string;
  todoLabel: string;
  noDescription: string;
  fields: {
    category: string;
    files: string;
    priority: string;
    dueAt: string;
    createdAt: string;
    replyCode: string;
  };
  values: {
    defaultCategory: string;
    noDueAt: string;
    justNow: string;
  };
  priorities: Record<TodoWithRelations['priority'], string>;
  actionLabel: string;
  replyHint: string;
  footer: string;
};

const COPY: Record<TodoNotificationLocale, TodoNotificationCopy> = {
  de: {
    intlLocale: 'de-DE',
    subjectPrefix: 'Neues Canvas To-do',
    title: 'Neues To-do',
    intro: 'Dein Canvas Agent hat ein neues To-do für dich angelegt.',
    todoLabel: 'To-do',
    noDescription: 'Keine Beschreibung hinterlegt.',
    fields: {
      category: 'Kategorie',
      files: 'Dateien',
      priority: 'Priorität',
      dueAt: 'Fällig',
      createdAt: 'Erstellt',
      replyCode: 'Antwort-Code',
    },
    values: {
      defaultCategory: 'To-do',
      noDueAt: 'Nicht gesetzt',
      justNow: 'Gerade eben',
    },
    priorities: {
      high: 'Hoch',
      low: 'Niedrig',
      normal: 'Normal',
    },
    actionLabel: 'To-do öffnen',
    replyHint: 'Du kannst direkt auf diese E-Mail antworten. Canvas leitet deine Antwort an die verknüpfte Agent-Session weiter.',
    footer: 'Diese Benachrichtigung wurde automatisch von Canvas Notebook gesendet, weil ein Agent ein To-do erstellt hat.',
  },
  en: {
    intlLocale: 'en-US',
    subjectPrefix: 'New Canvas to-do',
    title: 'New to-do',
    intro: 'Your Canvas Agent created a new to-do for you.',
    todoLabel: 'To-do',
    noDescription: 'No description provided.',
    fields: {
      category: 'Category',
      files: 'Files',
      priority: 'Priority',
      dueAt: 'Due',
      createdAt: 'Created',
      replyCode: 'Reply code',
    },
    values: {
      defaultCategory: 'To-do',
      noDueAt: 'Not set',
      justNow: 'Just now',
    },
    priorities: {
      high: 'High',
      low: 'Low',
      normal: 'Normal',
    },
    actionLabel: 'Open to-do',
    replyHint: 'You can reply directly to this email. Canvas will forward your reply to the linked agent session.',
    footer: 'This notification was sent automatically by Canvas Notebook because an agent created a to-do.',
  },
};

function appBaseUrl(): string {
  return (process.env.BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/u, '');
}

function normalizeLocale(locale?: string | null): TodoNotificationLocale {
  return locale?.toLowerCase().startsWith('en') ? 'en' : 'de';
}

function formatDate(value: Date | string | null, copy: TodoNotificationCopy): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(copy.intlLocale, { dateStyle: 'medium' }).format(date);
}

function todoHref(todo: TodoWithRelations, locale: TodoNotificationLocale): string {
  const url = new URL(locale === 'en' ? '/en/todos' : '/todos', appBaseUrl());
  url.searchParams.set('todo', todo.id);
  if (todo.sourceSessionId) {
    url.searchParams.set('session', todo.sourceSessionId);
    url.searchParams.set('chat', 'open');
  }
  return url.toString();
}

export function renderTodoNotificationEmail(
  todo: TodoWithRelations,
  localeInput?: string | null,
  options: { replyToken?: string | null } = {},
): { subject: string; html: string } {
  const locale = normalizeLocale(localeInput);
  const copy = COPY[locale];
  const dueAt = formatDate(todo.dueAt, copy);
  const createdAt = formatDate(todo.createdAt, copy);
  const description = todo.description
    ? `<p class="value">${escapeHtml(todo.description).replace(/\n/g, '<br>')}</p>`
    : `<p class="value muted">${escapeHtml(copy.noDescription)}</p>`;
  const fileLinks = todo.fileLinks.length > 0
    ? `
      <tr>
        <td>${escapeHtml(copy.fields.files)}</td>
        <td>${todo.fileLinks.map((link) => escapeHtml(link.label || link.workspacePath)).join('<br>')}</td>
      </tr>
    `
    : '';

  const bodyHtml = `
    <div class="panel">
      <p class="label">${escapeHtml(copy.todoLabel)}</p>
      <p class="value"><strong>${escapeHtml(todo.title)}</strong></p>
      ${description}
      <table class="meta" role="presentation">
        <tr>
          <td>${escapeHtml(copy.fields.category)}</td>
          <td>${escapeHtml(todo.category?.name ?? copy.values.defaultCategory)}</td>
        </tr>
        <tr>
          <td>${escapeHtml(copy.fields.priority)}</td>
          <td>${escapeHtml(copy.priorities[todo.priority] ?? copy.priorities.normal)}</td>
        </tr>
        <tr>
          <td>${escapeHtml(copy.fields.dueAt)}</td>
          <td>${escapeHtml(dueAt ?? copy.values.noDueAt)}</td>
        </tr>
        <tr>
          <td>${escapeHtml(copy.fields.createdAt)}</td>
          <td>${escapeHtml(createdAt ?? copy.values.justNow)}</td>
        </tr>
        ${options.replyToken ? `
        <tr>
          <td>${escapeHtml(copy.fields.replyCode)}</td>
          <td>${escapeHtml(options.replyToken)}</td>
        </tr>
        ` : ''}
        ${fileLinks}
      </table>
      ${options.replyToken ? `<p class="muted">${escapeHtml(copy.replyHint)}</p>` : ''}
    </div>
  `;

  return {
    subject: `${copy.subjectPrefix}: ${todo.title}`.slice(0, 120),
    html: renderAppEmailTemplate({
      locale,
      title: copy.title,
      preheader: todo.title,
      intro: copy.intro,
      bodyHtml,
      action: {
        label: copy.actionLabel,
        href: todoHref(todo, locale),
      },
      footerHtml: escapeHtml(copy.footer),
    }),
  };
}
