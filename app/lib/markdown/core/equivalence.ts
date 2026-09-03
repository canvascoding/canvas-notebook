import { proseEntities } from './prose-entities';
import { createCanvasMarkedInstance } from './canvas-marked';

export type MarkdownSafeNormalization =
  | 'escaped_email_address'
  | 'ordered_list_spacing'
  | 'list_formatting'
  | 'hard_break_marker'
  | 'html_entity_escaping'
  | 'table_formatting';

type Token = {
  type: string;
  raw?: string;
  text?: string;
  tokens?: Token[];
  [key: string]: unknown;
};

function tokenShape(tokens: Token[], inline = false, decode = true): unknown[] {
  const result: unknown[] = [];
  for (const token of tokens) {
    const children = () => tokenShape(token.tokens ?? [], true, decode);
    let value: unknown;
    switch (token.type) {
      case 'space': continue;
      case 'escape': value = !decode && token.raw?.startsWith('&') ? token.raw : token.text ?? ''; break;
      case 'text':
        value = !inline && token.tokens
          ? { type: 'paragraph', content: children() }
          : decode ? proseEntities(token.text ?? '') : token.text ?? '';
        break;
      case 'paragraph': value = { type: 'paragraph', content: children() }; break;
      case 'heading': value = { type: 'heading', depth: token.depth, content: children() }; break;
      case 'strong': case 'em': case 'del': value = { type: token.type, content: children() }; break;
      case 'link': value = { type: 'link', href: token.href, title: token.title ?? null, content: children() }; break;
      case 'image': value = { type: 'image', href: token.href, title: token.title ?? null, text: token.text }; break;
      case 'codespan': value = { type: 'code', text: token.text }; break;
      case 'code': value = { type: 'codeBlock', lang: token.lang ?? '', text: token.text }; break;
      case 'br': case 'hr': value = { type: token.type }; break;
      case 'blockquote': value = { type: 'blockquote', content: tokenShape(token.tokens ?? [], false, decode) }; break;
      case 'list': value = {
        type: 'list', ordered: token.ordered, start: token.start,
        items: (token.items as Token[]).map((item) => ({
          task: item.task ?? false, checked: item.checked ?? null,
          content: tokenShape(item.tokens ?? [], false, decode),
        })),
      }; break;
      case 'table': {
        const cells = (row: Token[]) => row.map((cell) => ({
          align: cell.align ?? null, content: tokenShape(cell.tokens ?? [], true, decode),
        }));
        value = { type: 'table', header: cells(token.header as Token[]), rows: (token.rows as Token[][]).map(cells) };
        break;
      }
      // Unknown constructs and raw HTML require their original source.
      default: value = { type: token.type, raw: token.raw };
    }
    if (typeof value === 'string' && typeof result.at(-1) === 'string') {
      result[result.length - 1] = String(result.at(-1)) + value;
    } else {
      result.push(value);
    }
  }
  return result;
}

function formattingFeatures(tokens: Token[], result: Record<string, string[]> = {}): Record<string, string[]> {
  for (const [index, token] of tokens.entries()) {
    const kind = token.type === 'table' ? 'table_formatting'
      : token.type === 'list' ? token.ordered ? 'ordered_list_spacing' : 'list_formatting'
        : token.type === 'br' ? 'hard_break_marker'
          : token.type === 'escape' && token.raw === '\\@' ? 'escaped_email_address' : null;
    if (kind) (result[kind] ??= []).push(token.type === 'table'
      ? [tokens[index - 1]?.type === 'space' ? tokens[index - 1].raw : '', token.raw,
        tokens[index + 1]?.type === 'space' ? tokens[index + 1].raw : ''].join('\u0000')
      : token.raw ?? '');
    if (token.tokens) formattingFeatures(token.tokens, result);
    if (token.type === 'list') formattingFeatures(token.items as Token[], result);
    if (token.type === 'table') {
      formattingFeatures(token.header as Token[], result);
      for (const row of token.rows as Token[][]) formattingFeatures(row, result);
    }
  }
  return result;
}

/** Independent syntax check: do not prove equivalence by running the same lossy importer twice. */
export function equivalentMarkdownNormalization(before: string, after: string): MarkdownSafeNormalization[] | null {
  const parser = createCanvasMarkedInstance();
  const left = parser.lexer(before) as Token[];
  const right = parser.lexer(after) as Token[];
  if (JSON.stringify(tokenShape(left)) !== JSON.stringify(tokenShape(right))) return null;
  const leftFeatures = formattingFeatures(left);
  const rightFeatures = formattingFeatures(right);
  const kinds: MarkdownSafeNormalization[] = [
    'escaped_email_address', 'ordered_list_spacing', 'list_formatting', 'hard_break_marker',
    'html_entity_escaping', 'table_formatting',
  ];
  const changes = kinds.filter((kind) => kind === 'html_entity_escaping'
    ? JSON.stringify(tokenShape(left, false, false)) !== JSON.stringify(tokenShape(right, false, false))
    : JSON.stringify(leftFeatures[kind] ?? []) !== JSON.stringify(rightFeatures[kind] ?? []));
  return changes.length ? changes : null;
}

type RichNode = { type?: string; attrs?: Record<string, unknown>; content?: RichNode[]; marks?: unknown[]; text?: string };

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalValue(entry)]));
}

function richNodeShape(node: RichNode): unknown {
  const { id: _id, ...attrs } = node.attrs ?? {};
  let content = node.content ?? [];
  // The editor adds a final cursor paragraph; it is not authored Markdown content.
  if (node.type === 'doc' && content.at(-1)?.type === 'paragraph' && !content.at(-1)?.content?.length) {
    content = content.slice(0, -1);
  }
  return {
    type: node.type, attrs: canonicalValue(attrs), text: node.text,
    marks: (node.marks ?? []).map(canonicalValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    content: content.map(richNodeShape),
  };
}

export function equivalentRichDocument(before: unknown, after: unknown): boolean {
  return JSON.stringify(richNodeShape(before as RichNode)) === JSON.stringify(richNodeShape(after as RichNode));
}
