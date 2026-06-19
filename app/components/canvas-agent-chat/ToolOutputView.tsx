'use client';

import React from 'react';
import { CheckCircle2, FileText, Info, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { MarkdownMessage } from '@/app/components/canvas-agent-chat/ChatMarkdownMessage';
import { ToolDataView } from '@/app/components/canvas-agent-chat/ToolDataView';
import { cn } from '@/lib/utils';

type FileChangeAction = 'Created' | 'Updated' | 'Checked';

type FileChangeOutput = {
  heading: string | null;
  action: FileChangeAction;
  path: string;
  snapshot: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  size: string | null;
  validation: 'passed' | 'failed' | string | null;
  validationChecks: string[];
  diff: string;
  markdownPreview: string | null;
};

type ToolOutputViewProps = {
  content: string;
  onMediaClick?: (mediaUrl: string) => void;
};

const FILE_ACTION_RE = /^(Created|Updated|Checked) file:\s*(.+)$/m;
const DIFF_FENCE_RE = /(?:^|\n)Diff:\s*\n```diff\n([\s\S]*?)\n```/;
const MARKDOWN_FILE_RE = /\.(?:md|mdx|markdown)$/i;
const MAX_MARKDOWN_PREVIEW_CHARS = 12000;

function getLineValue(source: string, label: string): string | null {
  const match = source.match(new RegExp(`^${label}:\\s*(.*)$`, 'm'));
  return match?.[1]?.trim() || null;
}

function extractMarkdownPreview(path: string, beforeSha256: string | null, diff: string): string | null {
  if (!MARKDOWN_FILE_RE.test(path)) {
    return null;
  }

  const addedLines = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));

  const preview = addedLines.join('\n').trim();
  if (!preview) {
    return null;
  }

  const isNewFile = beforeSha256 === 'new file';
  const hasMarkdownStructure = /^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|>\s|\|.+\|)/m.test(preview);
  if (!isNewFile && !hasMarkdownStructure) {
    return null;
  }

  return preview.length > MAX_MARKDOWN_PREVIEW_CHARS
    ? `${preview.slice(0, MAX_MARKDOWN_PREVIEW_CHARS).trimEnd()}\n\n...`
    : preview;
}

function splitFileChangeSections(content: string): Array<{ heading: string | null; body: string }> {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  const headings = Array.from(normalized.matchAll(/^# File \d+\s*$/gm));
  if (headings.length === 0) {
    return [{ heading: null, body: normalized }];
  }

  return headings.map((match, index) => {
    const next = headings[index + 1];
    const start = (match.index ?? 0) + match[0].length;
    const end = next?.index ?? normalized.length;
    return {
      heading: match[0].replace(/^#\s*/, '').trim(),
      body: normalized.slice(start, end).trim(),
    };
  });
}

function parseFileChangeSection(section: { heading: string | null; body: string }): FileChangeOutput | null {
  const actionMatch = section.body.match(FILE_ACTION_RE);
  const diffMatch = section.body.match(DIFF_FENCE_RE);
  if (!actionMatch || !diffMatch) {
    return null;
  }

  const metadata = section.body.slice(0, diffMatch.index ?? 0);
  const action = actionMatch[1] as FileChangeAction;
  const path = actionMatch[2].trim();
  const beforeSha256 = getLineValue(metadata, 'Before SHA-256');
  const diff = diffMatch[1].trimEnd();

  return {
    heading: section.heading,
    action,
    path,
    snapshot: getLineValue(metadata, 'Snapshot'),
    beforeSha256,
    afterSha256: getLineValue(metadata, 'After SHA-256'),
    size: getLineValue(metadata, 'Size'),
    validation: getLineValue(metadata, 'Validation'),
    validationChecks: metadata
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- OK ') || line.startsWith('- FAILED ')),
    diff,
    markdownPreview: extractMarkdownPreview(path, beforeSha256, diff),
  };
}

function parseFileChangeOutput(content: string): FileChangeOutput[] | null {
  const sections = splitFileChangeSections(content);
  const parsed = sections.map(parseFileChangeSection);
  if (parsed.some((section) => section === null)) {
    return null;
  }
  return parsed as FileChangeOutput[];
}

function parseJsonOutput(content: string): unknown | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getActionLabel(action: FileChangeAction, t: ReturnType<typeof useTranslations<'chat'>>) {
  if (action === 'Created') return t('toolFileCreated');
  if (action === 'Updated') return t('toolFileUpdated');
  return t('toolFileChecked');
}

function StatusChip({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'success' | 'danger' | 'neutral';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        tone === 'success' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        tone === 'danger' && 'border-destructive/30 bg-destructive/10 text-destructive',
        tone === 'neutral' && 'border-border/70 bg-muted/40 text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function DiffLine({ line }: { line: string }) {
  const isAdded = line.startsWith('+') && !line.startsWith('+++');
  const isRemoved = line.startsWith('-') && !line.startsWith('---');
  const isHunk = line.startsWith('@@');
  const isHeader = line.startsWith('diff ') || line.startsWith('---') || line.startsWith('+++');

  return (
    <div
      className={cn(
        'grid min-w-max grid-cols-[2rem_1fr] gap-2 px-2 py-0.5',
        isAdded && 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
        isRemoved && 'bg-rose-500/10 text-rose-800 dark:text-rose-200',
        isHunk && 'bg-primary/10 text-primary',
        isHeader && 'bg-muted/50 text-muted-foreground',
      )}
    >
      <span className="select-none text-right text-muted-foreground/60">
        {isAdded ? '+' : isRemoved ? '-' : ' '}
      </span>
      <span>{line || ' '}</span>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.length > 0 ? diff.split('\n') : [''];
  return (
    <div className="overflow-x-auto rounded-md border border-border/70 bg-background/80 py-2 font-mono text-xs leading-5">
      {lines.map((line, index) => (
        <DiffLine key={`${index}-${line}`} line={line} />
      ))}
    </div>
  );
}

function FileChangeCard({
  output,
  onMediaClick,
}: {
  output: FileChangeOutput;
  onMediaClick?: (mediaUrl: string) => void;
}) {
  const t = useTranslations('chat');
  const validationPassed = output.validation === 'passed';
  const validationFailed = output.validation === 'failed';

  return (
    <div data-testid="tool-file-change" className="space-y-3 rounded-md border border-border/70 bg-background p-3">
      <div className="flex min-w-0 items-start gap-2">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{getActionLabel(output.action, t)}</span>
            {output.heading ? <StatusChip>{output.heading}</StatusChip> : null}
          </div>
          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{output.path}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {validationPassed ? (
          <StatusChip tone="success">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            {t('toolFileValidationPassed')}
          </StatusChip>
        ) : null}
        {validationFailed ? (
          <StatusChip tone="danger">
            <XCircle className="mr-1 h-3 w-3" />
            {t('toolFileValidationFailed')}
          </StatusChip>
        ) : null}
        {output.snapshot && output.snapshot !== 'none' ? (
          <StatusChip>{t('toolFileSnapshot')}</StatusChip>
        ) : null}
        {output.size ? <StatusChip>{output.size}</StatusChip> : null}
      </div>

      {output.markdownPreview ? (
        <div data-testid="tool-markdown-preview" className="rounded-md border border-border/60 bg-muted/20 p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('toolFileMarkdownPreview')}
          </div>
          <MarkdownMessage content={output.markdownPreview} variant="tool" onMediaClick={onMediaClick} />
        </div>
      ) : null}

      <div data-testid="tool-file-diff" className="space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {t('toolFileChanges')}
        </div>
        <DiffView diff={output.diff} />
      </div>

      <details className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          <Info className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
          {t('toolFileDetails')}
        </summary>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {output.snapshot ? <div>Snapshot: <span className="font-mono">{output.snapshot}</span></div> : null}
          {output.beforeSha256 ? <div>Before SHA-256: <span className="font-mono">{output.beforeSha256}</span></div> : null}
          {output.afterSha256 ? <div>After SHA-256: <span className="font-mono">{output.afterSha256}</span></div> : null}
          {output.validationChecks.map((check) => (
            <div key={check}>{check}</div>
          ))}
        </div>
      </details>
    </div>
  );
}

function FileChangeOutputView({
  outputs,
  onMediaClick,
}: {
  outputs: FileChangeOutput[];
  onMediaClick?: (mediaUrl: string) => void;
}) {
  return (
    <div className="space-y-3">
      {outputs.map((output, index) => (
        <FileChangeCard
          key={`${output.path}-${output.heading || index}`}
          output={output}
          onMediaClick={onMediaClick}
        />
      ))}
    </div>
  );
}

export function ToolOutputView({ content, onMediaClick }: ToolOutputViewProps) {
  const parsedJson = parseJsonOutput(content);
  if (parsedJson !== null) {
    return <ToolDataView data={parsedJson} />;
  }

  const fileChanges = parseFileChangeOutput(content);
  if (fileChanges) {
    return <FileChangeOutputView outputs={fileChanges} onMediaClick={onMediaClick} />;
  }

  return <MarkdownMessage content={content} variant="tool" onMediaClick={onMediaClick} />;
}
