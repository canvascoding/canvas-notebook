'use client';

import { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { useStudioGeneration } from '../../hooks/useStudioGeneration';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { OutputGrid } from './OutputGrid';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const STARTING_POINTS = [
  {
    title: 'Hero product launch',
    description: 'Clean catalog-style product visual with sharp lighting and premium detail.',
  },
  {
    title: 'Lifestyle campaign moment',
    description: 'Warm editorial scene with people, context, and brand atmosphere.',
  },
  {
    title: 'Beauty close-up',
    description: 'Skincare or cosmetics concept with luminous surfaces and elegant gradients.',
  },
  {
    title: 'Short video concept',
    description: 'Start from a still or text prompt and evolve it into a cinematic clip.',
  },
] as const;

function EmptyState() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <div className="max-w-2xl space-y-3">
          <Badge variant="secondary" className="w-fit rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em]">
            Starting Points
          </Badge>
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Start with a visual direction, then build from products, personas, and presets.
          </h2>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
            Your outputs will appear here in reverse chronological order. Use the prompt bar below to create images
            or videos, then refine the result with studio presets and references.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STARTING_POINTS.map((item) => (
            <div
              key={item.title}
              className="group rounded-3xl border border-border/70 bg-card/80 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
            >
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
              </div>
              <h3 className="mb-2 text-base font-semibold text-foreground">{item.title}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CreateView() {
  const generationHook = useStudioGeneration();
  const presetsHook = useStudioPresets();
  const { fetchGenerations, generations } = generationHook;
  const { fetchPresets, presets } = presetsHook;

  useEffect(() => {
    void fetchGenerations();
    void fetchPresets();
  }, [fetchGenerations, fetchPresets]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.12),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.12),_transparent_32%)]">
            <OutputGrid generations={generations} emptyState={<EmptyState />} />
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-border/80 bg-background/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
          <div className="rounded-[28px] border border-border/70 bg-card/90 p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              Prompt Bar
            </div>
            <div className="min-h-24 rounded-3xl border border-dashed border-border/70 bg-background/70 px-4 py-4 text-sm leading-6 text-muted-foreground">
              Prompt input, @-references, and inline chips will live here in the next step.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-[24px] border border-border/70 bg-card/90 px-4 py-3 shadow-sm">
            <Badge variant="secondary" className="rounded-full px-3 py-1">Image</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Preset ready: {presets.length}</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Recent generations: {generations.length}</Badge>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled>
                More Options
              </Button>
              <Button type="button" size="sm" disabled>
                Generate
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
