'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { ImagePlus, Layers, LayoutGrid, Play, Sparkles, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useStudioGeneration } from '../hooks/useStudioGeneration';
import type { StudioGeneration, StudioGenerationOutput } from '../types/generation';

interface StartingPoint {
  id: string;
  title: string;
  description: string;
  category: string;
  prompt: string;
  presetId: string | null;
}

const CATEGORY_ICONS: Record<string, typeof Sparkles> = {
  Fashion: Sparkles,
  Product: ImagePlus,
  Lifestyle: Play,
  Beauty: Sparkles,
  Food: ImagePlus,
  Architecture: LayoutGrid,
  Video: Play,
  Abstract: Wand2,
};

function RecentGenerationThumbnail({
  generation,
  onClick,
}: {
  generation: StudioGeneration;
  onClick: () => void;
}) {
  const completedOutputs = generation.outputs.filter((o: StudioGenerationOutput) => o.mediaUrl);
  if (completedOutputs.length === 0) return null;

  const output = completedOutputs[0];

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded-2xl border border-border/60 bg-card/70 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
    >
      {output.type === 'video' ? (
        <video
          src={output.mediaUrl!}
          muted
          playsInline
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={output.mediaUrl!}
          alt={generation.prompt || 'Studio output'}
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      {generation.prompt && (
        <p className="absolute bottom-2 left-2 right-2 truncate text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
          {generation.prompt}
        </p>
      )}
    </button>
  );
}

export function StudioDashboard() {
  const t = useTranslations('studio');
  const router = useRouter();
  const { generations, fetchGenerations } = useStudioGeneration();
  const [startingPoints, setStartingPoints] = useState<StartingPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetchGenerations();
  }, [fetchGenerations]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/studio/starting-points');
        const data = await res.json();
        if (!cancelled && data.success) {
          setStartingPoints(data.startingPoints);
        }
      } catch {
        // Keep empty starting points on error
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const recentCompleted = generations
    .filter((g) => g.status === 'completed' && g.outputs.some((o) => o.mediaUrl))
    .slice(0, 8);

  const handleRecreate = (sp: StartingPoint) => {
    const params = new URLSearchParams({ prompt: sp.prompt });
    if (sp.presetId) params.set('preset', sp.presetId);
    router.push(`/studio/create?${params.toString()}`);
  };

  const handleRecentClick = () => {
    router.push('/studio/create');
  };

  const quickActions = [
    {
      icon: ImagePlus,
      title: t('dashboard.quickActions.newProduct'),
      description: t('dashboard.quickActions.newProductDesc'),
      path: '/studio/models/new',
    },
    {
      icon: Play,
      title: t('dashboard.quickActions.generateImages'),
      description: t('dashboard.quickActions.generateImagesDesc'),
      path: '/studio/create',
    },
    {
      icon: Layers,
      title: t('dashboard.quickActions.startBulk'),
      description: t('dashboard.quickActions.startBulkDesc'),
      path: '/studio/bulk',
    },
    {
      icon: LayoutGrid,
      title: t('dashboard.quickActions.viewPresets'),
      description: t('dashboard.quickActions.viewPresetsDesc'),
      path: '/studio/presets',
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="max-w-2xl space-y-3">
        <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em]">
          {t('dashboard.startingPointsBadge')}
        </Badge>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('dashboard.headline')}
        </h2>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
          {t('dashboard.subheadline')}
        </p>
      </div>

      <section>
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('dashboard.quickActionsTitle')}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {quickActions.map((action) => (
            <button
              key={action.path}
              type="button"
              onClick={() => router.push(action.path)}
              className="group rounded-3xl border border-border/70 bg-card/80 p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
            >
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <action.icon className="h-5 w-5" />
              </div>
              <h4 className="mb-1 text-base font-semibold text-foreground">{action.title}</h4>
              <p className="text-sm leading-6 text-muted-foreground">{action.description}</p>
            </button>
          ))}
        </div>
      </section>

      {!loading && startingPoints.length > 0 && (
        <section>
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {t('dashboard.startingPointsTitle')}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {startingPoints.map((sp) => {
              const Icon = CATEGORY_ICONS[sp.category] || Sparkles;
              return (
                <Card
                  key={sp.id}
                  className="group rounded-2xl border-border/70 bg-card/80 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-sm font-semibold">{sp.title}</CardTitle>
                        <Badge variant="outline" className="mt-1 rounded-full px-2 py-0 text-[10px]">
                          {sp.category}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <CardDescription className="mb-3 line-clamp-2 text-xs leading-5">
                      {sp.description}
                    </CardDescription>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full rounded-full text-xs"
                      onClick={() => handleRecreate(sp)}
                    >
                      <Wand2 className="mr-1.5 h-3 w-3" />
                      {t('dashboard.recreate')}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {recentCompleted.length > 0 && (
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('dashboard.recentGenerationsTitle')}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full text-xs text-muted-foreground"
              onClick={() => router.push('/studio/create')}
            >
              {t('dashboard.viewAll')}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
            {recentCompleted.map((generation) => (
              <RecentGenerationThumbnail
                key={generation.id}
                generation={generation}
                onClick={handleRecentClick}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}