import type { Usage } from '@mariozechner/pi-ai';

function formatCurrency(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function hasRenderableUsage(usage: Usage | undefined | null): usage is Usage {
  if (!usage) {
    return false;
  }

  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.totalTokens > 0 ||
    usage.cost.input > 0 ||
    usage.cost.output > 0 ||
    usage.cost.cacheRead > 0 ||
    usage.cost.cacheWrite > 0 ||
    usage.cost.total > 0
  );
}

export function formatUsageCompact(usage: Usage | undefined | null): string {
  if (!hasRenderableUsage(usage)) {
    return '';
  }

  return `${usage.totalTokens} tok · ${formatCurrency(usage.cost.total)}`;
}

export function formatUsageBreakdown(usage: Usage | undefined | null): string {
  if (!hasRenderableUsage(usage)) {
    return '';
  }

  return `${usage.input} in / ${usage.output} out`;
}

export function formatUsageTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

export function formatUsageCost(value: number): string {
  return formatCurrency(value);
}
