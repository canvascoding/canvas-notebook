import { JSDOM } from 'jsdom';

const WIDE_TABLE_MIN_COLUMNS = 6;
const WIDE_TABLE_ESTIMATED_WIDTH_CHARS = 96;
const WIDE_TABLE_SAMPLED_ROWS = 6;
const WIDE_TABLE_MIN_CELL_CHARS = 8;
const WIDE_TABLE_MAX_CELL_CHARS = 32;

function getTableColumnCount(row: HTMLTableRowElement): number {
  return Array.from(row.cells).reduce((count, cell) => {
    const colspan = Number.parseInt(cell.getAttribute('colspan') || '1', 10);
    return count + (Number.isFinite(colspan) && colspan > 0 ? colspan : 1);
  }, 0);
}

function estimateTableWidthScore(table: HTMLTableElement): number {
  const rows = Array.from(table.rows).slice(0, WIDE_TABLE_SAMPLED_ROWS);
  const columnCount = rows.reduce((max, row) => Math.max(max, getTableColumnCount(row)), 0);
  const columnScores = Array.from({ length: columnCount }, () => 0);

  for (const row of rows) {
    let columnIndex = 0;
    for (const cell of Array.from(row.cells)) {
      const colspan = Number.parseInt(cell.getAttribute('colspan') || '1', 10);
      const safeColspan = Number.isFinite(colspan) && colspan > 0 ? colspan : 1;
      const textLength = (cell.textContent || '').replace(/\s+/g, ' ').trim().length;
      const boundedLength = Math.max(
        WIDE_TABLE_MIN_CELL_CHARS,
        Math.min(WIDE_TABLE_MAX_CELL_CHARS, Math.ceil(textLength / safeColspan)),
      );

      for (let offset = 0; offset < safeColspan; offset += 1) {
        const targetIndex = columnIndex + offset;
        columnScores[targetIndex] = Math.max(columnScores[targetIndex] || 0, boundedLength);
      }

      columnIndex += safeColspan;
    }
  }

  return columnScores.reduce((total, score) => total + score, 0);
}

function isWideTable(table: HTMLTableElement): boolean {
  const rows = Array.from(table.rows);
  const columnCount = rows.reduce((max, row) => Math.max(max, getTableColumnCount(row)), 0);

  return columnCount >= WIDE_TABLE_MIN_COLUMNS ||
    estimateTableWidthScore(table) >= WIDE_TABLE_ESTIMATED_WIDTH_CHARS;
}

export function formatWideTablesForPagedExport(htmlContent: string): string {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${htmlContent}</body></html>`);
  const { document } = dom.window;

  for (const table of Array.from(document.querySelectorAll('table'))) {
    if (!(table instanceof dom.window.HTMLTableElement)) continue;
    if (table.parentElement?.closest('table')) continue;
    if (table.closest('.markdown-wide-table-page')) continue;
    if (!isWideTable(table)) continue;

    const section = document.createElement('section');
    section.className = 'markdown-wide-table-page';
    section.setAttribute('data-wide-table-page', 'true');

    const tableFrame = document.createElement('div');
    tableFrame.className = 'markdown-wide-table-frame';

    table.classList.add('markdown-wide-table');
    table.replaceWith(section);
    tableFrame.appendChild(table);
    section.appendChild(tableFrame);
  }

  return document.body.innerHTML;
}
