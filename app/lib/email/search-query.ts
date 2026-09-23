import type { SearchObject } from 'imapflow';

export const EMAIL_SEARCH_SYNTAX_VERSION = 1;
export const EMAIL_SEARCH_FIELDS = ['from', 'to', 'cc', 'bcc', 'subject', 'body'] as const;
export type EmailSearchField = typeof EMAIL_SEARCH_FIELDS[number];
export type EmailSearchExpression =
  | { type: 'term'; field?: EmailSearchField; value: string }
  | { type: 'and'; left: EmailSearchExpression; right: EmailSearchExpression }
  | { type: 'or'; left: EmailSearchExpression; right: EmailSearchExpression };

export class EmailSearchQueryError extends Error {
  readonly code = 'INVALID_EMAIL_SEARCH_QUERY';
  constructor(message: string) {
    super(message);
    this.name = 'EmailSearchQueryError';
  }
}

type Token = { kind: 'value' | 'and' | 'or' | '(' | ')' | ':'; value: string };

/** Shared UI/tool grammar. Quoted values are always literals, never provider syntax. */
export function parseEmailSearchQuery(query?: string): EmailSearchExpression | null {
  if (query != null && typeof query !== 'string') throw new EmailSearchQueryError('Search must be a text query.');
  const source = (query || '').normalize('NFC').trim();
  if (!source) return null;
  if (source.length > 1024) throw new EmailSearchQueryError('Search is too long. Use at most 1024 characters.');
  if (/[\u0000-\u001f\u007f]/u.test(source)) throw new EmailSearchQueryError('Search cannot contain control characters or line breaks.');
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const char = source[position];
    if (/\s/u.test(char)) { position++; continue; }
    if ('():'.includes(char)) { tokens.push({ kind: char as '(' | ')' | ':', value: char }); position++; continue; }
    if (char === '"') {
      position++;
      let value = '';
      let closed = false;
      while (position < source.length) {
        const next = source[position++];
        if (next === '"') { closed = true; break; }
        if (next === '\\') {
          const escaped = source[position++];
          if (escaped !== '"' && escaped !== '\\') throw new EmailSearchQueryError('Inside quotes, only quotes and backslashes can be escaped.');
          value += escaped;
        } else value += next;
      }
      if (!closed) throw new EmailSearchQueryError('Close the quotation marks in your search.');
      if (!value.trim()) throw new EmailSearchQueryError('A search phrase cannot be empty.');
      tokens.push({ kind: 'value', value });
      continue;
    }
    const start = position;
    while (position < source.length && !/[\s():"]/u.test(source[position])) position++;
    const value = source.slice(start, position);
    tokens.push({ kind: value === 'AND' ? 'and' : value === 'OR' ? 'or' : 'value', value });
  }
  let index = 0;
  let terms = 0;
  function atom(depth: number): EmailSearchExpression {
    if (depth > 8) throw new EmailSearchQueryError('Search has too many nested groups (maximum 8).');
    const token = tokens[index++];
    if (!token) throw new EmailSearchQueryError('Add a search term after the operator.');
    if (token.kind === '(') {
      const expression = or(depth + 1);
      if (tokens[index++]?.kind !== ')') throw new EmailSearchQueryError('Close the parentheses in your search.');
      return expression;
    }
    if (token.kind !== 'value') throw new EmailSearchQueryError('Expected a search term, phrase or group.');
    let value = token.value;
    let field: EmailSearchField | undefined;
    if (tokens[index]?.kind === ':') {
      if (!EMAIL_SEARCH_FIELDS.includes(value.toLowerCase() as EmailSearchField)) {
        throw new EmailSearchQueryError(`Unknown search field "${value}". Use from, to, cc, bcc, subject or body.`);
      }
      field = value.toLowerCase() as EmailSearchField;
      index++;
      const fieldValue = tokens[index++];
      if (fieldValue?.kind !== 'value') throw new EmailSearchQueryError(`Add a value after ${field}: (quote phrases).`);
      value = fieldValue.value;
    }
    if (++terms > 64) throw new EmailSearchQueryError('Search has too many terms (maximum 64).');
    return { type: 'term', ...(field ? { field } : {}), value };
  }
  function and(depth: number): EmailSearchExpression {
    let expression = atom(depth);
    while (tokens[index] && !['or', ')'].includes(tokens[index].kind)) {
      if (tokens[index].kind === 'and') index++;
      expression = { type: 'and', left: expression, right: atom(depth) };
    }
    return expression;
  }
  function or(depth: number): EmailSearchExpression {
    let expression = and(depth);
    while (tokens[index]?.kind === 'or') {
      index++;
      expression = { type: 'or', left: expression, right: and(depth) };
    }
    return expression;
  }
  const expression = or(0);
  if (index !== tokens.length) throw new EmailSearchQueryError('Unexpected closing parenthesis in search.');
  return expression;
}

export function serializeEmailSearchQuery(expression: EmailSearchExpression | null): string {
  if (!expression) return '';
  if (expression.type === 'term') return `${expression.field ? `${expression.field}:` : ''}${JSON.stringify(expression.value)}`;
  return `(${serializeEmailSearchQuery(expression.left)} ${expression.type.toUpperCase()} ${serializeEmailSearchQuery(expression.right)})`;
}

export function normalizeEmailSearchQuery(query?: string): string {
  return serializeEmailSearchQuery(parseEmailSearchQuery(query));
}

/** ImapFlow has OR/NOT but no explicit AND array. De Morgan preserves repeated fields. */
export function andImapEmailSearch(left: SearchObject, right: SearchObject): SearchObject {
  return { not: { or: [{ not: left }, { not: right }] } };
}

export function compileImapEmailSearch(expression: EmailSearchExpression | null): SearchObject {
  if (!expression) return { all: true };
  if (expression.type === 'term') {
    if (expression.field) return { [expression.field]: expression.value };
    return { or: EMAIL_SEARCH_FIELDS.map((field) => ({ [field]: expression.value })) };
  }
  const left = compileImapEmailSearch(expression.left);
  const right = compileImapEmailSearch(expression.right);
  return expression.type === 'or' ? { or: [left, right] } : andImapEmailSearch(left, right);
}

/** Gmail has no body-only operator; these are candidates, verified against the full MIME body. */
export function compileGmailEmailSearch(expression: EmailSearchExpression | null): string {
  if (!expression) return '';
  if (expression.type === 'term') {
    return `${expression.field && expression.field !== 'body' ? `${expression.field}:` : ''}${JSON.stringify(expression.value)}`;
  }
  return `(${compileGmailEmailSearch(expression.left)} ${expression.type === 'or' ? 'OR' : 'AND'} ${compileGmailEmailSearch(expression.right)})`;
}

export function compileMicrosoftEmailSearch(expression: EmailSearchExpression | null): string {
  if (!expression) return '';
  if (expression.type === 'term') {
    const term = (field: EmailSearchField) => `${field}:${JSON.stringify(expression.value)}`;
    return expression.field ? term(expression.field) : `(${EMAIL_SEARCH_FIELDS.map(term).join(' OR ')})`;
  }
  return `(${compileMicrosoftEmailSearch(expression.left)} ${expression.type.toUpperCase()} ${compileMicrosoftEmailSearch(expression.right)})`;
}

/** Match only complete decoded fields, never list snippets. Provider tokenization can still limit candidates. */
export function matchesEmailSearch(expression: EmailSearchExpression | null, fields: Partial<Record<EmailSearchField, string | string[]>>): boolean {
  if (!expression) return true;
  if (expression.type === 'and') return matchesEmailSearch(expression.left, fields) && matchesEmailSearch(expression.right, fields);
  if (expression.type === 'or') return matchesEmailSearch(expression.left, fields) || matchesEmailSearch(expression.right, fields);
  const needle = expression.value.normalize('NFC').toLocaleLowerCase();
  return (expression.field ? [expression.field] : EMAIL_SEARCH_FIELDS).some((field) => {
    const raw = fields[field];
    const values = Array.isArray(raw) ? raw : [raw || ''];
    return values.some((value) => value.normalize('NFC').toLocaleLowerCase().includes(needle));
  });
}

/** A plain-text excerpt around a positive body term, safe for text rendering in the list. */
export function emailSearchBodySnippet(expression: EmailSearchExpression | null, body: string, fallback: string, length = 200): string {
  if (!expression || !body) return fallback;
  const values: string[] = [];
  function collect(node: EmailSearchExpression): void {
    if (node.type === 'term') {
      if (!node.field || node.field === 'body') values.push(node.value);
    } else { collect(node.left); collect(node.right); }
  }
  collect(expression);
  const text = body.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const normalized = text.toLocaleLowerCase();
  const positions = values.map((value) => normalized.indexOf(value.toLocaleLowerCase())).filter((index) => index >= 0);
  if (!positions.length) return fallback;
  const start = Math.max(0, Math.min(...positions) - 50);
  return `${start ? '…' : ''}${text.slice(start, start + length)}${start + length < text.length ? '…' : ''}`;
}
