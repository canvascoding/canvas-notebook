'use client';

import * as React from 'react';
import { ResponsiveContainer } from 'recharts';

import { cn } from '@/lib/utils';

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
  }
>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorDeclarations = Object.entries(config)
    .filter(([, value]) => value.color)
    .map(([key, value]) => `--color-${key}: ${value.color};`)
    .join('');

  return colorDeclarations ? <style>{`[data-chart="${id}"]{${colorDeclarations}}`}</style> : null;
}

function ChartContainer({
  id,
  className,
  config,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
}) {
  const generatedId = React.useId();
  const chartId = `chart-${id ?? generatedId.replace(/:/g, '')}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          'flex aspect-video min-h-[13rem] w-full justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/70 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-default-tooltip]:border-border',
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a ChartContainer');
  }

  return context;
}

export { ChartContainer, useChart };
