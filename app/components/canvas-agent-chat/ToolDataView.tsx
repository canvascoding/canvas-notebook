'use client';

import React, { useMemo } from 'react';
import { useLocale } from 'next-intl';

/*
 * ToolDataView – renders a JSON value as a readable key/value list.
 * Used in the compact (subtle) tool-call popover so users don't have
 * to read raw JSON.
 */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.test(value);
}

function fmtDate(value: string, locale: string): string {
  try {
    const d = new Date(value);
    return new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return value;
  }
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || /^[a-zA-Z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function truncateId(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

/* ------------------------------------------------------------------ */
/*  Scalar value renderer                                              */
/* ------------------------------------------------------------------ */

type StringRenderer = (value: string) => React.ReactNode | null;

function Scalar({
  value,
  expandStrings = false,
  renderRichText,
}: {
  value: unknown;
  expandStrings?: boolean;
  renderRichText?: StringRenderer;
}) {
  const locale = useLocale();

  if (value === null || value === undefined) {
    return <span className="italic text-muted-foreground text-[11px]">—</span>;
  }

  if (typeof value === 'boolean') {
    return (
      <span className={`text-[11px] ${value ? 'text-emerald-600 font-medium' : 'text-red-500 font-medium'}`}>
        {value ? 'true' : 'false'}
      </span>
    );
  }

  if (typeof value === 'number') {
    return <span className="tabular-nums text-[11px]">{value}</span>;
  }

  if (typeof value === 'string') {
    if (isISODate(value)) {
      return (
        <span className="text-[11px] text-foreground" title={value}>
          {fmtDate(value, locale)}
        </span>
      );
    }

    if (looksLikeId(value)) {
      return (
        <span className="font-mono text-[10px] text-foreground/80" title={value}>
          {truncateId(value)}
        </span>
      );
    }

    const richText = renderRichText?.(value);
    if (richText) {
      return <div className="min-w-0">{richText}</div>;
    }

    if (value.length > 120 && !expandStrings) {
      return (
        <span className="text-[11px] text-foreground/80" title={value}>
          {value.slice(0, 120)}…
        </span>
      );
    }

    return (
      <span className={expandStrings ? 'whitespace-pre-wrap break-words text-[11px] text-foreground/80' : 'text-[11px] text-foreground/80'}>
        {value}
      </span>
    );
  }

  // Fallback for symbols / functions / anything else
  return <span className="text-muted-foreground text-[11px]">{String(value)}</span>;
}

/* ------------------------------------------------------------------ */
/*  Recursive tree                                                     */
/* ------------------------------------------------------------------ */

interface NodeProps {
  data: unknown;
  level?: number;
  isLast?: boolean;
}

export function ToolDataView({
  data,
  level = 0,
  expandStrings = false,
  renderRichText,
}: Omit<NodeProps, 'isLast'> & {
  expandStrings?: boolean;
  renderRichText?: StringRenderer;
}) {
  /* --- primitive ----------------------------------------------------- */
  if (data === null || data === undefined || typeof data !== 'object') {
    return <Scalar value={data} expandStrings={expandStrings} renderRichText={renderRichText} />;
  }

  /* --- array --------------------------------------------------------- */
  if (Array.isArray(data)) {
  if (data.length === 0) {
    return <span className="italic text-muted-foreground text-[11px]">[]</span>;
  }

    return (
      <div className="space-y-0.5">
        {data.map((item, i) => {
          const isPrimitive = item === null || item === undefined || typeof item !== 'object';
          return (
            <div key={i} className="flex items-start gap-1.5">
              <span className="mt-0.5 shrink-0 select-none text-[10px] font-medium text-muted-foreground/50">
                {i + 1}.
              </span>
              <div className="min-w-0 flex-1">
                {isPrimitive ? (
                  <Scalar value={item} expandStrings={expandStrings} renderRichText={renderRichText} />
                ) : (
                  <ToolDataView
                    data={item}
                    level={level + 1}
                    expandStrings={expandStrings}
                    renderRichText={renderRichText}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  /* --- object -------------------------------------------------------- */
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <span className="italic text-muted-foreground text-[11px]">{'{}'}</span>;
  }

  const padLeft = level > 0 ? 'pl-3 border-l border-border/40 ml-1' : '';

  return (
    <div className={`space-y-1 ${padLeft}`}>
      {entries.map(([key, value]) => {
        const isNested = value !== null && typeof value === 'object';

        return (
          <div key={key} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
            <div className="shrink-0 sm:mt-0.5 sm:max-w-[45%]">
              <span className="text-[11px] font-medium text-muted-foreground/80 break-words">
                {key}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              {isNested ? (
                <ToolDataView
                  data={value}
                  level={level + 1}
                  expandStrings={expandStrings}
                  renderRichText={renderRichText}
                />
              ) : (
                <Scalar value={value} expandStrings={expandStrings} renderRichText={renderRichText} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Wrapper that tries to parse a JSON string                           */
/* ------------------------------------------------------------------ */

export function ToolDataViewFromJson({ json }: { json: string }) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }, [json]);

  if (parsed === null) {
    // fallback to plain monospace block when JSON is invalid
    return (
      <pre className="overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85">
        {json}
      </pre>
    );
  }

  return <ToolDataView data={parsed} />;
}
