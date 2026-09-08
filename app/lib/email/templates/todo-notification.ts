import 'server-only';

import { Marked, Renderer, type Tokens } from 'canvas-markdown-parser';

import type { TodoWithRelations } from '@/app/lib/todos/store';
import { getAgentDisplayName } from '@/app/lib/chat/agent-display';

import { escapeHtml, renderAppEmailTemplate } from './base';

type TodoNotificationLocale = 'de' | 'en';

type TodoNotificationCopy = {
  intlLocale: string;
  subjectPrefix: string;
  title: string;
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

function safeMarkdownHref(href: string): string | null {
  if (href.startsWith('#')) return href;
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

const emailMarkdownRenderer = new Renderer();
const defaultMarkdownLink = emailMarkdownRenderer.link;
emailMarkdownRenderer.html = ({ text }: Tokens.HTML | Tokens.Tag): string => escapeHtml(text);
emailMarkdownRenderer.link = function renderSafeEmailLink(token: Tokens.Link): string {
  const href = safeMarkdownHref(token.href);
  if (!href) return this.parser.parseInline(token.tokens);
  return defaultMarkdownLink.call(this, { ...token, href });
};
emailMarkdownRenderer.image = ({ text }: Tokens.Image): string => escapeHtml(text);

const emailMarkdown = new Marked({
  breaks: true,
  gfm: true,
  renderer: emailMarkdownRenderer,
});

function renderEmailMarkdown(markdown: string): string {
  const withoutRawHtml = markdown
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return String(emailMarkdown.parse(withoutRawHtml));
}

function fileName(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '');
  return normalized.split('/').pop() || normalized;
}

function appBaseUrl(): string {
  return (process.env.BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/u, '');
}

function normalizeLocale(locale?: string | null): TodoNotificationLocale {
  return locale?.toLowerCase().startsWith('en') ? 'en' : 'de';
}

function todoIntro(todo: TodoWithRelations, locale: TodoNotificationLocale): string {
  const sourceName = todo.sourceType === 'agent'
    ? getAgentDisplayName(todo.sourceAgentId)
    : 'Canvas Notebook';
  return locale === 'de'
    ? `${sourceName} hat ein neues To-do für dich angelegt.`
    : `${sourceName} created a new to-do for you.`;
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
  if (todo.workspaceId) {
    url.searchParams.set('workspaceId', todo.workspaceId);
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
    ? `<div class="value markdown">${renderEmailMarkdown(todo.description)}</div>`
    : `<p class="value muted">${escapeHtml(copy.noDescription)}</p>`;
  const fileLinks = todo.fileLinks.length > 0
    ? `
      <tr>
        <td>${escapeHtml(copy.fields.files)}</td>
        <td>
          <table class="file-list" role="presentation">
            ${todo.fileLinks.map((link) => `
              <tr>
                <td class="file-icon" aria-hidden="true">&#128196;</td>
                <td class="file-name">${escapeHtml(fileName(link.label || link.workspacePath))}</td>
              </tr>
            `).join('')}
          </table>
        </td>
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
      intro: todoIntro(todo, locale),
      bodyHtml,
      action: {
        label: copy.actionLabel,
        href: todoHref(todo, locale),
      },
      footerHtml: escapeHtml(copy.footer),
    }),
  };
}
