'use client';

import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useStudioGeneration } from '../../hooks/useStudioGeneration';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import type { StudioGeneration, StudioGenerationMode, StudioGenerationOutput } from '../../types/generation';
import type { StudioPreset } from '../../types/presets';
import { OutputDetailView } from './OutputDetailView';
import { OutputGrid } from './OutputGrid';
import { Badge } from '@/components/ui/badge';
import { PromptBar } from './PromptBar';
import { ControlBar } from './ControlBar';
import { FrameUpload } from './FrameUpload';

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
  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const presetsHook = useStudioPresets();
  const { fetchGenerations, generations } = generationHook;
  const { fetchProducts, products } = productsHook;
  const { fetchPersonas, personas } = personasHook;
  const { fetchPresets, presets } = presetsHook;
  const [mode, setMode] = useState<StudioGenerationMode>('image');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [count, setCount] = useState(4);
  const [rawPrompt, setRawPrompt] = useState('');
  const [productRefs, setProductRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [personaRefs, setPersonaRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [presetRef, setPresetRef] = useState<StudioPreset | null>(null);
  const [negativePrompt, setNegativePrompt] = useState('');
  const [extraReferenceUrls, setExtraReferenceUrls] = useState<string[]>([]);
  const [startFrame, setStartFrame] = useState<File | null>(null);
  const [endFrame, setEndFrame] = useState<File | null>(null);
  const [selectedGeneration, setSelectedGeneration] = useState<StudioGeneration | null>(null);
  const [selectedOutput, setSelectedOutput] = useState<StudioGenerationOutput | null>(null);

  useEffect(() => {
    void fetchGenerations();
    void fetchProducts();
    void fetchPersonas();
    void fetchPresets();
  }, [fetchGenerations, fetchProducts, fetchPersonas, fetchPresets]);

  const canGenerate = useMemo(() => {
    return rawPrompt.trim().length > 0 || productRefs.length > 0 || personaRefs.length > 0 || presetRef !== null;
  }, [personaRefs.length, presetRef, productRefs.length, rawPrompt]);

  useEffect(() => {
    if (!selectedGeneration || !selectedOutput) {
      return;
    }

    const nextGeneration = generations.find((generation) => generation.id === selectedGeneration.id);
    const nextOutput = nextGeneration?.outputs.find((output) => output.id === selectedOutput.id) ?? null;

    if (!nextGeneration || !nextOutput) {
      setSelectedGeneration(null);
      setSelectedOutput(null);
      return;
    }

    if (nextGeneration !== selectedGeneration) {
      setSelectedGeneration(nextGeneration);
    }

    if (nextOutput !== selectedOutput) {
      setSelectedOutput(nextOutput);
    }
  }, [generations, selectedGeneration, selectedOutput]);

  const handleGenerate = async () => {
    const prompt = negativePrompt.trim()
      ? `${rawPrompt.trim()}\n\nAvoid: ${negativePrompt.trim()}`
      : rawPrompt.trim();

    const result = await generationHook.generate({
      prompt,
      mode,
      product_ids: productRefs.map((product) => product.id),
      persona_ids: personaRefs.map((persona) => persona.id),
      preset_id: presetRef?.id,
      aspect_ratio: aspectRatio,
      count: mode === 'video' ? 1 : count,
      provider: 'gemini',
    });

    if (result) {
      setRawPrompt('');
      setNegativePrompt('');
      setExtraReferenceUrls([]);
      setStartFrame(null);
      setEndFrame(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.12),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.12),_transparent_32%)]">
            <OutputGrid
              generations={generations}
              emptyState={<EmptyState />}
              onOutputOpen={({ generation, output }) => {
                setSelectedGeneration(generation);
                setSelectedOutput(output);
              }}
            />
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-border/80 bg-background/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
          {mode === 'video' ? (
            <FrameUpload
              startFrame={startFrame}
              endFrame={endFrame}
              onStartFrameChange={setStartFrame}
              onEndFrameChange={setEndFrame}
            />
          ) : null}

          <PromptBar
            value={{
              rawPrompt,
              productRefs,
              personaRefs,
              presetRef,
              negativePrompt,
              extraReferenceUrls,
            }}
            products={products}
            personas={personas}
            presets={presets}
            onRawPromptChange={setRawPrompt}
            onProductAdd={(product) => {
              setProductRefs((current) =>
                current.some((item) => item.id === product.id)
                  ? current
                  : [...current, { id: product.id, name: product.name }],
              );
            }}
            onPersonaAdd={(persona) => {
              setPersonaRefs((current) =>
                current.some((item) => item.id === persona.id)
                  ? current
                  : [...current, { id: persona.id, name: persona.name }],
              );
            }}
            onPresetSelect={setPresetRef}
            onReferenceRemove={(type, id) => {
              if (type === 'product') {
                setProductRefs((current) => current.filter((item) => item.id !== id));
                return;
              }
              if (type === 'persona') {
                setPersonaRefs((current) => current.filter((item) => item.id !== id));
                return;
              }
              setPresetRef((current) => (current?.id === id ? null : current));
            }}
            onNegativePromptChange={setNegativePrompt}
            onExtraReferenceUrlAdd={(url) => {
              setExtraReferenceUrls((current) => (current.includes(url) ? current : [...current, url]));
            }}
            onExtraReferenceUrlRemove={(url) => {
              setExtraReferenceUrls((current) => current.filter((item) => item !== url));
            }}
          />

          <ControlBar
            mode={mode}
            onModeChange={(nextMode) => {
              setMode(nextMode);
              setCount(nextMode === 'video' ? 1 : 4);
            }}
            presets={presets}
            selectedPreset={presetRef}
            onPresetChange={setPresetRef}
            aspectRatio={aspectRatio}
            onAspectRatioChange={setAspectRatio}
            count={count}
            onCountChange={setCount}
            onGenerate={handleGenerate}
            isGenerating={generationHook.loading}
            canGenerate={canGenerate}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-full px-3 py-1">
              {mode === 'video' ? 'Video mode' : 'Image mode'}
            </Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Presets: {presets.length}</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Products: {products.length}</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Personas: {personas.length}</Badge>
            <Badge variant="outline" className="rounded-full px-3 py-1">Recent generations: {generations.length}</Badge>
            {generationHook.error ? (
              <Badge variant="outline" className="rounded-full border-red-500/40 text-red-700 dark:text-red-300">
                {generationHook.error}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <OutputDetailView
        generation={selectedGeneration}
        output={selectedOutput}
        open={selectedGeneration !== null && selectedOutput !== null}
        onClose={() => {
          setSelectedGeneration(null);
          setSelectedOutput(null);
        }}
      />
    </div>
  );
}
