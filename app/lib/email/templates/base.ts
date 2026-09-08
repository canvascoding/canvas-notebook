import 'server-only';

export type EmailTemplateAction = {
  label: string;
  href: string;
};

type AppEmailTemplateInput = {
  locale?: string;
  title: string;
  preheader?: string;
  intro?: string;
  bodyHtml: string;
  action?: EmailTemplateAction;
  footerHtml?: string;
};

export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeTemplateLocale(locale: string | null | undefined): 'de' | 'en' {
  return locale?.toLowerCase().startsWith('en') ? 'en' : 'de';
}

export function renderAppEmailTemplate(input: AppEmailTemplateInput): string {
  const locale = normalizeTemplateLocale(input.locale);
  const preheader = input.preheader ? escapeHtml(input.preheader) : '';
  const intro = input.intro ? `<p class="muted">${escapeHtml(input.intro)}</p>` : '';
  const action = input.action
    ? `
      <p class="action-row">
        <a class="button" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a>
      </p>
    `
    : '';

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)}</title>
    <style>
      body {
        margin: 0;
        padding: 0;
        background: #f6f7f9;
        color: #171717;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body, table, td, div, p, a, span {
        box-sizing: border-box;
      }
      .preheader {
        display: none;
        max-height: 0;
        overflow: hidden;
        opacity: 0;
        color: transparent;
      }
      .wrap {
        width: 100%;
        padding: 28px 16px;
      }
      .card {
        width: 100%;
        max-width: 620px;
        margin: 0 auto;
        border: 1px solid #e2e5ea;
        background: #ffffff;
      }
      .header {
        padding: 22px 24px 14px;
        border-bottom: 1px solid #eceff3;
      }
      .brand {
        margin: 0 0 10px;
        color: #5f6673;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        color: #111827;
        font-size: 22px;
        line-height: 1.25;
        font-weight: 700;
      }
      .content {
        padding: 20px 24px 24px;
      }
      p {
        margin: 0 0 14px;
        color: #252b36;
        font-size: 14px;
        line-height: 1.6;
      }
      .muted {
        color: #697282;
      }
      .panel {
        margin: 18px 0;
        padding: 16px;
        border: 1px solid #e7eaf0;
        background: #fafbfc;
      }
      .label {
        margin: 0 0 5px;
        color: #697282;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .value {
        margin: 0;
        color: #151922;
        font-size: 14px;
        line-height: 1.55;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .markdown > :first-child {
        margin-top: 0;
      }
      .markdown > :last-child {
        margin-bottom: 0;
      }
      .markdown p,
      .markdown ul,
      .markdown ol,
      .markdown blockquote,
      .markdown pre,
      .markdown table {
        margin: 0 0 12px;
      }
      .markdown ul,
      .markdown ol {
        padding-left: 22px;
      }
      .markdown li {
        margin: 3px 0;
      }
      .markdown h1,
      .markdown h2,
      .markdown h3,
      .markdown h4 {
        margin: 16px 0 7px;
        color: #151922;
        font-size: 14px;
        line-height: 1.4;
      }
      .markdown code {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .markdown pre {
        max-width: 100%;
        padding: 10px;
        overflow: hidden;
        background: #f1f3f6;
        white-space: pre-wrap;
      }
      .markdown blockquote {
        padding-left: 12px;
        border-left: 3px solid #d8dde6;
      }
      .markdown table {
        width: 100%;
        max-width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .markdown th,
      .markdown td {
        padding: 6px;
        border: 1px solid #dfe3e9;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .meta {
        width: 100%;
        max-width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        margin-top: 12px;
      }
      .meta td {
        padding: 7px 0;
        border-top: 1px solid #eceff3;
        color: #303744;
        font-size: 13px;
        vertical-align: top;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .meta td:first-child {
        width: 36%;
        color: #697282;
      }
      .file-list {
        width: 100%;
        max-width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .file-list td {
        padding: 2px 0;
        border: 0;
      }
      .file-list .file-icon {
        width: 22px;
        padding-right: 6px;
        color: #697282;
        font-size: 14px;
        line-height: 1.35;
      }
      .file-list .file-name {
        width: auto;
        color: #303744;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .action-row {
        margin: 22px 0 4px;
      }
      .button {
        display: inline-block;
        background: #111827;
        color: #ffffff !important;
        padding: 10px 14px;
        text-decoration: none;
        font-size: 14px;
        font-weight: 700;
      }
      .footer {
        padding-top: 12px;
        color: #747d8c;
        font-size: 12px;
        line-height: 1.5;
      }
      a {
        color: #111827;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      @media only screen and (max-width: 480px) {
        .wrap { padding: 12px 8px !important; }
        .header { padding: 18px 16px 12px !important; }
        .content { padding: 16px !important; }
        .panel { padding: 13px !important; }
        .meta td:first-child { width: 30% !important; padding-right: 10px !important; }
      }
    </style>
  </head>
  <body>
    <span class="preheader">${preheader}</span>
    <div class="wrap">
      <div class="card">
        <div class="header">
          <p class="brand">Canvas Notebook</p>
          <h1>${escapeHtml(input.title)}</h1>
        </div>
        <div class="content">
          ${intro}
          ${input.bodyHtml}
          ${action}
          ${input.footerHtml ? `<div class="footer">${input.footerHtml}</div>` : ''}
        </div>
      </div>
    </div>
  </body>
</html>`;
}
