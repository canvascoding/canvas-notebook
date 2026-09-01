import path from 'node:path';

import { parseDocument } from 'yaml';

import { getRunawaySlashContentMessage } from '@/app/lib/editor/text-editor-guards';

export type TextFileValidationCheck = {
  name: string;
  ok: boolean;
  message: string;
};

export type TextFileValidationResult = {
  ok: boolean;
  checks: TextFileValidationCheck[];
};

function splitMarkdownTableRow(line: string): string[] | null {
  if (!line.includes('|')) return null;

  let normalized = line.trim();
  if (normalized.startsWith('|')) normalized = normalized.slice(1);
  if (normalized.endsWith('|') && !normalized.endsWith('\\|')) normalized = normalized.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let escaped = false;

  for (const char of normalized) {
    if (char === '|' && !escaped) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }

  cells.push(current.trim());
  return cells.length > 1 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return Boolean(cells && cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim())));
}

function validateMarkdownTables(content: string): TextFileValidationCheck {
  const lines = content.split('\n');
  const errors: string[] = [];
  let tableCount = 0;

  for (let index = 1; index < lines.length; index += 1) {
    if (!isMarkdownTableSeparator(lines[index])) continue;

    const headerCells = splitMarkdownTableRow(lines[index - 1]);
    const separatorCells = splitMarkdownTableRow(lines[index]);
    if (!headerCells || !separatorCells) continue;

    tableCount += 1;
    const expectedColumns = headerCells.length;
    if (separatorCells.length !== expectedColumns) {
      errors.push(`line ${index + 1}: separator has ${separatorCells.length} column(s), expected ${expectedColumns}`);
    }

    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const row = lines[rowIndex];
      if (!row.trim() || !row.includes('|') || isMarkdownTableSeparator(row)) break;

      const rowCells = splitMarkdownTableRow(row);
      if (!rowCells) break;
      if (rowCells.length !== expectedColumns) {
        errors.push(`line ${rowIndex + 1}: row has ${rowCells.length} column(s), expected ${expectedColumns}`);
      }
    }
  }

  return {
    name: 'markdown-tables',
    ok: errors.length === 0,
    message: errors.length === 0
      ? `Markdown table structure OK (${tableCount} table${tableCount === 1 ? '' : 's'} checked).`
      : errors.join('; '),
  };
}

function validateRunawaySlashContent(content: string): TextFileValidationCheck {
  const message = getRunawaySlashContentMessage(content);
  return {
    name: 'runaway-slashes',
    ok: message === null,
    message: message === null
      ? 'No runaway slash/backslash sequences detected.'
      : `${message}. This usually indicates a stuck key, model output loop, or accidental repeated slash insertion.`,
  };
}

export function validateTextFileContent(filePath: string, content: string): TextFileValidationResult {
  const extension = path.extname(filePath).toLowerCase();
  const checks: TextFileValidationCheck[] = [];

  if (['.md', '.mdx', '.markdown'].includes(extension)) {
    checks.push(validateRunawaySlashContent(content));
    checks.push(validateMarkdownTables(content));
  }

  if (extension === '.json') {
    try {
      JSON.parse(content);
      checks.push({ name: 'json-parse', ok: true, message: 'JSON syntax OK.' });
    } catch (error) {
      checks.push({
        name: 'json-parse',
        ok: false,
        message: error instanceof Error ? error.message : 'Invalid JSON syntax.',
      });
    }
  }

  if (['.yaml', '.yml'].includes(extension)) {
    const document = parseDocument(content, { prettyErrors: false });
    checks.push({
      name: 'yaml-parse',
      ok: document.errors.length === 0,
      message: document.errors.length === 0
        ? 'YAML syntax OK.'
        : document.errors.map((error) => error.message).join('; '),
    });
  }

  if (checks.length === 0) {
    checks.push({ name: 'read-after-write', ok: true, message: 'No file-type-specific validator configured; read-after-write will verify exact bytes.' });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}
